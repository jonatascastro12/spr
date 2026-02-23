import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as gh from "../lib/gh";
import * as git from "../lib/git";
import * as metaStore from "../lib/meta";
import { discoverPlan } from "../lib/plan";
import * as prStack from "../lib/prStack";
import * as stateStore from "../lib/state";
import * as ui from "../lib/ui";
import { ConflictError, SprError } from "../lib/errors";

export type SyncOptions = {
  dryRun?: boolean;
  resume?: boolean;
  fromBranch?: string;
};

export async function runSync(opts: SyncOptions): Promise<void> {
  if (opts.resume) {
    const repoRoot = await git.repoRoot();
    const commonDir = await git.gitCommonDir(repoRoot);
    await runResume(repoRoot, commonDir);
    return;
  }

  const repoRoot = await git.repoRoot();
  const commonDir = await git.gitCommonDir(repoRoot);
  const fromBranch = opts.fromBranch ?? (await git.currentBranch(repoRoot));
  if (!opts.dryRun) {
    await git.fetch(repoRoot, "origin");
  }

  const meta = await metaStore.loadMeta(commonDir);
  const inferredParents = await inferMissingParentsFromPrs(commonDir, fromBranch);
  const inferredParentByBranch = sortRecord(Object.fromEntries(inferredParents));
  const inferredParentCount = Object.keys(inferredParentByBranch).length;
  const parentByBranchForDetection = {
    ...meta.parentByBranch,
    ...inferredParentByBranch,
  };
  const mergedResolution = await resolveMergedParentsInStack(
    repoRoot,
    fromBranch,
    parentByBranchForDetection
  );
  const effectiveParentByBranch = sortRecord(mergedResolution.parentByBranch);
  const metadataChanged = !recordsEqual(meta.parentByBranch, effectiveParentByBranch);

  const { graph, plan, parentByBranch } = await discoverPlan({
    fromBranch,
    parentByBranchReplace: effectiveParentByBranch,
  });
  ui.printPlan(plan);
  if (inferredParentCount > 0 && opts.dryRun) {
    ui.printStep(
      `Dry-run: inferred ${inferredParentCount} parent link(s) from PR metadata (not persisted).`
    );
    for (const [child, parent] of Object.entries(inferredParentByBranch)) {
      ui.printStep(`- inferred ${child} -> ${parent}`);
    }
  }
  if (mergedResolution.mergedBranches.length > 0) {
    const prefix = opts.dryRun ? "Dry-run: " : "";
    ui.printStep(
      `${prefix}detected ${mergedResolution.mergedBranches.length} merged parent branch(es); stack parent links will be updated.`
    );
    for (const merged of mergedResolution.mergedBranches) {
      ui.printStep(
        `- removed ${merged.branch} from stack (PR #${merged.prNumber} closed but merged into ${merged.baseRef})`
      );
    }
    for (const rewrite of mergedResolution.rewiredChildren) {
      ui.printStep(
        `- reparented ${rewrite.child} -> ${rewrite.newParent} (was: ${rewrite.previousParent})`
      );
    }
  }

  const stackBranchesForPrs = plan.allBranches.filter((branch) => parentByBranch[branch]);
  const missingPrs = await findMissingPrs(stackBranchesForPrs);
  let shouldCreateMissingPrs = false;
  if (missingPrs.length > 0) {
    ui.printWarning(`Missing PRs for: ${missingPrs.map((branch) => ui.styleBranch(branch)).join(", ")}`);
    if (opts.dryRun) {
      ui.printInfo(ui.styleMuted("Dry-run: skipping PR creation and rebase execution."));
      return;
    }

    shouldCreateMissingPrs = await askYesNo("Create missing PRs now? [y/N] ");
    if (!shouldCreateMissingPrs) {
      throw new SprError("Sync stopped: missing PRs. Re-run sync and create PRs when prompted.");
    }
  }

  if (opts.dryRun) {
    return;
  }

  await ensureCleanOrStash(worktreePathsForBranches(graph, plan.allBranches), "sync");

  if (metadataChanged) {
    await metaStore.saveMeta(commonDir, {
      version: meta.version,
      parentByBranch: effectiveParentByBranch,
    });
  }
  if (inferredParentCount > 0) {
    ui.printStep(`Auto-linked ${inferredParentCount} parent link(s) from PR metadata.`);
    for (const [child, parent] of Object.entries(inferredParentByBranch)) {
      ui.printStep(`- linked ${child} -> ${parent}`);
    }
  }

  if (shouldCreateMissingPrs) {
    await createMissingPrs(stackBranchesForPrs, missingPrs, parentByBranch, repoRoot, graph);
  }

  ui.printSyncHeader();
  let state = stateStore.makeInitialState(repoRoot, plan, false);
  await stateStore.saveState(commonDir, state);

  for (const branch of plan.rebaseOrder) {
    const node = graph.get(branch);
    if (!node) {
      throw new SprError(`Missing graph node for branch: ${branch}`);
    }
    const parent = node.parent;
    if (!parent) {
      throw new SprError(`Branch ${branch} does not have a parent in the planned stack`);
    }

    try {
      ui.printStep(`Rebasing ${branch} onto ${parent} (${node.worktreePath})`);
      await git.fetch(node.worktreePath, "origin");
      await git.rebaseOnto(node.worktreePath, parent);
      await git.pushLease(node.worktreePath, "origin", branch);
      await updateBranchStackDescriptionSafe(stackBranchesForPrs, branch);

      state = {
        ...state,
        completed: [...state.completed, branch],
        failedAt: undefined,
        lastError: undefined,
      };
      await stateStore.saveState(commonDir, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state = { ...state, failedAt: branch, lastError: message };
      await stateStore.saveState(commonDir, state);
      throw new ConflictError(branch, node.worktreePath, message);
    }
  }

  await stateStore.clearState(commonDir);
  ui.printStep("Sync complete.");
}

async function inferMissingParentsFromPrs(
  commonDir: string,
  fromBranch: string
): Promise<Map<string, string>> {
  const meta = await metaStore.loadMeta(commonDir);
  const inferred = new Map<string, string>();
  const seen = new Set<string>();
  let cursor = fromBranch;

  while (cursor.length > 0 && !seen.has(cursor)) {
    seen.add(cursor);

    const existingParent = meta.parentByBranch[cursor] ?? inferred.get(cursor);
    if (existingParent) {
      cursor = existingParent;
      continue;
    }

    const pr = await gh.viewOpenPrByHeadBranch(cursor);
    if (!pr) {
      break;
    }

    inferred.set(cursor, pr.baseRefName);
    cursor = pr.baseRefName;
  }

  return inferred;
}

async function findMissingPrs(branches: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const branch of branches) {
    const pr = await gh.viewOpenPrByHeadBranch(branch);
    if (!pr) {
      missing.push(branch);
    }
  }
  return missing;
}

