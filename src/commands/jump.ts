import { emitKeypressEvents } from "node:readline";
import { discoverPlan } from "../lib/plan";
import { GwError } from "../lib/errors";
import * as ui from "../lib/ui";

type JumpOptions = {
  fromBranch?: string;
  branch?: string;
  printOnly?: boolean;
  cdCommand?: boolean;
};

type StackWorktree = {
  branch: string;
  path: string;
  tags: string[];
};

export async function runJump(opts: JumpOptions = {}): Promise<void> {
  const { plan, graph, fromBranch } = await discoverPlan({ fromBranch: opts.fromBranch });
  const rebaseIndex = new Map(plan.rebaseOrder.map((branch, idx) => [branch, idx + 1]));

  const stackWorktrees: StackWorktree[] = plan.allBranches.map((branch) => {
    const node = graph.get(branch);
    if (!node) {
      throw new GwError(`Branch ${branch} is not available in current local worktrees.`);
    }

    const tags: string[] = [];
    if (branch === plan.root) {
      tags.push("root");
    }
    if (branch === fromBranch) {
      tags.push("current");
    }
    const step = rebaseIndex.get(branch);
    if (step) {
      tags.push(`rebase:${step}`);
    }

    return {
      branch,
      path: node.worktreePath,
      tags,
    };
  });

  const selected =
    opts.branch !== undefined
      ? selectByBranch(stackWorktrees, opts.branch)
      : opts.printOnly || opts.cdCommand
        ? selectByBranch(stackWorktrees, fromBranch)
      : await selectInteractively(stackWorktrees);

  if (opts.printOnly) {
    ui.printInfo(selected.path);
    return;
  }

  if (opts.cdCommand) {
    ui.printInfo(`cd -- ${shellQuote(selected.path)}`);
    return;
  }

  ui.printSuccess(`Selected ${ui.stylePath(selected.path)}`);
  ui.printInfo(ui.styleMuted(`Run: cd -- ${shellQuote(selected.path)}`));
  ui.printInfo(ui.styleMuted("For direct jump in current shell: eval \"$(gw jump --cd)\""));
}

function selectByBranch(entries: StackWorktree[], branch: string): StackWorktree {
  const selected = entries.find((entry) => entry.branch === branch);
  if (selected) {
    return selected;
  }

  throw new GwError(
    `Branch '${branch}' is not in the detected stack. Available: ${entries
      .map((entry) => entry.branch)
      .join(", ")}`
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function selectInteractively(entries: StackWorktree[]): Promise<StackWorktree> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new GwError("Interactive jump requires a TTY. Use: gw jump <branch> --print");
  }
  if (entries.length === 0) {
    throw new GwError("No branches found in the detected stack.");
  }

  const stdin = process.stdin;
  const stdout = process.stdout;
  const currentIndex = entries.findIndex((entry) => entry.tags.includes("current"));
  let selectedIndex = currentIndex >= 0 ? currentIndex : 0;
  let renderedLines = 0;
  const wasRawMode = Boolean((stdin as { isRaw?: boolean }).isRaw);

  emitKeypressEvents(stdin);
  stdin.setRawMode?.(true);
  stdin.resume();
  stdout.write("\u001b[?25l");

  function render(): void {
    const lines: string[] = [];
    lines.push(ui.styleLabel("Select worktree from stack (↑/↓, Enter to select, q to cancel):"));
    for (let i = 0; i < entries.length; i += 1) {
      const item = entries[i];
      const isSelected = i === selectedIndex;
      const branchRole = item.tags.includes("root")
        ? "root"
        : item.tags.includes("current")
          ? "current"
          : "default";
      const branch = ui.styleBranch(item.branch, branchRole);
      const tags = item.tags.length > 0 ? ` ${ui.styleMuted(`[${item.tags.join(", ")}]`)}` : "";
      const prefix = isSelected ? ui.styleLabel(">") : " ";
      const row = `${prefix} ${i + 1}. ${branch}${tags}`;
      lines.push(isSelected ? ui.styleBold(row) : row);
      lines.push(`    ${ui.stylePath(item.path)}`);
    }

    if (renderedLines > 0) {
      stdout.write(`\u001b[${renderedLines}F`);
      stdout.write("\u001b[J");
    }
    stdout.write(`${lines.join("\n")}\n`);
    renderedLines = lines.length;
  }

  return await new Promise<StackWorktree>((resolve, reject) => {
    function cleanup(): void {
      stdin.removeListener("keypress", onKey);
      stdin.setRawMode?.(wasRawMode);
      stdout.write("\u001b[?25h");
      if (renderedLines > 0) {
        stdout.write(`\u001b[${renderedLines}F`);
        stdout.write("\u001b[J");
      }
    }

    function done(error?: Error): void {
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      resolve(entries[selectedIndex]);
    }

    function onKey(
      _char: string,
      key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }
    ): void {
      if (key.name === "up" || key.name === "k") {
        selectedIndex = (selectedIndex - 1 + entries.length) % entries.length;
        render();
        return;
      }

      if (key.name === "down" || key.name === "j") {
        selectedIndex = (selectedIndex + 1) % entries.length;
        render();
        return;
      }

      if (key.name === "return") {
        done();
        return;
      }

      if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) {
        done(new GwError("Jump cancelled."));
      }
    }

    stdin.on("keypress", onKey);
    render();
  });
}
