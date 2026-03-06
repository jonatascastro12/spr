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
  runGw,
  runCmd,
  setupBaseRepo,
  setupFakeGh,
  writeMeta,
  type GhFixture,
} from "./helpers/harness";

type StackCtx = {
  sandboxDir: string;
  remoteDir: string;
  repoDir: string;
  wtA: string;
  wtB?: string;
};

async function setupOneBranchStack(): Promise<StackCtx> {
  const { sandboxDir, remoteDir, repoDir } = await setupBaseRepo();
  const wtA = join(sandboxDir, "wt-a");
  await addWorktreeBranch({
    repoDir,
    branch: "feature/a",
    from: "main",
    worktreePath: wtA,
  });
  await commitFile(wtA, "feature-a.txt", "a1\n", "feature a");
  await git(wtA, ["push", "-u", "origin", "feature/a"]);
  await git(repoDir, ["checkout", "main"]);
  await writeMeta(repoDir, { "feature/a": "main" });
  return { sandboxDir, remoteDir, repoDir, wtA };
}

async function setupTwoBranchStack(): Promise<StackCtx> {
  const { sandboxDir, remoteDir, repoDir } = await setupBaseRepo();
  const wtA = join(sandboxDir, "wt-a");
  const wtB = join(sandboxDir, "wt-b");
  await addWorktreeBranch({
    repoDir,
    branch: "feature/a",
    from: "main",
    worktreePath: wtA,
  });
  await commitFile(wtA, "feature-a.txt", "a1\n", "feature a");
  await git(wtA, ["push", "-u", "origin", "feature/a"]);

  await addWorktreeBranch({
    repoDir,
    branch: "feature/b",
    from: "feature/a",
    worktreePath: wtB,
  });
  await commitFile(wtB, "feature-b.txt", "b1\n", "feature b");
  await git(wtB, ["push", "-u", "origin", "feature/b"]);
  await git(repoDir, ["checkout", "main"]);
  await writeMeta(repoDir, {
    "feature/a": "main",
    "feature/b": "feature/a",
  });
  return { sandboxDir, remoteDir, repoDir, wtA, wtB };
}