type MergedParentResolution = {
  parentByBranch: Record<string, string>;
  mergedBranches: Array<{
    branch: string;
    prNumber: number;
    baseRef: string;
  }>;
  rewiredChildren: Array<{
    child: string;
    previousParent: string;
    newParent: string;
  }>;
};

type MergedBranchDetection =
  | { merged: false }
  | { merged: true; prNumber: number; baseRef: string };

async function resolveMergedParentsInStack(
  repoRoot: string,
  fromBranch: string,
  parentByBranch: Record<string, string>
): Promise<MergedParentResolution> {
  const nextParents = { ...parentByBranch };
  const mergedBranches: MergedParentResolution["mergedBranches"] = [];
  const rewiredChildren: MergedParentResolution["rewiredChildren"] = [];
  const detectionByBranch = new Map<string, MergedBranchDetection>();

  while (true) {
    const ancestors = listAncestorBranches(nextParents, fromBranch);
    let changed = false;

    for (const branch of ancestors) {
      const grandParent = nextParents[branch];
      if (!grandParent) {
        continue;
      }

      let detection = detectionByBranch.get(branch);
      if (!detection) {
        detection = await detectMergedBranch(repoRoot, branch);
        detectionByBranch.set(branch, detection);
      }
      if (!detection.merged) {
        continue;
      }

      const children = Object.entries(nextParents)
        .filter(([, parent]) => parent === branch)
        .map(([child]) => child)
        .sort();

      for (const child of children) {
        nextParents[child] = grandParent;
        rewiredChildren.push({
          child,
          previousParent: branch,
          newParent: grandParent,
        });
      }

      delete nextParents[branch];
      mergedBranches.push({
        branch,
        prNumber: detection.prNumber,
        baseRef: detection.baseRef,
      });
      changed = true;
      break;
    }

    if (!changed) {
      break;
    }
  }

  return {
    parentByBranch: nextParents,
    mergedBranches,
    rewiredChildren,
  };
}

