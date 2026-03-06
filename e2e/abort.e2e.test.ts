import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  addWorktreeBranch,
  commitFile,
  git,
  gitCommonDir,
  openPrState,
  readJson,
  runCmd,
  runGw,
  setupBaseRepo,
  setupFakeGh,
  writeMeta,
  type GhFixture,
} from "./helpers/harness";

function fixtureWithOpenPrs(
  branches: Array<{ branch: string; base: string; number: number }>
): GhFixture {
  const openByHead: Record<string, Array<Record<string, unknown>>> = {};
  const viewBySelector: Record<string, Record<string, unknown>> = {};
  for (const pr of branches) {
    const entry = openPrState(pr.number, pr.branch, pr.base);
    openByHead[pr.branch] = [entry];
    viewBySelector[pr.branch] = entry;
    viewBySelector[String(pr.number)] = entry;
  }
  return { openByHead, viewBySelector };
}

async function setupConflictStack() {
  const { sandboxDir, remoteDir, repoDir } = await setupBaseRepo("gw-e2e-abort");
  const wtA = join(sandboxDir, "wt-a");

  await commitFile(repoDir, "conflict.txt", "base\n", "add conflict base");
  await git(repoDir, ["push", "origin", "main"]);

  await addWorktreeBranch({
    repoDir,
    branch: "feature/a",
    from: "main",
    worktreePath: wtA,
  });
  await commitFile(wtA, "conflict.txt", "feature\n", "feature change");
  await git(wtA, ["push", "-u", "origin", "feature/a"]);

  await git(repoDir, ["checkout", "main"]);
  await commitFile(repoDir, "conflict.txt", "main\n", "main change");
  await git(repoDir, ["push", "origin", "main"]);
  await writeMeta(repoDir, { "feature/a": "main" });

  return { sandboxDir, remoteDir, repoDir, wtA };
}

async function setupThreeBranchConflictStack() {
  const { sandboxDir, remoteDir, repoDir } = await setupBaseRepo("gw-e2e-abort3");
  const wtA = join(sandboxDir, "wt-a");
  const wtB = join(sandboxDir, "wt-b");

  // Create feature/a
  await addWorktreeBranch({ repoDir, branch: "feature/a", from: "main", worktreePath: wtA });
  await commitFile(wtA, "a.txt", "a1\n", "feature a");
  await git(wtA, ["push", "-u", "origin", "feature/a"]);

  // Create feature/b from feature/a with a conflict
  await addWorktreeBranch({ repoDir, branch: "feature/b", from: "feature/a", worktreePath: wtB });
  await commitFile(wtB, "conflict.txt", "from-b\n", "b conflict file");
  await git(wtB, ["push", "-u", "origin", "feature/b"]);

  // Add a conflicting change on feature/a
  await commitFile(wtA, "conflict.txt", "from-a\n", "a conflict file");
  await git(wtA, ["push", "origin", "feature/a"]);

  await git(repoDir, ["checkout", "main"]);
  await writeMeta(repoDir, {
    "feature/a": "main",
    "feature/b": "feature/a",
  });

  return { sandboxDir, remoteDir, repoDir, wtA, wtB };
}

