import type { PrInfo } from "../types";
import * as gh from "./gh";

const STACK_SECTION_START = "<!-- gw-stack:start -->";
const STACK_SECTION_END = "<!-- gw-stack:end -->";

type StackPrEntry = {
  branch: string;
  pr: PrInfo;
};

export async function refreshStackDescriptions(stackBranches: string[]): Promise<void> {
  const entries = await loadStackPrEntries(stackBranches);
  for (const entry of entries) {
    await refreshSingleBranchDescription(entries, entry.branch);
  }
}

export async function refreshBranchStackDescription(
  stackBranches: string[],
  branch: string
): Promise<void> {
  const entries = await loadStackPrEntries(stackBranches);
  if (!entries.some((entry) => entry.branch === branch)) {
    return;
  }
  await refreshSingleBranchDescription(entries, branch);
}

async function refreshSingleBranchDescription(entries: StackPrEntry[], branch: string): Promise<void> {
  const current = entries.find((entry) => entry.branch === branch);
  if (!current) {
    return;
  }

  const stackSection = renderStackSection(entries, branch);
  const nextBody = upsertStackSection(current.pr.body, stackSection);
  await gh.updatePrBody(current.pr, nextBody);
}

async function loadStackPrEntries(stackBranches: string[]): Promise<StackPrEntry[]> {
  const entries: StackPrEntry[] = [];

  for (const branch of stackBranches) {
    const pr = await gh.viewPrByBranchOptional(branch);
    if (!pr) {
      continue;
    }
    entries.push({ branch, pr });
  }

  return entries;
}

function renderStackSection(entries: StackPrEntry[], currentBranch: string): string {
  const currentIndex = entries.findIndex((entry) => entry.branch === currentBranch);
  if (currentIndex < 0) {
    return "";
  }

  const lines = entries.map((entry, index) => {
    const label = index === currentIndex ? `PR ${index + 1} (this)` : `PR ${index + 1}`;
    return `> - **${label}:** [${entry.pr.title} #${entry.pr.number}](${entry.pr.url}) (base: \`${entry.pr.baseRefName}\`)`;
  });

  return [
    STACK_SECTION_START,
    "> [!NOTE]",
    `> **Stack**: PR ${currentIndex + 1} of ${entries.length}`,
    ">",
    ...lines,
    STACK_SECTION_END,
  ].join("\n");
}

function upsertStackSection(body: string, stackSection: string): string {
  const withoutStack = stripStackSection(body).trim();
  if (!stackSection) {
    return withoutStack;
  }
  if (withoutStack.length === 0) {
    return `${stackSection}\n`;
  }
  return `${withoutStack}\n\n${stackSection}\n`;
}

function stripStackSection(body: string): string {
  const start = body.indexOf(STACK_SECTION_START);
  if (start < 0) {
    return body;
  }

  const end = body.indexOf(STACK_SECTION_END, start);
  if (end < 0) {
    return body.slice(0, start).trimEnd();
  }

  const before = body.slice(0, start).trimEnd();
  const after = body.slice(end + STACK_SECTION_END.length).trimStart();
  if (!before) {
    return after;
  }
  if (!after) {
    return before;
  }
  return `${before}\n\n${after}`;
}