function fixtureWithOpenPrs(branches: Array<{ branch: string; base: string; number: number }>): GhFixture {
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

describe("gw e2e: status/sync/resume", () => {
  test("status prints expected stack tree for 3-branch stack", async () => {
    const stack = await setupTwoBranchStack();
    const out = await runGw({
      cwd: stack.wtB!,
      args: ["status", "--from", "feature/b"],
    });

    expect(out.code).toBe(0);
    expect(out.stdout).toContain("From branch: feature/b");
    expect(out.stdout).toContain("Stack tree:");
    expect(out.stdout).toContain("*-- main [root]");
    expect(out.stdout).toContain("`-- feature/a [rebase:1]");
    expect(out.stdout).toContain("`-- feature/b [current, rebase:2]");
    expect(out.stdout).toContain("Checkpoint: none");
  });

  test("sync --dry-run prints plan and does not write state", async () => {
    const stack = await setupTwoBranchStack();
    const fakeGh = await setupFakeGh({
      sandboxDir: stack.sandboxDir,
      fixture: fixtureWithOpenPrs([
        { branch: "feature/a", base: "main", number: 101 },
        { branch: "feature/b", base: "feature/a", number: 102 },
      ]),
    });
    const commonDir = await gitCommonDir(stack.repoDir);
    const metaPath = join(commonDir, "gw-meta.json");
    const beforeMeta = await readFile(metaPath, "utf8");

    const out = await runGw({
      cwd: stack.wtB!,
      args: ["sync", "--dry-run", "--from", "feature/b"],
      env: fakeGh.env,
    });

    expect(out.code).toBe(0);
    expect(out.stdout).toContain("Stack root: main");
    expect(out.stdout).toContain("Rebase execution order:");
    expect(existsSync(join(commonDir, "gw-state.json"))).toBe(false);
    const afterMeta = await readFile(metaPath, "utf8");
    expect(afterMeta).toBe(beforeMeta);
  });

  test("sync with missing PRs continues on n without creating PRs", async () => {
    const stack = await setupTwoBranchStack();
    const fakeGh = await setupFakeGh({
      sandboxDir: stack.sandboxDir,
      fixture: {},
    });
    const out = await runGw({
      cwd: stack.wtB!,
      args: ["sync", "--from", "feature/b"],
      env: fakeGh.env,
      stdin: "\n",
    });

    expect(out.code).toBe(0);
    expect(out.stdout).toContain("Missing PRs for: feature/a, feature/b");
    expect(out.stdout).toContain("Continuing sync without creating missing PRs.");
    const calls = await fakeGh.readCalls();
    const createCalls = calls.filter((call) => call.kind === "pr.create");
    expect(createCalls.length).toBe(0);
  });

  test("sync with missing PRs creates PRs in stack order after y", async () => {
    const stack = await setupTwoBranchStack();
    const fakeGh = await setupFakeGh({
      sandboxDir: stack.sandboxDir,
      fixture: { requireRemoteHeadOnCreate: true },
    });
    const out = await runGw({
      cwd: stack.wtB!,
      args: ["sync", "--from", "feature/b"],
      env: fakeGh.env,
      stdin: "y\n",
    });

    expect(out.code).toBe(0);
    const calls = await fakeGh.readCalls();
    const createCalls = calls.filter((call) => call.kind === "pr.create");
    expect(createCalls.length).toBe(2);
    expect(createCalls[0]?.head).toBe("feature/a");
    expect(createCalls[1]?.head).toBe("feature/b");
  });

  test("dirty worktree flow aborts on stash prompt n", async () => {
    const stack = await setupOneBranchStack();
    const fakeGh = await setupFakeGh({
      sandboxDir: stack.sandboxDir,
      fixture: fixtureWithOpenPrs([{ branch: "feature/a", base: "main", number: 210 }]),
    });
    await writeFile(join(stack.wtA, "dirty.txt"), "dirty\n", "utf8");

    const out = await runGw({
      cwd: stack.wtA,
      args: ["sync", "--from", "feature/a"],
      env: fakeGh.env,
      stdin: "n\n",
      allowFailure: true,
    });

    expect(out.code).toBe(1);
    expect(out.stdout).toContain("Found uncommitted changes in:");
    expect(out.stderr).toContain("Sync stopped: dirty worktrees detected");
  });

  test("dirty worktree flow prompts for auto-restore choice after stashing", async () => {
    const stack = await setupOneBranchStack();
    const fakeGh = await setupFakeGh({
      sandboxDir: stack.sandboxDir,
      fixture: fixtureWithOpenPrs([{ branch: "feature/a", base: "main", number: 211 }]),
    });
    await writeFile(join(stack.wtA, "dirty.txt"), "dirty\n", "utf8");

    const out = await runGw({
      cwd: stack.wtA,
      args: ["sync", "--from", "feature/a"],
      env: fakeGh.env,
      stdin: "y\n",
      allowFailure: true,
    });

    expect(out.stdout).toContain(
      "Re-apply stashed changes automatically after successful sync? [y/N]"
    );
    const stashList = await git(stack.wtA, ["stash", "list"]);
    expect(stashList).toContain("gw auto-stash");
  });

  test("dirty worktree stash flow keeps stash when user chooses n to restore", async () => {
    const stack = await setupOneBranchStack();
    const fakeGh = await setupFakeGh({
      sandboxDir: stack.sandboxDir,
      fixture: fixtureWithOpenPrs([{ branch: "feature/a", base: "main", number: 212 }]),
    });
    await writeFile(join(stack.wtA, "dirty.txt"), "dirty\n", "utf8");

    const out = await runGw({
      cwd: stack.wtA,
      args: ["sync", "--from", "feature/a"],
      env: fakeGh.env,
      stdin: "y\nn\n",
    });

    expect(out.code).toBe(0);
    const stashList = await git(stack.wtA, ["stash", "list"]);
    expect(stashList).toContain("gw auto-stash");
  });

  test("sync rebase conflict saves checkpoint", async () => {
    const stack = await setupBaseRepo();
    const wtA = join(stack.sandboxDir, "wt-a");
    await commitFile(stack.repoDir, "conflict.txt", "base\n", "add conflict base");
    await git(stack.repoDir, ["push", "origin", "main"]);

    await addWorktreeBranch({
      repoDir: stack.repoDir,
      branch: "feature/a",
      from: "main",
      worktreePath: wtA,
    });
    await commitFile(wtA, "conflict.txt", "feature\n", "feature change");
    await git(wtA, ["push", "-u", "origin", "feature/a"]);
    await git(stack.repoDir, ["checkout", "main"]);
    await commitFile(stack.repoDir, "conflict.txt", "main\n", "main change");
    await git(stack.repoDir, ["push", "origin", "main"]);
    await writeMeta(stack.repoDir, { "feature/a": "main" });

    const fakeGh = await setupFakeGh({
      sandboxDir: stack.sandboxDir,
      fixture: fixtureWithOpenPrs([{ branch: "feature/a", base: "main", number: 220 }]),
    });
    const out = await runGw({
      cwd: wtA,
      args: ["sync", "--from", "feature/a"],
      env: fakeGh.env,
      allowFailure: true,
    });

    expect(out.code).toBe(1);
    expect(out.stderr).toContain("Rebase conflict on feature/a");
    const commonDir = await gitCommonDir(stack.repoDir);
    const state = await readJson<{ failedAt?: string; lastError?: string }>(
      join(commonDir, "gw-state.json")
    );
    expect(state.failedAt).toBe("feature/a");
    expect(state.lastError).toContain("rebase");
  });

  test("resume fails clearly when no checkpoint exists", async () => {
    const stack = await setupOneBranchStack();
    const out = await runGw({
      cwd: stack.wtA,
      args: ["resume"],
      allowFailure: true,
    });

    expect(out.code).toBe(1);
    expect(out.stderr).toContain("No saved sync state found.");
  });

  test("resume continues successfully from conflict checkpoint after manual continue", async () => {
    const stack = await setupBaseRepo();
    const wtA = join(stack.sandboxDir, "wt-a");
    await commitFile(stack.repoDir, "conflict.txt", "base\n", "add conflict base");
    await git(stack.repoDir, ["push", "origin", "main"]);

    await addWorktreeBranch({
      repoDir: stack.repoDir,
      branch: "feature/a",
      from: "main",
      worktreePath: wtA,
    });
    await commitFile(wtA, "conflict.txt", "feature\n", "feature change");
    await git(wtA, ["push", "-u", "origin", "feature/a"]);
    await git(stack.repoDir, ["checkout", "main"]);
    await commitFile(stack.repoDir, "conflict.txt", "main\n", "main change");
    await git(stack.repoDir, ["push", "origin", "main"]);
    await writeMeta(stack.repoDir, { "feature/a": "main" });

    const fakeGh = await setupFakeGh({
      sandboxDir: stack.sandboxDir,
      fixture: fixtureWithOpenPrs([{ branch: "feature/a", base: "main", number: 230 }]),
    });

    const first = await runGw({
      cwd: wtA,
      args: ["sync", "--from", "feature/a"],
      env: fakeGh.env,
      allowFailure: true,
    });
    expect(first.code).toBe(1);
    expect(first.stderr).toContain("Rebase conflict on feature/a");

    await writeFile(join(wtA, "conflict.txt"), "resolved\n", "utf8");
    await git(wtA, ["add", "conflict.txt"]);
    await runCmd(["git", "-C", wtA, "-c", "core.editor=true", "rebase", "--continue"]);

    const second = await runGw({
      cwd: wtA,
      args: ["resume"],
      env: fakeGh.env,
    });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("Resume complete.");

    const commonDir = await gitCommonDir(stack.repoDir);
    expect(existsSync(join(commonDir, "gw-state.json"))).toBe(false);
  });

  test("merged ancestor case pivots planning and updates child PR base", async () => {
    const stack = await setupTwoBranchStack();
    await commitFile(stack.repoDir, "marker.txt", "m\n", "merge queue close (#52169)");
    await git(stack.repoDir, ["push", "origin", "main"]);

    const fixture: GhFixture = {
      allByHead: {
        "feature/a": [
          {
            number: 52169,
            url: "https://example.test/org/repo/pull/52169",
            headRefName: "feature/a",
            baseRefName: "main",
            state: "CLOSED",
            mergedAt: null,
            closedAt: "2026-02-23T20:19:55Z",
            headRefOid: null,
          },
        ],
      },
      openByHead: {
        "feature/b": [openPrState(52907, "feature/b", "feature/a")],
      },
      viewBySelector: {
        "feature/b": openPrState(52907, "feature/b", "feature/a"),
      },
    };
    const fakeGh = await setupFakeGh({ sandboxDir: stack.sandboxDir, fixture });

    const dryRun = await runGw({
      cwd: stack.wtA,
      args: ["sync", "--dry-run", "--from", "feature/a"],
      env: fakeGh.env,
    });
    expect(dryRun.code).toBe(0);
    expect(dryRun.stdout).toContain(
      "Using feature/b for planning because feature/a is already merged."
    );
    expect(dryRun.stdout).toContain(
      "feature/b PR #52907: feature/a -> main"
    );

    const run = await runGw({
      cwd: stack.wtA,
      args: ["sync", "--from", "feature/a"],
      env: fakeGh.env,
    });
    expect(run.code).toBe(0);
    const commonDir = await gitCommonDir(stack.repoDir);
    const meta = await readJson<{ parentByBranch: Record<string, string> }>(
      join(commonDir, "gw-meta.json")
    );
    expect(meta.parentByBranch).toEqual({ "feature/b": "main" });
    const calls = await fakeGh.readCalls();
    const baseUpdates = calls.filter(
      (call) => call.kind === "api.patch" && call.key === "base" && call.value === "main"
    );
    expect(baseUpdates.length).toBeGreaterThanOrEqual(1);
  });

  test("sync creates backup refs before rebasing", async () => {
    const stack = await setupOneBranchStack();
    const fakeGh = await setupFakeGh({
      sandboxDir: stack.sandboxDir,
      fixture: fixtureWithOpenPrs([{ branch: "feature/a", base: "main", number: 250 }]),
    });

    const out = await runGw({
      cwd: stack.wtA,
      args: ["sync", "--from", "feature/a"],
      env: fakeGh.env,
    });
    expect(out.code).toBe(0);

    // Check backup refs exist
    const refs = await git(stack.repoDir, ["for-each-ref", "--format=%(refname)", "refs/gw-backup/"]);
    expect(refs).toContain("refs/gw-backup/");
    expect(refs).toContain("feature/a");
  });

  test("conflict error shows structured multi-line guide", async () => {
    const stack = await setupBaseRepo();
    const wtA = join(stack.sandboxDir, "wt-a");
    await commitFile(stack.repoDir, "conflict.txt", "base\n", "add conflict base");
    await git(stack.repoDir, ["push", "origin", "main"]);

    await addWorktreeBranch({
      repoDir: stack.repoDir,
      branch: "feature/a",
      from: "main",
      worktreePath: wtA,
    });
    await commitFile(wtA, "conflict.txt", "feature\n", "feature change");
    await git(wtA, ["push", "-u", "origin", "feature/a"]);
    await git(stack.repoDir, ["checkout", "main"]);
    await commitFile(stack.repoDir, "conflict.txt", "main\n", "main change");
    await git(stack.repoDir, ["push", "origin", "main"]);
    await writeMeta(stack.repoDir, { "feature/a": "main" });

    const fakeGh = await setupFakeGh({
      sandboxDir: stack.sandboxDir,
      fixture: fixtureWithOpenPrs([{ branch: "feature/a", base: "main", number: 260 }]),
    });
    const out = await runGw({
      cwd: wtA,
      args: ["sync", "--from", "feature/a"],
      env: fakeGh.env,
      allowFailure: true,
    });

    expect(out.code).toBe(1);
    expect(out.stderr).toContain("Rebase conflict on feature/a");
    expect(out.stderr).toContain("To resolve manually:");
    expect(out.stderr).toContain("gw resolve");
    expect(out.stderr).toContain("gw abort");
  });

  test("resume detects mid-rebase and tells user to finish", async () => {
    const stack = await setupBaseRepo();
    const wtA = join(stack.sandboxDir, "wt-a");
    await commitFile(stack.repoDir, "conflict.txt", "base\n", "add conflict base");
    await git(stack.repoDir, ["push", "origin", "main"]);

    await addWorktreeBranch({
      repoDir: stack.repoDir,
      branch: "feature/a",
      from: "main",
      worktreePath: wtA,
    });
    await commitFile(wtA, "conflict.txt", "feature\n", "feature change");
    await git(wtA, ["push", "-u", "origin", "feature/a"]);
    await git(stack.repoDir, ["checkout", "main"]);
    await commitFile(stack.repoDir, "conflict.txt", "main\n", "main change");
    await git(stack.repoDir, ["push", "origin", "main"]);
    await writeMeta(stack.repoDir, { "feature/a": "main" });

    const fakeGh = await setupFakeGh({
      sandboxDir: stack.sandboxDir,
      fixture: fixtureWithOpenPrs([{ branch: "feature/a", base: "main", number: 270 }]),
    });

    // Trigger conflict
    const first = await runGw({
      cwd: wtA,
      args: ["sync", "--from", "feature/a"],
      env: fakeGh.env,
      allowFailure: true,
    });
    expect(first.code).toBe(1);

    // Do NOT resolve — try to resume immediately
    const second = await runGw({
      cwd: wtA,
      args: ["resume"],
      env: fakeGh.env,
      allowFailure: true,
    });
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("rebase is still in progress");
  });

  test("sync fast-forwards root main before rebase execution", async () => {
    const stack = await setupOneBranchStack();
    const mirrorDir = join(stack.sandboxDir, "mirror");
    await git(stack.sandboxDir, ["clone", stack.remoteDir, mirrorDir]);
    await git(mirrorDir, ["config", "user.name", "gw e2e"]);
    await git(mirrorDir, ["config", "user.email", "gw-e2e@example.com"]);
    await git(mirrorDir, ["checkout", "main"]);
    await commitFile(mirrorDir, "remote-only.txt", "remote\n", "remote update");
    await git(mirrorDir, ["push", "origin", "main"]);

    const fakeGh = await setupFakeGh({
      sandboxDir: stack.sandboxDir,
      fixture: fixtureWithOpenPrs([{ branch: "feature/a", base: "main", number: 240 }]),
    });

    const out = await runGw({
      cwd: stack.wtA,
      args: ["sync", "--from", "feature/a"],
      env: fakeGh.env,
    });
    expect(out.code).toBe(0);

    const mainSha = await git(stack.repoDir, ["rev-parse", "main"]);
    const originMainSha = await git(stack.repoDir, ["rev-parse", "origin/main"]);
    expect(mainSha).toBe(originMainSha);
  });
});
