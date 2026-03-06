import * as git from "../lib/git";
import * as stateStore from "../lib/state";
import { askYesNo } from "../lib/pr-ops";
import * as ui from "../lib/ui";
import { GwError } from "../lib/errors";

export type AbortOptions = {
  rollback?: boolean;
  yes?: boolean;
};

export async function runAbort(opts: AbortOptions): Promise<void> {
  const repoRoot = await git.repoRoot();
  const commonDir = await git.gitCommonDir(repoRoot);
  const state = await stateStore.loadState(commonDir);

  if (!state) {
    throw new GwError("No saved sync state found. Nothing to abort.");
  }

  // Abort active rebase if one exists
  if (state.failedAt) {
    const worktreePath = state.failedWorktreePath ?? findWorktreePath(state, state.failedAt);
    if (worktreePath) {
      const rebaseActive = await git.isRebaseInProgress(worktreePath);
      if (rebaseActive) {
        ui.printStep(`Aborting active rebase in ${worktreePath}`);
        await git.rebaseAbort(worktreePath);
      }
    }
  }

  // Rollback completed branches if requested
  if (opts.rollback && state.snapshotTimestamp) {
    const backupRefs = await git.listBackupRefs(repoRoot, {
      timestamp: undefined,
    });
    const snapshotRefs = backupRefs.filter((ref) => ref.timestamp === state.snapshotTimestamp);

    if (snapshotRefs.length > 0) {
      const branchesToRollback = [...state.completed];
      if (state.failedAt) {
        branchesToRollback.push(state.failedAt);
      }

      // Find worktree paths for branches to roll back
      const worktrees = await git.listWorktrees(repoRoot);
      const wtByBranch = new Map(worktrees.map((wt) => [wt.branch, wt.path]));

      // Check for dirty worktrees
      const rollbackPaths = branchesToRollback
        .map((b) => wtByBranch.get(b))
        .filter(Boolean) as string[];
      const dirtyPaths = await git.listDirtyWorktrees(rollbackPaths);

      if (dirtyPaths.length > 0) {
        ui.printWarning("Dirty worktrees detected:");
        for (const p of dirtyPaths) {
          ui.printWarning(`- ${ui.stylePath(p)}`);
        }
        const proceed = await askYesNo(
          "Continue rollback anyway? Uncommitted changes may be lost. [y/N] ",
          opts.yes
        );
        if (!proceed) {
          ui.printStep("Skipping rollback. Clearing sync state only.");
          await stateStore.clearState(commonDir);
          ui.printStep("Sync aborted (branches not rolled back).");
          return;
        }
      }

      let rolledBack = 0;
      for (const ref of snapshotRefs) {
        const wtPath = wtByBranch.get(ref.branch);
        if (!wtPath || !branchesToRollback.includes(ref.branch)) {
          continue;
        }
        ui.printStep(`Rolling back ${ref.branch} to ${ref.sha.slice(0, 8)}`);
        await git.resetHard(wtPath, ref.sha);
        try {
          await git.pushLease(wtPath, "origin", ref.branch);
        } catch {
          ui.printStep(`Warning: failed to push rollback for ${ref.branch} to origin`);
        }
        rolledBack++;
      }

      // Clean up backup refs for this snapshot
      for (const ref of snapshotRefs) {
        await git.deleteBackupRef(repoRoot, ref.refPath);
      }

      await stateStore.clearState(commonDir);
      ui.printStep(`Sync aborted and ${rolledBack} branch(es) rolled back.`);
      return;
    }
  }

  // Clean up any backup refs for this snapshot
  if (state.snapshotTimestamp) {
    const allRefs = await git.listBackupRefs(repoRoot);
    const snapshotRefs = allRefs.filter((ref) => ref.timestamp === state.snapshotTimestamp);
    for (const ref of snapshotRefs) {
      await git.deleteBackupRef(repoRoot, ref.refPath);
    }
  }

  await stateStore.clearState(commonDir);
  ui.printStep("Sync aborted.");
}

function findWorktreePath(
  state: { stackBranches: string[]; failedWorktreePath?: string },
  branch: string
): string | undefined {
  return state.failedWorktreePath;
}
