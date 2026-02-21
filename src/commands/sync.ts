import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as gh from "../lib/gh";
import * as git from "../lib/git";
import { discoverPlan } from "../lib/plan";
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

  const { repoRoot, commonDir, graph, plan, parentByBranch } = await discoverPlan({
    fromBranch: opts.fromBranch,
  });
  await git.assertClean([...graph.values()].map((node) => node.worktreePath));

  ui.printPlan(plan);

  const stackBranchesForPrs = plan.allBranches.filter((branch) => parentByBranch[branch]);
  const missingPrs = await findMissingPrs(stackBranchesForPrs);
  if (missingPrs.length > 0) {
    console.log(`Missing PRs for: ${missingPrs.join(", ")}`);
    if (opts.dryRun) {
      console.log("Dry-run: skipping PR creation and rebase execution.");
      return;
    }

    const shouldCreate = await askYesNo("Create missing PRs now? [y/N] ");
    if (shouldCreate) {
      await createMissingPrs(plan.allBranches, missingPrs, parentByBranch, repoRoot, graph);
    } else {
      throw new SprError("Sync stopped: missing PRs. Re-run sync and create PRs when prompted.");
    }
  }

  if (opts.dryRun) {
    return;
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

async function findMissingPrs(branches: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const branch of branches) {
    const pr = await gh.viewPrByBranchOptional(branch);
    if (!pr) {
      missing.push(branch);
    }
  }
  return missing;
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
    console.log(`Pushing ${branch} to origin`);
    await git.pushBranch(node.worktreePath, "origin", branch);
    console.log(`Creating PR for ${branch} -> ${base}`);
    await gh.createPr(branch, base);
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
  await git.assertClean([...graph.values()].map((node) => node.worktreePath));

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