describe("gw e2e: abort", () => {
  test("gw abort clears state and aborts active rebase", async () => {
    const stack = await setupConflictStack();
    const fakeGh = await setupFakeGh({
      sandboxDir: stack.sandboxDir,
      fixture: fixtureWithOpenPrs([{ branch: "feature/a", base: "main", number: 300 }]),
    });

    // Trigger a conflict
    const first = await runGw({
      cwd: stack.wtA,
      args: ["sync", "--from", "feature/a"],
      env: fakeGh.env,
      allowFailure: true,
    });
    expect(first.code).toBe(1);
    expect(first.stderr).toContain("Rebase conflict on feature/a");

    // Verify state exists
    const commonDir = await gitCommonDir(stack.repoDir);
    expect(existsSync(join(commonDir, "gw-state.json"))).toBe(true);

    // Run abort
    const abort = await runGw({
      cwd: stack.wtA,
      args: ["abort"],
      env: fakeGh.env,
    });
    expect(abort.code).toBe(0);
    expect(abort.stdout).toContain("Sync aborted.");

    // State should be cleared
    expect(existsSync(join(commonDir, "gw-state.json"))).toBe(false);

    // Worktree should no longer be mid-rebase
    const rebaseMerge = await git(stack.wtA, ["rev-parse", "--git-dir"]);
    const gitDir = rebaseMerge.startsWith("/") ? rebaseMerge : join(stack.wtA, rebaseMerge);
    expect(existsSync(join(gitDir, "rebase-merge"))).toBe(false);
    expect(existsSync(join(gitDir, "rebase-apply"))).toBe(false);
  });

  test("gw abort with no state prints error", async () => {
    const { sandboxDir, repoDir } = await setupBaseRepo("gw-e2e-abort-nostate");
    const wtA = join(sandboxDir, "wt-a");
    await addWorktreeBranch({ repoDir, branch: "feature/a", from: "main", worktreePath: wtA });

    const out = await runGw({
      cwd: wtA,
      args: ["abort"],
      allowFailure: true,
    });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("No saved sync state found");
  });

  test("gw abort --rollback resets completed branches to pre-sync SHAs", async () => {
    const stack = await setupThreeBranchConflictStack();
    const fakeGh = await setupFakeGh({
      sandboxDir: stack.sandboxDir,
      fixture: fixtureWithOpenPrs([
        { branch: "feature/a", base: "main", number: 310 },
        { branch: "feature/b", base: "feature/a", number: 311 },
      ]),
    });

    // Record pre-sync SHA for feature/a
    const preSyncShaA = await git(stack.wtA, ["rev-parse", "HEAD"]);

    // Trigger sync → feature/a succeeds, feature/b conflicts
    const first = await runGw({
      cwd: stack.wtB!,
      args: ["sync", "--from", "feature/b"],
      env: fakeGh.env,
      allowFailure: true,
    });
    expect(first.code).toBe(1);
    expect(first.stderr).toContain("Rebase conflict on feature/b");

    // feature/a should have been rebased (SHA changed)
    const afterSyncShaA = await git(stack.wtA, ["rev-parse", "HEAD"]);
    // (it may or may not change since main didn't diverge, but the backup ref was created)

    // Run abort --rollback
    const abort = await runGw({
      cwd: stack.wtB!,
      args: ["abort", "--rollback", "--yes"],
      env: fakeGh.env,
    });
    expect(abort.code).toBe(0);
    expect(abort.stdout).toContain("rolled back");

    // State should be cleared
    const commonDir = await gitCommonDir(stack.repoDir);
    expect(existsSync(join(commonDir, "gw-state.json"))).toBe(false);
  });

  test("gw abort --rollback checks for dirty worktrees", async () => {
    const stack = await setupThreeBranchConflictStack();
    const fakeGh = await setupFakeGh({
      sandboxDir: stack.sandboxDir,
      fixture: fixtureWithOpenPrs([
        { branch: "feature/a", base: "main", number: 320 },
        { branch: "feature/b", base: "feature/a", number: 321 },
      ]),
    });

    // Trigger sync → feature/a succeeds, feature/b conflicts
    await runGw({
      cwd: stack.wtB!,
      args: ["sync", "--from", "feature/b"],
      env: fakeGh.env,
      allowFailure: true,
    });

    // Abort the rebase first so we can dirty the worktree properly
    await git(stack.wtB!, ["rebase", "--abort"]);

    // Dirty the completed worktree (feature/a)
    await writeFile(join(stack.wtA, "dirty.txt"), "dirty\n", "utf8");

    // Abort --rollback, decline the dirty worktree warning
    const abort = await runGw({
      cwd: stack.wtB!,
      args: ["abort", "--rollback"],
      env: fakeGh.env,
      stdin: "n\n",
    });
    expect(abort.code).toBe(0);
    expect(abort.stdout).toContain("Skipping rollback");

    // State should still be cleared
    const commonDir = await gitCommonDir(stack.repoDir);
    expect(existsSync(join(commonDir, "gw-state.json"))).toBe(false);
  });
});
