import * as git from "../lib/git";
import * as metaStore from "../lib/meta";
import * as ui from "../lib/ui";

export async function runBranch(opts: {
  name: string;
  fromBranch?: string;
  worktreePath?: string;
}): Promise<void> {
  const repoRoot = await git.repoRoot();
  const commonDir = await git.gitCommonDir(repoRoot);
  const fromBranch = opts.fromBranch ?? (await git.currentBranch());

  await git.createBranch(repoRoot, opts.name, fromBranch, opts.worktreePath);
  await metaStore.setParent(commonDir, opts.name, fromBranch);

  if (opts.worktreePath) {
    ui.printSuccess(
      `Created branch ${ui.styleBranch(opts.name)} from ${ui.styleBranch(fromBranch)} in worktree ${ui.stylePath(opts.worktreePath)}`
    );
    return;
  }

  ui.printSuccess(`Created branch ${ui.styleBranch(opts.name)} from ${ui.styleBranch(fromBranch)}`);
}
