import * as git from "./git";
import * as metaStore from "./meta";
import * as stack from "./stack";
import type { StackNode, SyncPlan } from "../types";

export type DiscoveredPlan = {
  repoRoot: string;
  commonDir: string;
  fromBranch: string;
  graph: Map<string, StackNode>;
  plan: SyncPlan;
  parentByBranch: Record<string, string>;
};

export async function discoverPlan(
  opts: {
    fromBranch?: string;
    parentByBranchOverride?: Record<string, string>;
    parentByBranchReplace?: Record<string, string>;
  } = {}
): Promise<DiscoveredPlan> {
  const repoRoot = await git.repoRoot();
  const commonDir = await git.gitCommonDir(repoRoot);
  const fromBranch = opts.fromBranch ?? (await git.currentBranch());

  const worktrees = await git.listWorktrees(repoRoot);
  const meta = await metaStore.loadMeta(commonDir);
  const parentByBranch =
    opts.parentByBranchReplace ?? {
      ...meta.parentByBranch,
      ...(opts.parentByBranchOverride ?? {}),
    };
  const graph = stack.buildGraph(worktrees, parentByBranch);
  const component = stack.connectedComponent(graph, fromBranch);
  const plan = stack.makePlan(graph, component);

  return {
    repoRoot,
    commonDir,
    fromBranch,
    graph,
    plan,
    parentByBranch,
  };
}
