import { DirtyWorktreeError, GwError } from "./errors";
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
  const dirty = await listDirtyWorktrees(worktreePaths);
  if (dirty.length > 0) {
    throw new DirtyWorktreeError(dirty[0]);
  }
}

export async function listDirtyWorktrees(worktreePaths: string[]): Promise<string[]> {
  const dirty: string[] = [];
  for (const wtPath of [...new Set(worktreePaths)].sort()) {
    const status = await runCmd(["git", "-C", wtPath, "status", "--porcelain"]);
    if (status.trim().length > 0) {
      dirty.push(wtPath);
    }
  }
  return dirty;
}

export async function stashWorkingTree(worktreePath: string, message: string): Promise<string> {
  await runCmd(["git", "-C", worktreePath, "stash", "push", "-u", "-m", message]);
  const topRef = await runCmd(["git", "-C", worktreePath, "stash", "list", "-n", "1", "--format=%gd"]);
  if (!topRef) {
    throw new GwError(`Failed to identify created stash in ${worktreePath}`);
  }
  return topRef;
}

export async function popStash(worktreePath: string, stashRef: string): Promise<void> {
  await runCmd(["git", "-C", worktreePath, "stash", "pop", stashRef]);
}

export async function isAncestorCommit(cwd: string, ancestorCommit: string, ref: string): Promise<boolean> {
  const mergeBase = await runCmd(["git", "-C", cwd, "merge-base", ancestorCommit, ref], {
    allowFailure: true,
  });
  return mergeBase === ancestorCommit;
}

export async function branchHasCommitMessageFragment(
  cwd: string,
  ref: string,
  fragment: string
): Promise<boolean> {
  const out = await runCmd(
    ["git", "-C", cwd, "log", ref, "--fixed-strings", "--grep", fragment, "-n", "1", "--format=%H"],
    { allowFailure: true }
  );
  return out.length > 0;
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

export async function localBranchExists(cwd: string, branch: string): Promise<boolean> {
  const out = await runCmd(
    ["git", "-C", cwd, "show-ref", "--verify", `refs/heads/${branch}`],
    { allowFailure: true }
  );
  return out.length > 0;
}

export async function remoteBranchExists(
  cwd: string,
  remote: string,
  branch: string
): Promise<boolean> {
  const out = await runCmd(
    ["git", "-C", cwd, "show-ref", "--verify", `refs/remotes/${remote}/${branch}`],
    { allowFailure: true }
  );
  return out.length > 0;
}

export async function addWorktreeForExistingBranch(
  repoRootPath: string,
  branch: string,
  worktreePath: string
): Promise<void> {
  await runCmd(["git", "-C", repoRootPath, "worktree", "add", worktreePath, branch]);
}

export async function addWorktreeForRemoteBranch(
  repoRootPath: string,
  branch: string,
  remote: string,
  worktreePath: string
): Promise<void> {
  await runCmd([
    "git",
    "-C",
    repoRootPath,
    "worktree",
    "add",
    "--track",
    "-b",
    branch,
    worktreePath,
    `${remote}/${branch}`,
  ]);
}

export async function fetch(worktreePath: string, remote = "origin"): Promise<void> {
  await runCmd(["git", "-C", worktreePath, "fetch", remote]);
}

export async function fastForwardBranchFromRemote(
  worktreePath: string,
  branch: string,
  remote = "origin"
): Promise<void> {
  await runCmd(["git", "-C", worktreePath, "merge", "--ff-only", `${remote}/${branch}`]);
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

export async function repoIdentifier(cwd = process.cwd()): Promise<string> {
  const url = await runCmd(["git", "-C", cwd, "remote", "get-url", "origin"]);
  // SSH:   git@github.com:owner/repo.git
  // HTTPS: https://github.com/owner/repo.git
  const sshMatch = url.match(/[:\/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!sshMatch) {
    throw new GwError(`Cannot parse owner/repo from origin URL: ${url}`);
  }
  return `${sshMatch[1]}/${sshMatch[2]}`;
}

export async function isRebaseInProgress(worktreePath: string): Promise<boolean> {
  const gitDir = await runCmd(["git", "-C", worktreePath, "rev-parse", "--git-dir"]);
  const resolvedGitDir = gitDir.startsWith("/") ? gitDir : `${worktreePath}/${gitDir}`;
  const { existsSync } = await import("node:fs");
  return (
    existsSync(`${resolvedGitDir}/rebase-merge`) ||
    existsSync(`${resolvedGitDir}/rebase-apply`)
  );
}

export async function rebaseAbort(worktreePath: string): Promise<void> {
  await runCmd(["git", "-C", worktreePath, "rebase", "--abort"]);
}

export async function listConflictedFiles(worktreePath: string): Promise<string[]> {
  const out = await runCmd(["git", "-C", worktreePath, "diff", "--name-only", "--diff-filter=U"], {
    allowFailure: true,
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function rebaseContinue(worktreePath: string): Promise<void> {
  await runCmd(["git", "-C", worktreePath, "rebase", "--continue"], {
    cwd: worktreePath,
  });
}

export async function resetHard(worktreePath: string, sha: string): Promise<void> {
  await runCmd(["git", "-C", worktreePath, "reset", "--hard", sha]);
}

export async function createBackupRef(
  cwd: string,
  branch: string,
  sha: string,
  timestamp: string
): Promise<void> {
  await runCmd([
    "git",
    "-C",
    cwd,
    "update-ref",
    `refs/gw-backup/${branch}/${timestamp}`,
    sha,
  ]);
}

export async function listBackupRefs(
  cwd: string,
  opts?: { branch?: string; timestamp?: string }
): Promise<Array<{ branch: string; timestamp: string; sha: string; refPath: string }>> {
  let prefix = "refs/gw-backup/";
  if (opts?.branch && opts?.timestamp) {
    prefix = `refs/gw-backup/${opts.branch}/${opts.timestamp}`;
  } else if (opts?.branch) {
    prefix = `refs/gw-backup/${opts.branch}/`;
  }

  const out = await runCmd(
    ["git", "-C", cwd, "for-each-ref", "--format=%(refname) %(objectname)", prefix],
    { allowFailure: true }
  );
  if (!out.trim()) {
    return [];
  }

  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [refPath, sha] = line.split(" ");
      // refs/gw-backup/<branch>/<timestamp>
      const parts = refPath.replace("refs/gw-backup/", "").split("/");
      const timestamp = parts.pop()!;
      const branch = parts.join("/");
      return { branch, timestamp, sha, refPath };
    });
}

export async function deleteBackupRef(cwd: string, refPath: string): Promise<void> {
  await runCmd(["git", "-C", cwd, "update-ref", "-d", refPath]);
}

export function sanitizeBranchForPath(branch: string): string {
  return branch
    .replaceAll("/", "__")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-");
}
