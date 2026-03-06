import * as gh from "../lib/gh";
import * as git from "../lib/git";
import * as metaStore from "../lib/meta";
import { discoverPlan } from "../lib/plan";
import {
  askYesNo,
  applyPrBaseUpdates,
  createMissingPrs,
  findMissingPrs,
  findPrBaseUpdates,
  updateBranchStackDescriptionSafe,
  updateStackDescriptionsSafe,
} from "../lib/pr-ops";
import * as stateStore from "../lib/state";
import * as ui from "../lib/ui";
import { ConflictError, GwError } from "../lib/errors";

export type SyncOptions = {
  dryRun?: boolean;
  resume?: boolean;
  fromBranch?: string;
  yes?: boolean;
};

type AutoStash = {
  entries: Array<{
    worktreePath: string;
    stashRef: string;
  }>;
  restoreAfterSuccess: boolean;
};

export async function runSync(opts: SyncOptions): Promise<void> {
  if (opts.resume) {
    const repoRoot = await git.repoRoot();
    const commonDir = await git.gitCommonDir(repoRoot);
    await runResume(repoRoot, commonDir, opts.yes);
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
  const localBranches = new Set((await git.listWorktrees(repoRoot)).map((wt) => wt.branch));
  const planningFromBranch = await pickPlanningFromBranch(
    fromBranch,
    mergedResolution,
    effectiveParentByBranch,
    localBranches
  );
  if (planningFromBranch !== fromBranch) {
    ui.printStep(
      `Using ${planningFromBranch} for planning because ${fromBranch} is already merged.`
    );
  }

  const { graph, plan, parentByBranch } = await discoverPlan({
    fromBranch: planningFromBranch,
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
  const baseUpdates = await findPrBaseUpdates(stackBranchesForPrs, parentByBranch, repoRoot);
  if (baseUpdates.length > 0) {
    const prefix = opts.dryRun ? "Dry-run: " : "";
    ui.printStep(
      `${prefix}updating ${baseUpdates.length} PR base branch(es) to match current stack parents.`
    );
    for (const update of baseUpdates) {
      ui.printStep(
        `- ${update.branch} PR #${update.prNumber}: ${update.currentBase} -> ${update.expectedBase}`
      );
    }
  }
  const missingPrs = await findMissingPrs(stackBranchesForPrs);
  let shouldCreateMissingPrs = false;
  if (missingPrs.length > 0) {
    ui.printWarning(`Missing PRs for: ${missingPrs.map((branch) => ui.styleBranch(branch)).join(", ")}`);
    if (opts.dryRun) {
      ui.printInfo(ui.styleMuted("Dry-run: skipping PR creation and rebase execution."));
      return;
    }

    shouldCreateMissingPrs = await askYesNo("Create missing PRs now? [y/N] ", opts.yes);
    if (!shouldCreateMissingPrs) {
      ui.printWarning("Continuing sync without creating missing PRs.");
    }
  }

  if (opts.dryRun) {
    return;
  }

  const autoStash = await ensureCleanOrStash(
    worktreePathsForBranches(graph, plan.allBranches),
    "sync",
    opts.yes
  );
  await fastForwardRootFromOrigin(graph, plan.root);

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

  ui.printSyncHeader();
  const snapshotTimestamp = Date.now().toString();
  const worktrees = await git.listWorktrees(repoRoot);
  const wtByBranch = new Map(worktrees.map((wt) => [wt.branch, wt]));
  for (const branch of plan.allBranches) {
    const wt = wtByBranch.get(branch);
    if (wt) {
      await git.createBackupRef(repoRoot, branch, wt.headSha, snapshotTimestamp);
    }
  }

  let state = stateStore.makeInitialState(repoRoot, plan, false, { snapshotTimestamp });
  await stateStore.saveState(commonDir, state);

  for (const branch of plan.rebaseOrder) {
    const node = graph.get(branch);
    if (!node) {
      throw new GwError(`Missing graph node for branch: ${branch}`);
    }
    const parent = node.parent;
    if (!parent) {
      throw new GwError(`Branch ${branch} does not have a parent in the planned stack`);
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
      state = { ...state, failedAt: branch, failedWorktreePath: node.worktreePath, lastError: message };
      await stateStore.saveState(commonDir, state);
      throw new ConflictError(branch, node.worktreePath, message);
    }
  }

  if (baseUpdates.length > 0) {
    await applyPrBaseUpdates(baseUpdates);
  }

  if (shouldCreateMissingPrs) {
    await createMissingPrs(stackBranchesForPrs, missingPrs, parentByBranch, repoRoot, graph);
  }

  await stateStore.clearState(commonDir);
  await restoreAutoStashAfterSuccess(autoStash, "sync");
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
    const candidates = listMergedBranchCandidates(nextParents, fromBranch);
    let changed = false;

    for (const branch of candidates) {
      const grandParent = nextParents[branch];

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
        if (grandParent) {
          nextParents[child] = grandParent;
        } else {
          delete nextParents[child];
        }
        rewiredChildren.push({
          child,
          previousParent: branch,
          newParent: grandParent ?? detection.baseRef.replace(/^origin\//, ""),
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

function listMergedBranchCandidates(
  parentByBranch: Record<string, string>,
  startBranch: string
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  let cursor = startBranch;

  while (cursor.length > 0 && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = parentByBranch[cursor];
    if (!parent) {
      break;
    }
    candidates.push(cursor);
    cursor = parent;
  }

  // Include the stack root so we can detect if it was merged.
  // The root has no parent entry but is referenced as a parent by other branches.
  if (cursor.length > 0 && seen.has(cursor) && !parentByBranch[cursor]) {
    const isReferencedAsParent = Object.values(parentByBranch).some((p) => p === cursor);
    if (isReferencedAsParent) {
      candidates.push(cursor);
    }
  }

  return candidates;
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


async function ensureCleanOrStash(
  worktreePaths: string[],
  action: "sync" | "resume",
  autoYes = false
): Promise<AutoStash | undefined> {
  const dirtyPaths = await git.listDirtyWorktrees(worktreePaths);
  if (dirtyPaths.length === 0) {
    return undefined;
  }

  ui.printWarning("Found uncommitted changes in:");
  for (const path of dirtyPaths) {
    ui.printWarning(`- ${ui.stylePath(path)}`);
  }

  const shouldStash = await askYesNo(
    `Stash changes in these worktrees and continue ${action}? [y/N] `,
    autoYes
  );
  if (!shouldStash) {
    throw new GwError(
      `Sync stopped: dirty worktrees detected. Stash or commit changes, then run gw${action}.`
    );
  }

  const message = `gw auto-stash (${new Date().toISOString()})`;
  const entries: AutoStash["entries"] = [];
  for (const path of dirtyPaths) {
    const stashRef = await git.stashWorkingTree(path, message);
    entries.push({ worktreePath: path, stashRef });
    ui.printStep(`Stashed changes in ${path} (${stashRef})`);
  }

  const restoreAfterSuccess = await askYesNo(
    `Re-apply stashed changes automatically after successful ${action}? [y/N] `,
    autoYes
  );
  return { entries, restoreAfterSuccess };
}

async function runResume(repoRoot: string, commonDir: string, autoYes = false): Promise<void> {
  const existing = await stateStore.loadState(commonDir);
  if (!existing) {
    throw new GwError("No saved sync state found.");
  }
  if (existing.repoRoot !== repoRoot) {
    throw new GwError(
      `Saved state repo mismatch. Expected ${repoRoot}, found ${existing.repoRoot}`
    );
  }

  // If the failed branch still has an active rebase, tell the user to finish first
  if (existing.failedAt && existing.failedWorktreePath) {
    const rebaseActive = await git.isRebaseInProgress(existing.failedWorktreePath);
    if (rebaseActive) {
      throw new GwError(
        `A rebase is still in progress in ${existing.failedWorktreePath}.\n` +
          `Finish resolving conflicts and run: git -C ${existing.failedWorktreePath} rebase --continue\n` +
          `Or run: gw abort`
      );
    }
  }

  // Use a branch from state for discovery since cwd may be in detached HEAD during rebase
  const resumeFromBranch = existing.failedAt ?? existing.stackBranches[0];
  const discovery = await discoverPlan({ fromBranch: resumeFromBranch });
  const graph = discovery.graph;
  const stackBranchesForPrs = existing.stackBranches.filter(
    (branch) => !!discovery.parentByBranch[branch]
  );
  const autoStash = await ensureCleanOrStash(
    worktreePathsForBranches(graph, existing.stackBranches),
    "resume",
    autoYes
  );
  if (existing.completed.length === 0) {
    await fastForwardRootFromOrigin(graph, existing.rootBranch);
  }

  const done = new Set(existing.completed);
  let state = { ...existing };
  const isRestack = existing.command === "restack";

  for (const branch of existing.executionOrder) {
    if (done.has(branch)) {
      continue;
    }

    const node = graph.get(branch);
    if (!node || !node.parent) {
      throw new GwError(`Cannot resume: branch not found in current graph: ${branch}`);
    }

    // Check if a rebase is still in progress for this branch
    const rebaseActive = await git.isRebaseInProgress(node.worktreePath);
    if (rebaseActive) {
      throw new GwError(
        `A rebase is still in progress in ${node.worktreePath}.\n` +
          `Finish resolving conflicts and run: git -C ${node.worktreePath} rebase --continue\n` +
          `Or run: gw abort`
      );
    }

    try {
      ui.printStep(`Resuming ${branch} onto ${node.parent} (${node.worktreePath})`);
      await git.fetch(node.worktreePath, "origin");
      // If this was the failed branch and rebase is no longer active, user already completed it
      if (branch === existing.failedAt) {
        ui.printStep(`Rebase already completed for ${branch}, pushing...`);
      } else {
        await git.rebaseOnto(node.worktreePath, node.parent);
      }
      await git.pushLease(node.worktreePath, "origin", branch);
      if (!isRestack) {
        await updateBranchStackDescriptionSafe(stackBranchesForPrs, branch);
      }

      state = {
        ...state,
        completed: [...state.completed, branch],
        failedAt: undefined,
        failedWorktreePath: undefined,
        lastError: undefined,
      };
      await stateStore.saveState(commonDir, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state = { ...state, failedAt: branch, failedWorktreePath: node.worktreePath, lastError: message };
      await stateStore.saveState(commonDir, state);
      throw new ConflictError(branch, node.worktreePath, message);
    }
  }

  await stateStore.clearState(commonDir);
  await restoreAutoStashAfterSuccess(autoStash, "resume");
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
      throw new GwError(`Branch ${branch} is not available in current local worktrees.`);
    }
    paths.push(node.worktreePath);
  }
  return [...new Set(paths)].sort();
}

async function fastForwardRootFromOrigin(
  graph: Map<string, { worktreePath: string }>,
  rootBranch: string
): Promise<void> {
  const rootNode = graph.get(rootBranch);
  if (!rootNode) {
    throw new GwError(`Cannot update root branch: missing local worktree for ${rootBranch}`);
  }

  ui.printStep(`Fast-forwarding root ${rootBranch} from origin/${rootBranch} (${rootNode.worktreePath})`);
  try {
    await git.fetch(rootNode.worktreePath, "origin");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GwError(
      `Failed to fast-forward root branch ${rootBranch} in ${rootNode.worktreePath}. Resolve the root branch state and retry sync.\n${message}`
    );
  }

  const hasRemoteRoot = await git.remoteBranchExists(rootNode.worktreePath, "origin", rootBranch);
  if (!hasRemoteRoot) {
    ui.printStep(
      `Warning: skipping root fast-forward because origin/${rootBranch} does not exist (${rootNode.worktreePath}).`
    );
    return;
  }

  try {
    await git.fastForwardBranchFromRemote(rootNode.worktreePath, rootBranch, "origin");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GwError(
      `Failed to fast-forward root branch ${rootBranch} in ${rootNode.worktreePath}. Resolve the root branch state and retry sync.\n${message}`
    );
  }
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


async function restoreAutoStashAfterSuccess(
  autoStash: AutoStash | undefined,
  action: "sync" | "resume"
): Promise<void> {
  if (!autoStash || !autoStash.restoreAfterSuccess || autoStash.entries.length === 0) {
    return;
  }

  ui.printStep(`Restoring stashed changes after successful ${action}...`);
  for (const entry of autoStash.entries) {
    try {
      await git.popStash(entry.worktreePath, entry.stashRef);
      ui.printStep(`Restored ${entry.stashRef} in ${entry.worktreePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ui.printStep(
        `Warning: failed to restore ${entry.stashRef} in ${entry.worktreePath}: ${message}`
      );
    }
  }
}

async function pickPlanningFromBranch(
  requestedFromBranch: string,
  mergedResolution: MergedParentResolution,
  parentByBranch: Record<string, string>,
  localBranches: Set<string>
): Promise<string> {
  const removed = new Set(mergedResolution.mergedBranches.map((branch) => branch.branch));
  if (!removed.has(requestedFromBranch)) {
    const hasParent = Boolean(parentByBranch[requestedFromBranch]);
    const hasChildren = Object.values(parentByBranch).some((parent) => parent === requestedFromBranch);
    if (hasParent || hasChildren) {
      return requestedFromBranch;
    }

    const openChildren = await gh.listOpenPrsByBase(requestedFromBranch);
    for (const childPr of openChildren) {
      if (localBranches.has(childPr.headRefName)) {
        return childPr.headRefName;
      }
    }
    return requestedFromBranch;
  }

  const candidates = mergedResolution.rewiredChildren
    .filter((rewire) => rewire.previousParent === requestedFromBranch)
    .map((rewire) => rewire.child)
    .filter((branch, idx, all) => all.indexOf(branch) === idx)
    .sort((a, b) => a.localeCompare(b));

  for (const candidate of candidates) {
    if (localBranches.has(candidate)) {
      return candidate;
    }
  }

  return requestedFromBranch;
}
