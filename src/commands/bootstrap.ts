import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import * as gh from "../lib/gh";
import * as git from "../lib/git";
import * as config from "../lib/config";
import * as metaStore from "../lib/meta";
import { discoverPlan } from "../lib/plan";
import * as ui from "../lib/ui";
import { GwError } from "../lib/errors";

type BootstrapOptions = {
  fromBranch?: string;
  worktreeRoot?: string;
  dryRun?: boolean;
};

type WorktreeAction = {
  branch: string;
  path: string;
  source: "local" | "origin";
};

type BootstrapStack = {
  root: string;
  order: string[];
  parentByBranch: Map<string, string>;
};

export async function runBootstrap(opts: BootstrapOptions): Promise<void> {
  const repoRoot = await git.repoRoot();
  const commonDir = await git.gitCommonDir(repoRoot);
  const fromBranch = opts.fromBranch ?? (await git.currentBranch());

  let resolvedRoot = opts.worktreeRoot;
  if (!resolvedRoot) {
    const repoId = await git.repoIdentifier().catch(() => undefined);
    if (repoId) {
      resolvedRoot = await config.getRepoWorktreeRoot(repoId);
    }
  }
  const worktreeRoot = resolve(
    resolvedRoot ?? join(dirname(repoRoot), `${basename(repoRoot)}-gw-worktrees`)
  );

  await git.fetch(repoRoot, "origin");

  const stack = await discoverBootstrapStack(fromBranch);
  if (stack.parentByBranch.size === 0) {
    throw new GwError(
      `No open stacked PR chain found from '${fromBranch}'. Pass --from <branch> for a branch in the stack.`
    );
  }

  const worktrees = await git.listWorktrees(repoRoot);
  const branchToWorktree = new Map(worktrees.map((wt) => [wt.branch, wt.path]));
  const occupiedPaths = new Set(worktrees.map((wt) => resolve(wt.path)));
  const actions = await planWorktreeActions(
    repoRoot,
    worktreeRoot,
    stack.order,
    branchToWorktree,
    occupiedPaths
  );

  printBootstrapSummary(fromBranch, worktreeRoot, stack, actions, branchToWorktree);

  if (opts.dryRun) {
    ui.printInfo(ui.styleMuted("Dry-run: no worktrees or metadata written."));
    return;
  }

  if (actions.length > 0) {
    await mkdir(worktreeRoot, { recursive: true });
    for (const action of actions) {
      if (action.source === "local") {
        await git.addWorktreeForExistingBranch(repoRoot, action.branch, action.path);
      } else {
        await git.addWorktreeForRemoteBranch(repoRoot, action.branch, "origin", action.path);
      }
      ui.printSuccess(
        `Created worktree for ${ui.styleBranch(action.branch)}: ${ui.stylePath(action.path)}`
      );
    }
  }

  const meta = await metaStore.loadMeta(commonDir);
  for (const [child, parent] of stack.parentByBranch) {
    meta.parentByBranch[child] = parent;
  }
  await metaStore.saveMeta(commonDir, meta);
  ui.printSuccess(`Saved ${stack.parentByBranch.size} parent link(s) to gw-meta.json`);

  const { plan } = await discoverPlan({ fromBranch });
  ui.printPlan(plan);
  ui.printSuccess("Bootstrap complete.");
}

async function planWorktreeActions(
  repoRoot: string,
  worktreeRoot: string,
  orderedBranches: string[],
  branchToWorktree: Map<string, string>,
  occupiedPaths: Set<string>
): Promise<WorktreeAction[]> {
  const actions: WorktreeAction[] = [];

  for (const branch of orderedBranches) {
    if (branchToWorktree.has(branch)) {
      continue;
    }

    const worktreePath = resolve(worktreeRoot, git.sanitizeBranchForPath(branch));
    if (occupiedPaths.has(worktreePath)) {
      throw new GwError(`Worktree path already in use by another branch: ${worktreePath}`);
    }
    if (existsSync(worktreePath)) {
      throw new GwError(`Cannot create worktree for ${branch}; path already exists: ${worktreePath}`);
    }

    const source = (await git.localBranchExists(repoRoot, branch))
      ? "local"
      : (await git.remoteBranchExists(repoRoot, "origin", branch))
        ? "origin"
        : null;
    if (!source) {
      throw new GwError(
        `Branch '${branch}' does not exist locally and origin/${branch} was not found.`
      );
    }

    actions.push({ branch, path: worktreePath, source });
    occupiedPaths.add(worktreePath);
  }

  return actions;
}

