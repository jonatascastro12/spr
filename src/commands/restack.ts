import * as git from "../lib/git";
import { discoverPlan } from "../lib/plan";
import { askYesNo } from "../lib/pr-ops";
import * as stateStore from "../lib/state";
import { collectDescendants } from "../lib/stack";
import * as ui from "../lib/ui";
import { ConflictError, GwError } from "../lib/errors";

export type RestackOptions = {
  dryRun?: boolean;
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

export async function runRestack(opts: RestackOptions): Promise<void> {
  const { graph, plan, fromBranch } = await discoverPlan({ fromBranch: opts.fromBranch });
  ui.printPlan(plan);

  const descendants = collectDescendants(graph, fromBranch);
  const executionOrder = plan.rebaseOrder.filter((branch) => descendants.has(branch));
  ui.printInfo(`${ui.styleLabel("Restack base:")} ${ui.styleBranch(fromBranch, "current")}`);

  if (executionOrder.length === 0) {
    ui.printStep(`No child branches to restack from ${fromBranch}.`);
    return;
  }

  ui.printStep("Restack execution order:");
  for (const branch of executionOrder) {
    ui.printStep(`- ${branch}`);
  }

  if (opts.dryRun) {
    return;
  }

  const involvedBranches = [fromBranch, ...executionOrder];
  const autoStash = await ensureCleanOrStash(worktreePathsForBranches(graph, involvedBranches), opts.yes);

  const repoRoot = await git.repoRoot();
  const commonDir = await git.gitCommonDir(repoRoot);

  // Create backup refs
  const snapshotTimestamp = Date.now().toString();
  const worktrees = await git.listWorktrees(repoRoot);
  const wtByBranch = new Map(worktrees.map((wt) => [wt.branch, wt]));
  for (const branch of involvedBranches) {
    const wt = wtByBranch.get(branch);
    if (wt) {
      await git.createBackupRef(repoRoot, branch, wt.headSha, snapshotTimestamp);
    }
  }

  // Save initial state
  let state = stateStore.makeInitialState(
    repoRoot,
    { root: plan.root, allBranches: involvedBranches, rebaseOrder: executionOrder },
    false,
    { command: "restack", snapshotTimestamp }
  );
  await stateStore.saveState(commonDir, state);

  ui.printInfo(ui.styleBold("Restacking descendant branches..."));
  for (const branch of executionOrder) {
    const node = graph.get(branch);
    if (!node || !node.parent) {
      throw new GwError(`Cannot restack: missing parent/worktree for ${branch}`);
    }

    try {
      ui.printStep(`Rebasing ${branch} onto ${node.parent} (${node.worktreePath})`);
      await git.fetch(node.worktreePath, "origin");
      await git.rebaseOnto(node.worktreePath, node.parent);
      await git.pushLease(node.worktreePath, "origin", branch);

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
  await restoreAutoStashAfterSuccess(autoStash);
  ui.printStep("Restack complete.");
}

async function ensureCleanOrStash(worktreePaths: string[], autoYes = false): Promise<AutoStash | undefined> {
  const dirtyPaths = await git.listDirtyWorktrees(worktreePaths);
  if (dirtyPaths.length === 0) {
    return undefined;
  }

  ui.printWarning("Found uncommitted changes in:");
  for (const path of dirtyPaths) {
    ui.printWarning(`- ${ui.stylePath(path)}`);
  }

  const shouldStash = await askYesNo("Stash changes in these worktrees and continue restack? [y/N] ", autoYes);
  if (!shouldStash) {
    throw new GwError(
      "Restack stopped: dirty worktrees detected. Stash or commit changes, then run gw restack."
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
    "Re-apply stashed changes automatically after successful restack? [y/N] ",
    autoYes
  );
  return { entries, restoreAfterSuccess };
}

async function restoreAutoStashAfterSuccess(autoStash: AutoStash | undefined): Promise<void> {
  if (!autoStash || !autoStash.restoreAfterSuccess || autoStash.entries.length === 0) {
    return;
  }

  ui.printStep("Restoring stashed changes after successful restack...");
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
