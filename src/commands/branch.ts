import { resolve } from "node:path";
import * as git from "../lib/git";
import * as metaStore from "../lib/meta";
import * as config from "../lib/config";
import * as ui from "../lib/ui";

export async function runBranch(opts: {
  name: string;
  fromBranch?: string;
  worktreePath?: string;
  noWorktree?: boolean;
}): Promise<void> {
  const repoRoot = await git.repoRoot();
  const commonDir = await git.gitCommonDir(repoRoot);
  const fromBranch = opts.fromBranch ?? (await git.currentBranch());

  let worktreePath = opts.worktreePath;

  if (!worktreePath && !opts.noWorktree) {
    const repoId = await git.repoIdentifier().catch(() => undefined);
    if (repoId) {
      const worktreeRoot = await config.getRepoWorktreeRoot(repoId);
      if (worktreeRoot) {
        worktreePath = resolve(worktreeRoot, git.sanitizeBranchForPath(opts.name));
      } else {
        ui.printInfo(ui.styleMuted("Tip: run `gw init` to configure automatic worktree creation."));
      }
    }
  }

  await git.createBranch(repoRoot, opts.name, fromBranch, worktreePath);
  await metaStore.setParent(commonDir, opts.name, fromBranch);

  if (worktreePath) {
    ui.printSuccess(
      `Created branch ${ui.styleBranch(opts.name)} from ${ui.styleBranch(fromBranch)} in worktree ${ui.stylePath(worktreePath)}`
    );
    return;
  }

  ui.printSuccess(`Created branch ${ui.styleBranch(opts.name)} from ${ui.styleBranch(fromBranch)}`);
}