function listAncestorBranches(parentByBranch: Record<string, string>, startBranch: string): string[] {
  const ancestors: string[] = [];
  const seen = new Set<string>([startBranch]);
  let cursor = startBranch;

  while (cursor.length > 0) {
    const parent = parentByBranch[cursor];
    if (!parent || seen.has(parent)) {
      break;
    }
    ancestors.push(parent);
    seen.add(parent);
    cursor = parent;
  }

  return ancestors;
}

async function detectMergedBranch(repoRoot: string, branch: string): Promise<MergedBranchDetection> {
  const pr = await gh.viewLatestPrByHeadBranch(branch);
  if (!pr) {
    return { merged: false };
  }

  const baseRef = `origin/${pr.baseRefName}`;
  if (pr.state === "MERGED" || pr.mergedAt) {
    return { merged: true, prNumber: pr.number, baseRef };
  }
  if (pr.state !== "CLOSED") {
    return { merged: false };
  }

  if (pr.headRefOid) {
    const headMerged = await git.isAncestorCommit(repoRoot, pr.headRefOid, baseRef);
    if (headMerged) {
      return { merged: true, prNumber: pr.number, baseRef };
    }
  }

  const prMergedByCommitMessage = await git.branchHasCommitMessageFragment(
    repoRoot,
    baseRef,
    `(#${pr.number})`
  );
  if (prMergedByCommitMessage) {
    return { merged: true, prNumber: pr.number, baseRef };
  }

  return { merged: false };
}

