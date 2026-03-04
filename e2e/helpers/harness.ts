import { afterEach } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

export type CmdResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type RunCmdOpts = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  allowFailure?: boolean;
};

type GitOpts = {
  allowFailure?: boolean;
};

export type GhFixture = {
  openByHead?: Record<string, Array<Record<string, unknown>>>;
  allByHead?: Record<string, Array<Record<string, unknown>>>;
  openByBase?: Record<string, Array<Record<string, unknown>>>;
  viewBySelector?: Record<string, Record<string, unknown> | null>;
  requireRemoteHeadOnCreate?: boolean;
};

type GhState = {
  fixture: GhFixture;
  createdByHead: Record<string, Record<string, unknown>>;
  nextNumber: number;
};

export type FakeGh = {
  env: Record<string, string>;
  readCalls: () => Promise<Array<Record<string, unknown>>>;
};

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths.splice(0, cleanupPaths.length)) {
    await rm(path, { recursive: true, force: true });
  }
});

export function projectRoot(): string {
  return resolve(import.meta.dir, "../..");
}

export async function runCmd(cmd: string[], opts: RunCmdOpts = {}): Promise<CmdResult> {
  const env = normalizeEnv(opts.env);
  const stdinPayload =
    opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore";
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env,
    stdin: stdinPayload,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0 && !opts.allowFailure) {
    throw new Error(
      `Command failed (${code}): ${cmd.join(" ")}\n${stderr.trim() || stdout.trim()}`
    );
  }

  return { code, stdout, stderr };
}

export async function git(cwd: string, args: string[], opts: GitOpts = {}): Promise<string> {
  const out = await runCmd(["git", "-C", cwd, ...args], { allowFailure: opts.allowFailure });
  if (out.code !== 0 && !opts.allowFailure) {
    throw new Error(`git ${args.join(" ")} failed:\n${out.stderr || out.stdout}`);
  }
  return out.stdout.trim();
}

export async function runGw(opts: {
  cwd: string;
  args: string[];
  env?: Record<string, string | undefined>;
  stdin?: string;
  allowFailure?: boolean;
}): Promise<CmdResult> {
  const bunPath = Bun.which("bun") ?? "bun";
  return runCmd([bunPath, "run", join(projectRoot(), "src/cli.ts"), ...opts.args], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin,
    allowFailure: opts.allowFailure,
  });
}

export async function setupBaseRepo(name = "gw-e2e"): Promise<{
  sandboxDir: string;
  remoteDir: string;
  repoDir: string;
}> {
  const sandboxDir = await mkdtemp(join(tmpdir(), `${name}-`));
  cleanupPaths.push(sandboxDir);

  const remoteDir = join(sandboxDir, "origin.git");
  const repoDir = join(sandboxDir, "repo");

  await runCmd(["git", "init", "--bare", remoteDir], { cwd: sandboxDir });
  await runCmd(["git", "clone", remoteDir, repoDir], { cwd: sandboxDir });
  await git(repoDir, ["config", "user.name", "gw e2e"]);
  await git(repoDir, ["config", "user.email", "gw-e2e@example.com"]);
  await git(repoDir, ["checkout", "-b", "main"]);

  await writeText(repoDir, "README.md", "# e2e\n");
  await git(repoDir, ["add", "README.md"]);
  await git(repoDir, ["commit", "-m", "initial"]);
  await git(repoDir, ["push", "-u", "origin", "main"]);

  return { sandboxDir, remoteDir, repoDir };
}

export async function addWorktreeBranch(opts: {
  repoDir: string;
  branch: string;
  from: string;
  worktreePath: string;
}): Promise<void> {
  await mkdir(opts.worktreePath, { recursive: true });
  await git(opts.repoDir, ["worktree", "add", "-b", opts.branch, opts.worktreePath, opts.from]);
}

export async function commitFile(
  repoOrWorktree: string,
  path: string,
  content: string,
  message: string
): Promise<void> {
  await writeText(repoOrWorktree, path, content);
  await git(repoOrWorktree, ["add", path]);
  await git(repoOrWorktree, ["commit", "-m", message]);
}

