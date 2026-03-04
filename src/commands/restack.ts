import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as git from "../lib/git";
import { discoverPlan } from "../lib/plan";
import * as ui from "../lib/ui";
import { ConflictError, GwError } from "../lib/errors";

export type RestackOptions = {
  dryRun?: boolean;
  fromBranch?: string;
  yes?: boolean;
};

type AutoStash = {
  entries: Array<{
    worktreePath: string;
    stashRef: string;
  }>;
  restoreAfterSuccess: boolean;
};

export async function runRestack(opts: RestackOptions): Promise<void> {
  const { graph, plan, fromBranch } = await discoverPlan({ fromBranch: opts.fromBranch });
  ui.printPlan(plan);

  const descendants = collectDescendants(graph, fromBranch);
  const executionOrder = plan.rebaseOrder.filter((branch) => descendants.has(branch));
  ui.printInfo(`${ui.styleLabel("Restack base:")} ${ui.styleBranch(fromBranch, "current")}`);

  if (executionOrder.length === 0) {
    ui.printStep(`No child branches to restack from ${fromBranch}.`);
    return;
  }

  ui.printStep("Restack execution order:");
  for (const branch of executionOrder) {
    ui.printStep(`- ${branch}`);
  }

  if (opts.dryRun) {
    return;
  }

  const involvedBranches = [fromBranch, ...executionOrder];
  const autoStash = await ensureCleanOrStash(worktreePathsForBranches(graph, involvedBranches), opts.yes);

  ui.printInfo(ui.styleBold("Restacking descendant branches..."));
  for (const branch of executionOrder) {
    const node = graph.get(branch);
    if (!node || !node.parent) {
      throw new GwError(`Cannot restack: missing parent/worktree for ${branch}`);
    }

    try {
      ui.printStep(`Rebasing ${branch} onto ${node.parent} (${node.worktreePath})`);
      await git.fetch(node.worktreePath, "origin");
      await git.rebaseOnto(node.worktreePath, node.parent);
      await git.pushLease(node.worktreePath, "origin", branch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ConflictError(branch, node.worktreePath, message);
    }
  }

  await restoreAutoStashAfterSuccess(autoStash);
  ui.printStep("Restack complete.");
}

function collectDescendants(
  graph: Map<string, { children: string[] }>,
  fromBranch: string
): Set<string> {
  const descendants = new Set<string>();
  const queue = [...(graph.get(fromBranch)?.children ?? [])].sort();

  while (queue.length > 0) {
    const branch = queue.shift()!;
    if (descendants.has(branch)) {
      continue;
    }
    descendants.add(branch);
    const node = graph.get(branch);
    if (!node) {
      continue;
    }
    for (const child of node.children) {
      if (!descendants.has(child)) {
        queue.push(child);
      }
    }
    queue.sort();
  }

  return descendants;
}

async function askYesNo(question: string, autoYes = false): Promise<boolean> {
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

async function ensureCleanOrStash(worktreePaths: string[], autoYes = false): Promise<AutoStash | undefined> {
  const dirtyPaths = await git.listDirtyWorktrees(worktreePaths);
  if (dirtyPaths.length === 0) {
    return undefined;
  }

  ui.printWarning("Found uncommitted changes in:");
  for (const path of dirtyPaths) {
    ui.printWarning(`- ${ui.stylePath(path)}`);
  }

  const shouldStash = await askYesNo("Stash changes in these worktrees and continue restack? [y/N] ", autoYes);
  if (!shouldStash) {
    throw new GwError(
      "Restack stopped: dirty worktrees detected. Stash or commit changes, then run gw restack."
    );
  }

  const message = `gw auto-stash (${new Date().toISOString()})`;
  const entries: AutoStash["entries"] = [];
  for (const path of dirtyPaths) {
    const stashRef = await git.stashWorkingTree(path, message);
    entries.push({ worktreePath: path, stashRef });
    ui.printStep(`Stashed changes in ${path} (${stashRef})`);
  }

  const restoreAfterSuccess = await askYesNo(
    "Re-apply stashed changes automatically after successful restack? [y/N] ",
    autoYes
  );
  return { entries, restoreAfterSuccess };
}

async function restoreAutoStashAfterSuccess(autoStash: AutoStash | undefined): Promise<void> {
  if (!autoStash || !autoStash.restoreAfterSuccess || autoStash.entries.length === 0) {
    return;
  }

  ui.printStep("Restoring stashed changes after successful restack...");
  for (const entry of autoStash.entries) {
    try {
      await git.popStash(entry.worktreePath, entry.stashRef);
      ui.printStep(`Restored ${entry.stashRef} in ${entry.worktreePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ui.printStep(
        `Warning: failed to restore ${entry.stashRef} in ${entry.worktreePath}: ${message}`
      );
    }
  }
}

function worktreePathsForBranches(
  graph: Map<string, { worktreePath: string }>,
  branches: string[]
): string[] {
  const paths: string[] = [];
  for (const branch of branches) {
    const node = graph.get(branch);
    if (!node) {
      throw new GwError(`Branch ${branch} is not available in current local worktrees.`);
    }
    paths.push(node.worktreePath);
  }
  return [...new Set(paths)].sort();
}
