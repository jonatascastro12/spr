import * as git from "../lib/git";
import { discoverPlan } from "../lib/plan";
import {
  askYesNo,
  applyPrBaseUpdates,
  createMissingPrs,
  findMissingPrs,
  findPrBaseUpdates,
  updateBranchStackDescriptionSafe,
} from "../lib/pr-ops";
import { collectDescendants } from "../lib/stack";
import * as ui from "../lib/ui";

export type SubmitOptions = {
  dryRun?: boolean;
  fromBranch?: string;
  yes?: boolean;
};

export async function runSubmit(opts: SubmitOptions): Promise<void> {
  const { graph, plan, parentByBranch, repoRoot, fromBranch } = await discoverPlan({
    fromBranch: opts.fromBranch,
  });
  ui.printPlan(plan);

  const descendants = collectDescendants(graph, fromBranch);
  const subtree = new Set<string>(descendants);
  if (parentByBranch[fromBranch]) {
    subtree.add(fromBranch);
  }

  const submittable = [...subtree].filter((branch) => parentByBranch[branch]);
  const executionOrder = plan.rebaseOrder.filter((branch) => submittable.includes(branch));

  if (parentByBranch[fromBranch] && !executionOrder.includes(fromBranch)) {
    executionOrder.unshift(fromBranch);
  }

  if (executionOrder.length === 0) {
    ui.printStep("No branches to submit.");
    return;
  }

  ui.printInfo(`${ui.styleLabel("Submit base:")} ${ui.styleBranch(fromBranch, "current")}`);
  ui.printStep("Branches to submit:");
  for (const branch of executionOrder) {
    ui.printStep(`- ${branch}`);
  }

  const missingPrs = await findMissingPrs(executionOrder);
  const baseUpdates = await findPrBaseUpdates(executionOrder, parentByBranch, repoRoot);

  if (missingPrs.length > 0) {
    ui.printWarning(
      `Missing PRs for: ${missingPrs.map((branch) => ui.styleBranch(branch)).join(", ")}`
    );
  }
  if (baseUpdates.length > 0) {
    const prefix = opts.dryRun ? "Dry-run: " : "";
    ui.printStep(
      `${prefix}updating ${baseUpdates.length} PR base branch(es) to match current stack parents.`
    );
    for (const update of baseUpdates) {
      ui.printStep(
        `- ${update.branch} PR #${update.prNumber}: ${update.currentBase} -> ${update.expectedBase}`
      );
    }
  }

  if (opts.dryRun) {
    ui.printInfo(ui.styleMuted("Dry-run: skipping push, PR creation, and base updates."));
    return;
  }

  for (const branch of executionOrder) {
    const node = graph.get(branch);
    if (!node) {
      continue;
    }
    ui.printStep(`Pushing ${branch} to origin`);
    await git.pushLease(node.worktreePath, "origin", branch);
  }

  if (missingPrs.length > 0) {
    const shouldCreate = await askYesNo("Create missing PRs now? [y/N] ", opts.yes);
    if (shouldCreate) {
      await createMissingPrs(executionOrder, missingPrs, parentByBranch, repoRoot, graph);
    } else {
      ui.printWarning("Continuing without creating missing PRs.");
    }
  }

  if (baseUpdates.length > 0) {
    await applyPrBaseUpdates(baseUpdates);
  }

  for (const branch of executionOrder) {
    await updateBranchStackDescriptionSafe(executionOrder, branch);
  }

  ui.printStep("Submit complete.");
}
