import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  addWorktreeBranch,
  commitFile,
  git,
  runCmd,
  runGw,
  setupBaseRepo,
  writeMeta,
} from "./helpers/harness";

type StackCtx = {
  sandboxDir: string;
  repoDir: string;
  wtB: string;
  wtC: string;
  wtD: string;
};

async function setupRestackStack(): Promise<StackCtx> {
  const { sandboxDir, repoDir } = await setupBaseRepo("gw-e2e-restack");
  const wtB = join(sandboxDir, "wt-b");
  const wtC = join(sandboxDir, "wt-c");
  const wtD = join(sandboxDir, "wt-d");

  await addWorktreeBranch({
    repoDir,
    branch: "feature/b",
    from: "main",
    worktreePath: wtB,
  });
  await commitFile(wtB, "b.txt", "b1\n", "b1");
  await git(wtB, ["push", "-u", "origin", "feature/b"]);

  await addWorktreeBranch({
    repoDir,
    branch: "feature/c",
    from: "feature/b",
    worktreePath: wtC,
  });
  await commitFile(wtC, "c.txt", "c1\n", "c1");
  await git(wtC, ["push", "-u", "origin", "feature/c"]);

  await addWorktreeBranch({
    repoDir,
    branch: "feature/d",
    from: "feature/c",
    worktreePath: wtD,
  });
  await commitFile(wtD, "d.txt", "d1\n", "d1");
  await git(wtD, ["push", "-u", "origin", "feature/d"]);

  await git(repoDir, ["checkout", "main"]);
  await writeMeta(repoDir, {
    "feature/b": "main",
    "feature/c": "feature/b",
    "feature/d": "feature/c",
  });

  return { sandboxDir, repoDir, wtB, wtC, wtD };
}

describe("gw e2e: restack", () => {
  test("restack from feature/b rebases and pushes only descendants", async () => {
    const stack = await setupRestackStack();
    await commitFile(stack.wtB, "b.txt", "b1\nb2\n", "b2");
    const b2Sha = await git(stack.wtB, ["rev-parse", "HEAD"]);

    const out = await runGw({
      cwd: stack.wtB,
      args: ["restack"],
    });

    expect(out.code).toBe(0);
    expect(out.stdout).toContain("Restack base: feature/b");
    expect(out.stdout).toContain("Restack execution order:\n- feature/c\n- feature/d");
    expect(out.stdout).not.toContain("Rebasing feature/b onto");

    const cHasB2 = await runCmd(
      ["git", "-C", stack.repoDir, "merge-base", "--is-ancestor", b2Sha, "feature/c"],
      { allowFailure: true }
    );
    const dHasB2 = await runCmd(
      ["git", "-C", stack.repoDir, "merge-base", "--is-ancestor", b2Sha, "feature/d"],
      { allowFailure: true }
    );
    expect(cHasB2.code).toBe(0);
    expect(dHasB2.code).toBe(0);
  });

  test("restack --dry-run prints order and does not mutate descendants", async () => {
    const stack = await setupRestackStack();
    await commitFile(stack.wtB, "b.txt", "b1\nb2\n", "b2");
    const beforeC = await git(stack.wtC, ["rev-parse", "HEAD"]);
    const beforeD = await git(stack.wtD, ["rev-parse", "HEAD"]);

    const out = await runGw({
      cwd: stack.wtB,
      args: ["restack", "--dry-run"],
    });

    expect(out.code).toBe(0);
    expect(out.stdout).toContain("Restack execution order:");
    const afterC = await git(stack.wtC, ["rev-parse", "HEAD"]);
    const afterD = await git(stack.wtD, ["rev-parse", "HEAD"]);
    expect(afterC).toBe(beforeC);
    expect(afterD).toBe(beforeD);
  });

  test("restack on leaf branch is a no-op", async () => {
    const stack = await setupRestackStack();
    const out = await runGw({
      cwd: stack.wtD,
      args: ["restack", "--from", "feature/d"],
    });

    expect(out.code).toBe(0);
    expect(out.stdout).toContain("No child branches to restack from feature/d.");
  });

  test("restack aborts when involved worktrees are dirty and stash is declined", async () => {
    const stack = await setupRestackStack();
    await writeFile(join(stack.wtC, "dirty.txt"), "dirty\n", "utf8");

    const out = await runGw({
      cwd: stack.wtB,
      args: ["restack", "--from", "feature/b"],
      stdin: "n\n",
      allowFailure: true,
    });

    expect(out.code).toBe(1);
    expect(out.stdout).toContain("Found uncommitted changes in:");
    expect(out.stderr).toContain("Restack stopped: dirty worktrees detected");
  });
});