export async function writeMeta(
  repoDir: string,
  parentByBranch: Record<string, string>
): Promise<string> {
  const commonDir = await gitCommonDir(repoDir);
  const file = join(commonDir, "gw-meta.json");
  await writeFile(
    file,
    `${JSON.stringify({ version: 1, parentByBranch }, null, 2)}\n`,
    "utf8"
  );
  return file;
}

export async function gitCommonDir(repoDir: string): Promise<string> {
  const out = await git(repoDir, ["rev-parse", "--git-common-dir"]);
  if (out.startsWith("/")) {
    return out;
  }
  return resolve(repoDir, out);
}

export async function readJson<T>(file: string): Promise<T> {
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw) as T;
}

export async function setupFakeGh(opts: {
  sandboxDir: string;
  fixture: GhFixture;
}): Promise<FakeGh> {
  const binDir = join(opts.sandboxDir, "bin");
  await mkdir(binDir, { recursive: true });

  const statePath = join(opts.sandboxDir, "gh-state.json");
  const callsPath = join(opts.sandboxDir, "gh-calls.ndjson");
  const ghPath = join(binDir, "gh");

  const initialState: GhState = {
    fixture: opts.fixture,
    createdByHead: {},
    nextNumber: 90000,
  };
  await writeFile(statePath, `${JSON.stringify(initialState, null, 2)}\n`, "utf8");
  await writeFile(callsPath, "", "utf8");
  await writeFile(ghPath, FAKE_GH_SCRIPT, "utf8");
  await chmod(ghPath, 0o755);

  return {
    env: {
      GW_E2E_GH_STATE: statePath,
      GW_E2E_GH_CALLS: callsPath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
    readCalls: async () => {
      if (!existsSync(callsPath)) {
        return [];
      }
      const content = await readFile(callsPath, "utf8");
      return content
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

export function openPrState(
  number: number,
  headRefName: string,
  baseRefName: string
): Record<string, unknown> {
  return {
    number,
    url: `https://example.test/org/repo/pull/${number}`,
    headRefName,
    baseRefName,
    title: `PR ${number}`,
    body: "",
    state: "OPEN",
    mergedAt: null,
    closedAt: null,
    headRefOid: null,
  };
}

function normalizeEnv(extra?: Record<string, string | undefined>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

async function writeText(root: string, file: string, content: string): Promise<void> {
  const target = join(root, file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

const FAKE_GH_SCRIPT = `#!/usr/bin/env bun
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const statePath = process.env.GW_E2E_GH_STATE;
const callsPath = process.env.GW_E2E_GH_CALLS;
if (!statePath) {
  console.error("missing GW_E2E_GH_STATE");
  process.exit(1);
}
if (!callsPath) {
  console.error("missing GW_E2E_GH_CALLS");
  process.exit(1);
}

const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath, "utf8"));
const fixture = state.fixture ?? {};
state.createdByHead = state.createdByHead ?? {};
state.nextNumber = state.nextNumber ?? 90000;

function saveState() {
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n", "utf8");
}

function log(event) {
  appendFileSync(callsPath, JSON.stringify({ ...event, argv: args }) + "\\n", "utf8");
}

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx < 0 || idx + 1 >= args.length) {
    return "";
  }
  return args[idx + 1] ?? "";
}

function jsonFields() {
  const raw = getFlag("--json");
  if (!raw) {
    return [];
  }
  return raw.split(",").map((x) => x.trim()).filter(Boolean);
}

function project(record, fields) {
  if (!record) {
    return null;
  }
  if (fields.length === 0) {
    return record;
  }
  const out = {};
  for (const field of fields) {
    out[field] = record[field] ?? null;
  }
  return out;
}

function allCreated() {
  return Object.values(state.createdByHead ?? {});
}

function findPrByNumber(number) {
  const targets = [
    ...Object.values(fixture.viewBySelector ?? {}),
    ...allCreated(),
    ...Object.values(fixture.openByHead ?? {}).flat(),
    ...Object.values(fixture.allByHead ?? {}).flat(),
    ...Object.values(fixture.openByBase ?? {}).flat(),
  ].filter(Boolean);
  for (const record of targets) {
    if (Number(record.number) === number) {
      return record;
    }
  }
  return null;
}

if (args[0] === "pr" && args[1] === "list") {
  const stateName = getFlag("--state") || "open";
  const head = getFlag("--head");
  const base = getFlag("--base");
  const fields = jsonFields();
  let records = [];

  if (head) {
    if (stateName === "all") {
      records = [...(fixture.allByHead?.[head] ?? [])];
    } else {
      records = [...(fixture.openByHead?.[head] ?? [])];
    }
    const created = state.createdByHead?.[head];
    if (created) {
      const createdState = created.state ?? "OPEN";
      if (stateName === "all" || createdState === "OPEN") {
        records.push(created);
      }
    }
  } else if (base) {
    records = [...(fixture.openByBase?.[base] ?? [])];
    for (const created of allCreated()) {
      if ((created.baseRefName ?? "") === base && (created.state ?? "OPEN") === "OPEN") {
        records.push(created);
      }
    }
  }

  records.sort((a, b) => Number(b.number ?? 0) - Number(a.number ?? 0));
  log({ kind: "pr.list", state: stateName, head, base });
  console.log(JSON.stringify(records.map((record) => project(record, fields))));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "view") {
  const selector = args[2] ?? "";
  const fields = jsonFields();
  let record = fixture.viewBySelector?.[selector];
  if (record === undefined) {
    record = state.createdByHead?.[selector];
  }
  if (record === undefined && /^\\d+$/.test(selector)) {
    record = findPrByNumber(Number(selector));
  }

  log({ kind: "pr.view", selector });
  if (!record) {
    process.exit(1);
  }
  console.log(JSON.stringify(project(record, fields)));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "create") {
  const head = getFlag("--head");
  const base = getFlag("--base");
  log({ kind: "pr.create", head, base });

  if (!head || !base) {
    console.error("missing head/base");
    process.exit(1);
  }

  if (fixture.requireRemoteHeadOnCreate) {
    const check = Bun.spawnSync(
      ["git", "ls-remote", "--exit-code", "origin", "refs/heads/" + head],
      { cwd: process.cwd(), stdout: "ignore", stderr: "ignore" }
    );
    if (check.exitCode !== 0) {
      console.error("Head sha can't be blank");
      process.exit(1);
    }
  }

  const number = Number(state.nextNumber ?? 90000);
  state.nextNumber = number + 1;
  const created = {
    number,
    url: "https://example.test/org/repo/pull/" + number,
    headRefName: head,
    baseRefName: base,
    title: "PR " + number,
    body: "",
    state: "OPEN",
    mergedAt: null,
    closedAt: null,
    headRefOid: null,
  };
  state.createdByHead[head] = created;
  saveState();
  console.log(created.url);
  process.exit(0);
}

if (args[0] === "api") {
  const method = getFlag("--method");
  if (method !== "PATCH") {
    console.error("unsupported method");
    process.exit(1);
  }
  const route = args.find((arg) => arg.startsWith("repos/")) ?? "";
  const numMatch = route.match(/\\/pulls\\/(\\d+)$/);
  const number = numMatch ? Number(numMatch[1]) : null;
  const fields = args
    .map((arg, idx) => ({ arg, idx }))
    .filter((entry) => entry.arg === "-f")
    .map((entry) => args[entry.idx + 1] ?? "")
    .filter(Boolean);

  for (const field of fields) {
    const eqIdx = field.indexOf("=");
    const key = eqIdx > 0 ? field.slice(0, eqIdx) : field;
    const value = eqIdx > 0 ? field.slice(eqIdx + 1) : "";
    log({ kind: "api.patch", route, number, key, value });
    if (number !== null) {
      const target = findPrByNumber(number);
      if (target) {
        target[key === "base" ? "baseRefName" : key] = value;
      }
    }
  }
  saveState();
  console.log("{}");
  process.exit(0);
}

console.error("unsupported gh invocation: " + args.join(" "));
process.exit(1);
`;
