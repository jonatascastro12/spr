import { DirtyWorktreeError } from "./errors";
import { runCmd } from "./shell";
import type { Worktree } from "../types";

export async function repoRoot(cwd = process.cwd()): Promise<string> {
  return runCmd(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
}

export async function gitCommonDir(cwd = process.cwd()): Promise<string> {
  return runCmd(["git", "-C", cwd, "rev-parse", "--git-common-dir"]);
}

export async function currentBranch(cwd = process.cwd()): Promise<string> {
  return runCmd(["git", "-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"]);
}

export async function defaultBranch(cwd = process.cwd()): Promise<string> {
  const out = await runCmd(
    ["git", "-C", cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { allowFailure: true }
  );
  if (out.startsWith("origin/")) {
    return out.slice("origin/".length);
  }
  return "main";
}

export async function listWorktrees(cwd = process.cwd()): Promise<Worktree[]> {
  const output = await runCmd(["git", "-C", cwd, "worktree", "list", "--porcelain"]);
  const blocks = output
    .split("\n\n")
    .map((b) => b.trim())
    .filter(Boolean);

  const worktrees: Worktree[] = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    const wtPath = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    const headSha = lines.find((l) => l.startsWith("HEAD "))?.slice("HEAD ".length);
    const rawBranch = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length);

    if (!wtPath || !headSha || !rawBranch) {
      continue;
    }
    if (!rawBranch.startsWith("refs/heads/")) {
      continue;
    }

    worktrees.push({
      path: wtPath,
      headSha,
      branch: rawBranch.slice("refs/heads/".length),
    });
  }

  return worktrees;
}

export async function assertClean(worktreePaths: string[]): Promise<void> {
  for (const wtPath of worktreePaths) {
    const status = await runCmd(["git", "-C", wtPath, "status", "--porcelain"]);
    if (status.trim().length > 0) {
      throw new DirtyWorktreeError(wtPath);
    }
  }
}

export async function createBranch(
  repoRootPath: string,
  branch: string,
  fromBranch: string,
  worktreePath?: string
): Promise<void> {
  if (worktreePath) {
    await runCmd([
      "git",
      "-C",
      repoRootPath,
      "worktree",
      "add",
      "-b",
      branch,
      worktreePath,
      fromBranch,
    ]);
    return;
  }

  await runCmd(["git", "-C", repoRootPath, "checkout", fromBranch]);
  await runCmd(["git", "-C", repoRootPath, "checkout", "-b", branch]);
}

export async function fetch(worktreePath: string, remote = "origin"): Promise<void> {
  await runCmd(["git", "-C", worktreePath, "fetch", remote]);
}

export async function rebaseOnto(worktreePath: string, ontoBranch: string): Promise<void> {
  await runCmd(["git", "-C", worktreePath, "rebase", ontoBranch]);
}

export async function pushLease(
  worktreePath: string,
  remote: string,
  branch: string
): Promise<void> {
  await runCmd(["git", "-C", worktreePath, "push", "--force-with-lease", remote, branch]);
}

export async function pushBranch(
  worktreePath: string,
  remote: string,
  branch: string
): Promise<void> {
  await runCmd(["git", "-C", worktreePath, "push", "-u", remote, branch]);
}
