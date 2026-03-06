import type { StackNode, SyncPlan, Worktree } from "../types";
import { GwError } from "./errors";

export function buildGraph(
  worktrees: Worktree[],
  parentByBranch: Record<string, string>
): Map<string, StackNode> {
  const graph = new Map<string, StackNode>();
  const localBranches = new Set(worktrees.map((w) => w.branch));

  for (const wt of worktrees) {
    const parent = parentByBranch[wt.branch];
    graph.set(wt.branch, {
      branch: wt.branch,
      worktreePath: wt.path,
      parent: parent && localBranches.has(parent) ? parent : undefined,
      children: [],
    });
  }

  for (const node of graph.values()) {
    if (node.parent) {
      graph.get(node.parent)?.children.push(node.branch);
    }
  }

  for (const node of graph.values()) {
    node.children.sort();
  }

  return graph;
}

export function connectedComponent(graph: Map<string, StackNode>, fromBranch: string): Set<string> {
  if (!graph.has(fromBranch)) {
    throw new GwError(
      `Current branch '${fromBranch}' is not in local worktree graph. Ensure it has a local worktree.`
    );
  }

  const seen = new Set<string>();
  const queue: string[] = [fromBranch];

  while (queue.length > 0) {
    const branch = queue.shift()!;
    if (seen.has(branch)) {
      continue;
    }
    seen.add(branch);

    const node = graph.get(branch)!;
    if (node.parent && !seen.has(node.parent)) {
      queue.push(node.parent);
    }
    for (const child of node.children) {
      if (!seen.has(child)) {
        queue.push(child);
      }
    }
  }

  return seen;
}

export function collectDescendants(
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

export function makePlan(graph: Map<string, StackNode>, component: Set<string>): SyncPlan {
  const inComp = (branch: string) => component.has(branch);
  const compNodes = [...component].sort();

  const roots = compNodes.filter((branch) => {
    const parent = graph.get(branch)?.parent;
    return !parent || !inComp(parent);
  });

  if (roots.length !== 1) {
    throw new GwError(`Expected exactly 1 stack root, found ${roots.length}: ${roots.join(", ")}`);
  }

  const root = roots[0];
  const indegree = new Map<string, number>();
  for (const branch of compNodes) {
    indegree.set(branch, 0);
  }
  for (const branch of compNodes) {
    const node = graph.get(branch)!;
    for (const child of node.children) {
      if (inComp(child)) {
        indegree.set(child, (indegree.get(child) ?? 0) + 1);
      }
    }
  }

  const queue = compNodes.filter((b) => (indegree.get(b) ?? 0) === 0).sort();
  const topo: string[] = [];

  while (queue.length > 0) {
    const branch = queue.shift()!;
    topo.push(branch);
    for (const child of graph.get(branch)!.children) {
      if (!inComp(child)) {
        continue;
      }
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) {
        queue.push(child);
        queue.sort();
      }
    }
  }

  if (topo.length !== compNodes.length) {
    throw new GwError("Cycle detected in stack graph; cannot compute rebase order.");
  }

  return {
    root,
    allBranches: topo,
    rebaseOrder: topo.filter((b) => b !== root),
  };
}
