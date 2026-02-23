import type { StackNode, SyncPlan } from "../types";

const supportsColor =
  Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";

const ansi = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
} as const;

function paint(text: string, color: keyof typeof ansi): string {
  if (!supportsColor) {
    return text;
  }
  return `${ansi[color]}${text}${ansi.reset}`;
}

export function styleLabel(text: string): string {
  return paint(text, "cyan");
}

export function styleBold(text: string): string {
  return paint(text, "bold");
}

export function styleMuted(text: string): string {
  return paint(text, "dim");
}

export function styleBranch(branch: string, role: "default" | "root" | "current" = "default"): string {
  if (role === "root") {
    return paint(branch, "green");
  }
  if (role === "current") {
    return paint(branch, "yellow");
  }
  return paint(branch, "magenta");
}

export function stylePath(path: string): string {
  return paint(path, "blue");
}

export function styleWarning(text: string): string {
  return paint(text, "yellow");
}

export function styleError(text: string): string {
  return paint(text, "red");
}

export function styleSuccess(text: string): string {
  return paint(text, "green");
}

export function printInfo(message: string): void {
  console.log(message);
}

export function printWarning(message: string): void {
  console.log(styleWarning(message));
}

export function printSuccess(message: string): void {
  console.log(styleSuccess(message));
}

export function printPlan(plan: SyncPlan): void {
  printStackRoot(plan);
  console.log(`${styleLabel("Stack branches:")} ${plan.allBranches.join(" -> ")}`);

  if (plan.rebaseOrder.length === 0) {
    console.log("No descendant branches to rebase.");
    return;
  }

  console.log(styleLabel("Rebase execution order:"));
  for (const branch of plan.rebaseOrder) {
    console.log(`- ${styleBranch(branch)}`);
  }
}

export function printStackRoot(plan: SyncPlan): void {
  console.log(`${styleLabel("Stack root:")} ${styleBranch(plan.root, "root")}`);
}

export function printSyncHeader(): void {
  console.log(styleBold("Syncing stacked PRs across related worktrees..."));
}

export function printStep(message: string): void {
  if (message.startsWith("Warning:")) {
    printWarning(message);
    return;
  }
  if (message.startsWith("Dry-run:") || message.startsWith("- ")) {
    printInfo(styleMuted(message));
    return;
  }
  printInfo(message);
}

export function printStatusTree(
  graph: Map<string, StackNode>,
  plan: SyncPlan,
  opts: { fromBranch: string }
): void {
  const inPlan = new Set(plan.allBranches);
  const rebaseIndex = new Map(plan.rebaseOrder.map((branch, idx) => [branch, idx + 1]));
  const rootNode = graph.get(plan.root);
  if (!rootNode) {
    return;
  }

  console.log(styleLabel("Stack tree:"));
  console.log(`*-- ${formatBranch(rootNode.branch)}`);
  const rootChildren = rootNode.children.filter((child) => inPlan.has(child)).sort();
  for (let i = 0; i < rootChildren.length; i += 1) {
    const child = rootChildren[i];
    const childIsLast = i === rootChildren.length - 1;
    printBranchLine(child, "", childIsLast);
  }

  function printBranchLine(branch: string, prefix: string, isLast: boolean): void {
    const node = graph.get(branch);
    if (!node) {
      return;
    }

    const connector = isLast ? "`-- " : "|-- ";
    const nextPrefix = `${prefix}${isLast ? "    " : "|   "}`;
    console.log(`${prefix}${connector}${formatBranch(branch)}`);

    const children = node.children.filter((child) => inPlan.has(child)).sort();
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      const childIsLast = i === children.length - 1;
      printBranchLine(child, `${nextPrefix}`, childIsLast);
    }
  }

  function formatBranch(branch: string): string {
    const tags: string[] = [];
    if (branch === plan.root) {
      tags.push("root");
    }
    if (branch === opts.fromBranch) {
      tags.push("current");
    }
    const step = rebaseIndex.get(branch);
    if (step) {
      tags.push(`rebase:${step}`);
    }

    let name = branch;
    if (branch === plan.root) {
      name = styleBranch(name, "root");
    } else if (branch === opts.fromBranch) {
      name = styleBranch(name, "current");
    } else {
      name = styleBranch(name);
    }

    if (tags.length === 0) {
      return name;
    }

    return `${name} ${styleMuted(`[${tags.join(", ")}]`)}`;
  }
}