function printBootstrapSummary(
  fromBranch: string,
  worktreeRoot: string,
  stack: BootstrapStack,
  actions: WorktreeAction[],
  branchToWorktree: Map<string, string>
): void {
  ui.printInfo(`${ui.styleLabel("From branch:")} ${ui.styleBranch(fromBranch, "current")}`);
  ui.printInfo(`${ui.styleLabel("Detected stack root:")} ${ui.styleBranch(stack.root, "root")}`);
  ui.printInfo(`${ui.styleLabel("Detected stack branches:")} ${stack.order.join(" -> ")}`);
  ui.printInfo(ui.styleLabel("Parent links:"));
  for (const [child, parent] of [...stack.parentByBranch.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    ui.printInfo(`- ${ui.styleBranch(child)} -> ${ui.styleBranch(parent)}`);
  }

  if (actions.length === 0) {
    ui.printInfo("Worktree actions: none (all stack branches already have local worktrees)");
    return;
  }

  ui.printInfo(`${ui.styleLabel("Worktree root:")} ${ui.stylePath(worktreeRoot)}`);
  ui.printInfo(ui.styleLabel("Worktree actions:"));
  for (const action of actions) {
    const existing = branchToWorktree.get(action.branch);
    if (existing) {
      continue;
    }
    ui.printInfo(
      `- create ${ui.stylePath(action.path)} for ${ui.styleBranch(action.branch)} (${action.source})`
    );
  }
}

async function discoverBootstrapStack(fromBranch: string): Promise<BootstrapStack> {
  const parentByBranch = new Map<string, string>();

  let cursor = fromBranch;
  const seenAncestors = new Set<string>();
  while (true) {
    if (seenAncestors.has(cursor)) {
      throw new GwError(`Cycle detected while walking ancestor PR chain at '${cursor}'.`);
    }
    seenAncestors.add(cursor);

    const pr = await gh.viewPrByBranchOptional(cursor);
    if (!pr) {
      break;
    }
    setParentEdge(parentByBranch, cursor, pr.baseRefName);
    cursor = pr.baseRefName;
  }

  cursor = fromBranch;
  const seenDescendants = new Set<string>([cursor]);
  while (true) {
    const children = (await gh.listOpenPrsByBase(cursor)).filter(
      (pr) => pr.headRefName !== cursor
    );
    if (children.length === 0) {
      break;
    }
    if (children.length > 1) {
      throw new GwError(
        `Branch '${cursor}' has multiple open child PRs: ${children
          .map((pr) => pr.headRefName)
          .sort()
          .join(", ")}`
      );
    }

    const child = children[0].headRefName;
    if (seenDescendants.has(child)) {
      throw new GwError(`Cycle detected while walking descendant PR chain at '${child}'.`);
    }
    seenDescendants.add(child);
    setParentEdge(parentByBranch, child, cursor);
    cursor = child;
  }

  const allBranches = new Set<string>([fromBranch]);
  for (const [child, parent] of parentByBranch) {
    allBranches.add(child);
    allBranches.add(parent);
  }

  const roots = [...allBranches].filter((branch) => !parentByBranch.has(branch)).sort();
  if (roots.length !== 1) {
    throw new GwError(
      `Expected exactly one stack root from bootstrap discovery, found ${roots.length}: ${roots.join(", ")}`
    );
  }
  const root = roots[0];

  const childByParent = new Map<string, string>();
  for (const [child, parent] of parentByBranch) {
    if (childByParent.has(parent)) {
      throw new GwError(
        `Branch '${parent}' has multiple children in discovered PR stack. Bootstrap requires a linear stack.`
      );
    }
    childByParent.set(parent, child);
  }

  const order: string[] = [];
  const seenOrder = new Set<string>();
  let branch = root;
  while (branch) {
    if (seenOrder.has(branch)) {
      throw new GwError(`Cycle detected while ordering discovered stack at '${branch}'.`);
    }
    seenOrder.add(branch);
    order.push(branch);
    branch = childByParent.get(branch) ?? "";
  }

  if (order.length !== allBranches.size) {
    throw new GwError(
      `Discovered PR stack is disconnected; expected ${allBranches.size} branches but ordered ${order.length}.`
    );
  }

  return {
    root,
    order,
    parentByBranch,
  };
}

function setParentEdge(parentByBranch: Map<string, string>, child: string, parent: string): void {
  const existing = parentByBranch.get(child);
  if (existing && existing !== parent) {
    throw new GwError(
      `Conflicting discovered parents for '${child}': '${existing}' and '${parent}'.`
    );
  }
  parentByBranch.set(child, parent);
}