async function createMissingPrs(
  stackBranches: string[],
  missingPrs: string[],
  parentByBranch: Record<string, string>,
  repoRoot: string,
  graph: Map<string, { worktreePath: string }>
): Promise<void> {
  const missingSet = new Set(missingPrs);
  const fallbackBase = await git.defaultBranch(repoRoot);

  for (const branch of stackBranches) {
    if (!missingSet.has(branch)) {
      continue;
    }
    const base = parentByBranch[branch] ?? fallbackBase;
    const node = graph.get(branch);
    if (!node) {
      throw new SprError(`Cannot create PR: missing worktree for branch ${branch}`);
    }
    ui.printInfo(`Pushing ${ui.styleBranch(branch)} to origin`);
    await git.pushBranch(node.worktreePath, "origin", branch);
    ui.printInfo(`Creating PR for ${ui.styleBranch(branch)} -> ${ui.styleBranch(base)}`);
    await gh.createPr(branch, base);
    await updateStackDescriptionsSafe(stackBranches);
  }
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function ensureCleanOrStash(worktreePaths: string[], action: "sync" | "resume"): Promise<void> {
  const dirtyPaths = await git.listDirtyWorktrees(worktreePaths);
  if (dirtyPaths.length === 0) {
    return;
  }

  ui.printWarning("Found uncommitted changes in:");
  for (const path of dirtyPaths) {
    ui.printWarning(`- ${ui.stylePath(path)}`);
  }

  const shouldStash = await askYesNo(
    `Stash changes in these worktrees and continue ${action}? [y/N] `
  );
  if (!shouldStash) {
    throw new SprError(
      `Sync stopped: dirty worktrees detected. Stash or commit changes, then run spr ${action}.`
    );
  }

  const message = `spr auto-stash (${new Date().toISOString()})`;
  for (const path of dirtyPaths) {
    await git.stashWorkingTree(path, message);
    ui.printStep(`Stashed changes in ${path}`);
  }
}

async function runResume(repoRoot: string, commonDir: string): Promise<void> {
  const existing = await stateStore.loadState(commonDir);
  if (!existing) {
    throw new SprError("No saved sync state found.");
  }
  if (existing.repoRoot !== repoRoot) {
    throw new SprError(
      `Saved state repo mismatch. Expected ${repoRoot}, found ${existing.repoRoot}`
    );
  }

  const discovery = await discoverPlan();
  const graph = discovery.graph;
  const stackBranchesForPrs = existing.stackBranches.filter(
    (branch) => !!discovery.parentByBranch[branch]
  );
  await ensureCleanOrStash(worktreePathsForBranches(graph, existing.stackBranches), "resume");

  const done = new Set(existing.completed);
  let state = { ...existing };

  for (const branch of existing.executionOrder) {
    if (done.has(branch)) {
      continue;
    }

    const node = graph.get(branch);
    if (!node || !node.parent) {
      throw new SprError(`Cannot resume: branch not found in current graph: ${branch}`);
    }

    try {
      ui.printStep(`Resuming ${branch} onto ${node.parent} (${node.worktreePath})`);
      await git.fetch(node.worktreePath, "origin");
      await git.rebaseOnto(node.worktreePath, node.parent);
      await git.pushLease(node.worktreePath, "origin", branch);
      await updateBranchStackDescriptionSafe(stackBranchesForPrs, branch);

      state = {
        ...state,
        completed: [...state.completed, branch],
        failedAt: undefined,
        lastError: undefined,
      };
      await stateStore.saveState(commonDir, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state = { ...state, failedAt: branch, lastError: message };
      await stateStore.saveState(commonDir, state);
      throw new ConflictError(branch, node.worktreePath, message);
    }
  }

  await stateStore.clearState(commonDir);
  ui.printStep("Resume complete.");
}

function worktreePathsForBranches(
  graph: Map<string, { worktreePath: string }>,
  branches: string[]
): string[] {
  const paths: string[] = [];
  for (const branch of branches) {
    const node = graph.get(branch);
    if (!node) {
      throw new SprError(`Branch ${branch} is not available in current local worktrees.`);
    }
    paths.push(node.worktreePath);
  }
  return [...new Set(paths)].sort();
}

function sortRecord(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}

function recordsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aEntries = Object.entries(a).sort(([aKey], [bKey]) => aKey.localeCompare(bKey));
  const bEntries = Object.entries(b).sort(([aKey], [bKey]) => aKey.localeCompare(bKey));
  if (aEntries.length !== bEntries.length) {
    return false;
  }
  for (let i = 0; i < aEntries.length; i += 1) {
    if (aEntries[i][0] !== bEntries[i][0] || aEntries[i][1] !== bEntries[i][1]) {
      return false;
    }
  }
  return true;
}

async function updateStackDescriptionsSafe(stackBranches: string[]): Promise<void> {
  try {
    await prStack.refreshStackDescriptions(stackBranches);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.printStep(`Warning: failed to refresh stack descriptions: ${message}`);
  }
}

async function updateBranchStackDescriptionSafe(
  stackBranches: string[],
  branch: string
): Promise<void> {
  try {
    await prStack.refreshBranchStackDescription(stackBranches, branch);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.printStep(`Warning: failed to refresh PR description for ${branch}: ${message}`);
  }
}
