import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as gh from "./gh";
import * as git from "./git";
import * as prStack from "./prStack";
import * as ui from "./ui";
import { GwError } from "./errors";

export type PrBaseUpdate = {
  branch: string;
  prNumber: number;
  currentBase: string;
  expectedBase: string;
  url: string;
};

export async function findMissingPrs(branches: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const branch of branches) {
    const pr = await gh.viewOpenPrByHeadBranch(branch);
    if (!pr) {
      missing.push(branch);
    }
  }
  return missing;
}

export async function findPrBaseUpdates(
  branches: string[],
  parentByBranch: Record<string, string>,
  repoRoot?: string
): Promise<PrBaseUpdate[]> {
  const updates: PrBaseUpdate[] = [];
  for (const branch of branches) {
    const expectedBase = parentByBranch[branch];
    if (!expectedBase) {
      continue;
    }

    const pr = await gh.viewOpenPrByHeadBranch(branch);
    if (!pr) {
      continue;
    }
    if (pr.baseRefName === expectedBase) {
      continue;
    }

    if (repoRoot) {
      const exists = await git.remoteBranchExists(repoRoot, "origin", expectedBase);
      if (!exists) {
        ui.printWarning(
          `Skipping PR base update for ${ui.styleBranch(branch)}: target base ${ui.styleBranch(expectedBase)} no longer exists on remote (likely merged).`
        );
        continue;
      }
    }

    updates.push({
      branch,
      prNumber: pr.number,
      currentBase: pr.baseRefName,
      expectedBase,
      url: pr.url,
    });
  }
  return updates;
}

export async function applyPrBaseUpdates(updates: PrBaseUpdate[]): Promise<void> {
  for (const update of updates) {
    await gh.updatePrBase({ number: update.prNumber, url: update.url }, update.expectedBase);
    ui.printSuccess(
      `Updated PR #${update.prNumber} base for ${ui.styleBranch(update.branch)} to ${ui.styleBranch(update.expectedBase)}`
    );
  }
}

export async function createMissingPrs(
  stackBranches: string[],
  missingPrs: string[],
  parentByBranch: Record<string, string>,
  repoRoot: string,
  graph: Map<string, { worktreePath: string }>
): Promise<void> {
  const missingSet = new Set(missingPrs);
  const fallbackBase = await git.defaultBranch(repoRoot);

  for (const branch of stackBranches) {
    if (!missingSet.has(branch)) {
      continue;
    }
    const base = parentByBranch[branch] ?? fallbackBase;
    const node = graph.get(branch);
    if (!node) {
      throw new GwError(`Cannot create PR: missing worktree for branch ${branch}`);
    }
    ui.printInfo(`Pushing ${ui.styleBranch(branch)} to origin`);
    await git.pushBranch(node.worktreePath, "origin", branch);
    ui.printInfo(`Creating PR for ${ui.styleBranch(branch)} -> ${ui.styleBranch(base)}`);
    await gh.createPr(branch, base);
    await updateStackDescriptionsSafe(stackBranches);
  }
}

export async function updateStackDescriptionsSafe(stackBranches: string[]): Promise<void> {
  try {
    await prStack.refreshStackDescriptions(stackBranches);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.printStep(`Warning: failed to refresh stack descriptions: ${message}`);
  }
}

export async function updateBranchStackDescriptionSafe(
  stackBranches: string[],
  branch: string
): Promise<void> {
  try {
    await prStack.refreshBranchStackDescription(stackBranches, branch);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.printStep(`Warning: failed to refresh PR description for ${branch}: ${message}`);
  }
}

export async function askYesNo(question: string, autoYes = false): Promise<boolean> {
  if (autoYes) {
    ui.printInfo(`${question}y (auto-confirmed)`);
    return true;
  }
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
