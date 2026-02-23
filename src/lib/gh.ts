import type { PrInfo, PrStateInfo } from "../types";
import { MissingPrError, SprError } from "./errors";
import { runCmd } from "./shell";

export async function viewPrByBranchOptional(branch: string): Promise<PrInfo | null> {
  const out = await runCmd(
    [
      "gh",
      "pr",
      "view",
      branch,
      "--json",
      "number,headRefName,baseRefName,url,title,body",
    ],
    { allowFailure: true }
  );

  if (!out) {
    return null;
  }

  try {
    return parsePrInfo(JSON.parse(out));
  } catch {
    return null;
  }
}

export async function viewPrByBranch(branch: string): Promise<PrInfo> {
  const pr = await viewPrByBranchOptional(branch);
  if (!pr) {
    throw new MissingPrError(branch);
  }
  return pr;
}

export async function createPr(branch: string, base: string): Promise<void> {
  await runCmd(["gh", "pr", "create", "--head", branch, "--base", base, "--fill"]);
}

export async function viewLatestPrByHeadBranch(branch: string): Promise<PrStateInfo | null> {
  const out = await runCmd(
    [
      "gh",
      "pr",
      "list",
      "--state",
      "all",
      "--head",
      branch,
      "--limit",
      "20",
      "--json",
      "number,url,headRefName,baseRefName,state,mergedAt,closedAt,headRefOid",
    ],
    { allowFailure: true }
  );

  if (!out) {
    return null;
  }

  try {
    const parsed = JSON.parse(out) as unknown[];
    const prs = parsed
      .map((item) => parsePrStateInfo(item))
      .filter((item): item is PrStateInfo => item !== null)
      .sort((a, b) => b.number - a.number);
    return prs[0] ?? null;
  } catch {
    return null;
  }
}

export async function viewOpenPrByHeadBranch(branch: string): Promise<PrStateInfo | null> {
  const out = await runCmd(
    [
      "gh",
      "pr",
      "list",
      "--state",
      "open",
      "--head",
      branch,
      "--limit",
      "20",
      "--json",
      "number,url,headRefName,baseRefName,state,mergedAt,closedAt,headRefOid",
    ],
    { allowFailure: true }
  );

  if (!out) {
    return null;
  }

  try {
    const parsed = JSON.parse(out) as unknown[];
    const prs = parsed
      .map((item) => parsePrStateInfo(item))
      .filter((item): item is PrStateInfo => item !== null)
      .sort((a, b) => b.number - a.number);
    return prs[0] ?? null;
  } catch {
    return null;
  }
}

export async function listOpenPrsByBase(baseBranch: string): Promise<PrInfo[]> {
  const out = await runCmd(
    [
      "gh",
      "pr",
      "list",
      "--state",
      "open",
      "--base",
      baseBranch,
      "--limit",
      "100",
      "--json",
      "number,headRefName,baseRefName,url,title,body",
    ],
    { allowFailure: true }
  );

  if (!out) {
    return [];
  }

  try {
    const parsed = JSON.parse(out) as unknown[];
    return parsed
      .map((item) => parsePrInfo(item))
      .filter((item): item is PrInfo => item !== null)
      .sort((a, b) => a.headRefName.localeCompare(b.headRefName));
  } catch {
    return [];
  }
}

export async function updatePrBody(pr: Pick<PrInfo, "number" | "url">, body: string): Promise<void> {
  const { owner, repo } = parseGithubPrUrl(pr.url);
  await runCmd([
    "gh",
    "api",
    "--method",
    "PATCH",
    `repos/${owner}/${repo}/pulls/${pr.number}`,
    "-f",
    `body=${body}`,
  ]);
}

function parseGithubPrUrl(url: string): { owner: string; repo: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SprError(`Invalid PR URL: ${url}`);
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[2] !== "pull") {
    throw new SprError(`Unexpected PR URL format: ${url}`);
  }

  const [owner, repo] = parts;
  if (!owner || !repo) {
    throw new SprError(`Unexpected PR URL format: ${url}`);
  }

  return { owner, repo };
}

function parsePrInfo(value: unknown): PrInfo | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const parsed = value as Partial<PrInfo>;
  if (
    !parsed.headRefName ||
    !parsed.baseRefName ||
    !parsed.number ||
    !parsed.url ||
    typeof parsed.title !== "string" ||
    typeof parsed.body !== "string"
  ) {
    return null;
  }
  return parsed as PrInfo;
}

function parsePrStateInfo(value: unknown): PrStateInfo | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const parsed = value as Partial<PrStateInfo>;
  if (
    !parsed.number ||
    !parsed.url ||
    !parsed.headRefName ||
    !parsed.baseRefName ||
    (parsed.state !== "OPEN" && parsed.state !== "CLOSED" && parsed.state !== "MERGED")
  ) {
    return null;
  }

  return {
    number: parsed.number,
    url: parsed.url,
    headRefName: parsed.headRefName,
    baseRefName: parsed.baseRefName,
    state: parsed.state,
    mergedAt: parsed.mergedAt ?? null,
    closedAt: parsed.closedAt ?? null,
    headRefOid: parsed.headRefOid ?? null,
  };
}
