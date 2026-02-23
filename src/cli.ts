#!/usr/bin/env bun
import { runBranch } from "./commands/branch";
import { runBootstrap } from "./commands/bootstrap";
import { runLink } from "./commands/link";
import { runJump } from "./commands/jump";
import { runSkill } from "./commands/skill";
import { runStatus } from "./commands/status";
import { runSync } from "./commands/sync";
import { SprError } from "./lib/errors";
import * as ui from "./lib/ui";

type ParsedArgs =
  | {
      command: "sync" | "resume" | "status";
      dryRun: boolean;
      fromBranch?: string;
      help?: boolean;
    }
  | {
      command: "bootstrap";
      fromBranch?: string;
      worktreeRoot?: string;
      dryRun: boolean;
      help?: boolean;
    }
  | {
      command: "branch";
      name: string;
      fromBranch?: string;
      worktreePath?: string;
      help?: boolean;
    }
  | {
      command: "link";
      branch?: string;
      parentBranch?: string;
      childBranch?: string;
      help?: boolean;
    }
  | {
      command: "skill";
      path?: string;
      codexPath?: string;
      claudePath?: string;
      help?: boolean;
    }
  | {
      command: "jump";
      fromBranch?: string;
      branch?: string;
      printOnly: boolean;
      cdCommand: boolean;
      help?: boolean;
    };

function parseArgs(argv: string[]): ParsedArgs {
  const [firstRaw, ...restRaw] = argv;
  if (!firstRaw || firstRaw === "-h" || firstRaw === "--help") {
    return { command: "sync", dryRun: false, help: true };
  }

  if (firstRaw === "branch") {
    const [name, ...rest] = restRaw;
    if (!name || name.startsWith("-")) {
      throw new SprError("Usage: spr branch <name> [--from <branch>] [--worktree <path>]");
    }

    let fromBranch: string | undefined;
    let worktreePath: string | undefined;

    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (arg === "--from") {
        fromBranch = rest[i + 1];
        i += 1;
        continue;
      }
      if (arg === "--worktree") {
        worktreePath = rest[i + 1];
        i += 1;
        continue;
      }
      if (arg === "-h" || arg === "--help") {
        return { command: "branch", name, fromBranch, worktreePath, help: true };
      }
      if (arg.startsWith("-")) {
        throw new SprError(`Unknown option: ${arg}`);
      }
    }

    return { command: "branch", name, fromBranch, worktreePath };
  }

  if (firstRaw === "bootstrap") {
    let fromBranch: string | undefined;
    let worktreeRoot: string | undefined;
    let dryRun = false;

    for (let i = 0; i < restRaw.length; i += 1) {
      const arg = restRaw[i];
      if (arg === "--dry-run") {
        dryRun = true;
        continue;
      }
      if (arg === "--from") {
        fromBranch = restRaw[i + 1];
        i += 1;
        continue;
      }
      if (arg === "--worktree-root") {
        worktreeRoot = restRaw[i + 1];
        i += 1;
        continue;
      }
      if (arg === "-h" || arg === "--help") {
        return { command: "bootstrap", fromBranch, worktreeRoot, dryRun, help: true };
      }
      if (arg.startsWith("-")) {
        throw new SprError(`Unknown option: ${arg}`);
      }
    }

    return { command: "bootstrap", fromBranch, worktreeRoot, dryRun };
  }

  if (firstRaw === "link") {
    const [maybeBranch, ...tail] = restRaw;
    const hasPositionalBranch = Boolean(maybeBranch) && !maybeBranch!.startsWith("-");
    const branch = hasPositionalBranch ? maybeBranch : undefined;
    const rest = hasPositionalBranch ? tail : restRaw;

    let parentBranch: string | undefined;
    let childBranch: string | undefined;

    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (arg === "--parent") {
        parentBranch = rest[i + 1];
        i += 1;
        continue;
      }
      if (arg === "--child") {
        childBranch = rest[i + 1];
        i += 1;
        continue;
      }
      if (arg === "-h" || arg === "--help") {
        return { command: "link", branch, parentBranch, childBranch, help: true };
      }
      if (arg.startsWith("-")) {
        throw new SprError(`Unknown option: ${arg}`);
      }
    }

    const modeCount = Number(Boolean(parentBranch)) + Number(Boolean(childBranch));
    if (modeCount !== 1) {
      throw new SprError("Usage: spr link [branch] (--parent <parent> | --child <child>)");
    }
    return { command: "link", branch, parentBranch, childBranch };
  }

  if (firstRaw === "skill") {
    let path: string | undefined;
    let codexPath: string | undefined;
    let claudePath: string | undefined;
    for (let i = 0; i < restRaw.length; i += 1) {
      const arg = restRaw[i];
      if (arg === "--path") {
        path = restRaw[i + 1];
        i += 1;
        continue;
      }
      if (arg === "--codex-path") {
        codexPath = restRaw[i + 1];
        i += 1;
        continue;
      }
      if (arg === "--claude-path") {
        claudePath = restRaw[i + 1];
        i += 1;
        continue;
      }
      if (arg === "-h" || arg === "--help") {
        return { command: "skill", path, codexPath, claudePath, help: true };
      }
      if (arg.startsWith("-")) {
        throw new SprError(`Unknown option: ${arg}`);
      }
    }
    return { command: "skill", path, codexPath, claudePath };
  }

  if (firstRaw === "jump") {
    const [maybeBranch, ...tail] = restRaw;
    const hasPositionalBranch = Boolean(maybeBranch) && !maybeBranch!.startsWith("-");
    const branch = hasPositionalBranch ? maybeBranch : undefined;
    const rest = hasPositionalBranch ? tail : restRaw;

    let fromBranch: string | undefined;
    let printOnly = false;
    let cdCommand = false;

    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (arg === "--from") {
        fromBranch = rest[i + 1];
        i += 1;
        continue;
      }
      if (arg === "--print") {
        printOnly = true;
        continue;
      }
      if (arg === "--cd") {
        cdCommand = true;
        continue;
      }
      if (arg === "-h" || arg === "--help") {
        return { command: "jump", fromBranch, branch, printOnly, cdCommand, help: true };
      }
      if (arg.startsWith("-")) {
        throw new SprError(`Unknown option: ${arg}`);
      }
    }

    if (printOnly && cdCommand) {
      throw new SprError("Use either --print or --cd with 'jump', not both.");
    }

    return { command: "jump", fromBranch, branch, printOnly, cdCommand };
  }

  let command: "sync" | "resume" | "status" = "sync";
  let rest = restRaw;
  if (firstRaw === "sync" || firstRaw === "resume" || firstRaw === "status") {
    command = firstRaw;
  } else if (firstRaw.startsWith("-")) {
    rest = [firstRaw, ...restRaw];
  } else {
    throw new SprError(`Unknown command: ${firstRaw}`);
  }

  let dryRun = false;
  let fromBranch: string | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--from") {
      fromBranch = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      return { command, dryRun, fromBranch, help: true };
    }
    if (arg.startsWith("-")) {
      throw new SprError(`Unknown option: ${arg}`);
    }
  }

  return { command, dryRun, fromBranch };
}

function printHelp(): void {
  ui.printInfo(`${ui.styleBold("spr")} - stacked PR sync for git worktrees

Usage:
  spr sync [--dry-run] [--from <branch>]
  spr resume
  spr status [--from <branch>]
  spr jump [branch] [--from <branch>] [--print | --cd]
  spr bootstrap [--from <branch>] [--worktree-root <path>] [--dry-run]
  spr link [branch] (--parent <parent> | --child <child>)
  spr skill [--path <skills-dir>] [--codex-path <skills-dir>] [--claude-path <skills-dir>]
  spr branch <name> [--from <branch>] [--worktree <path>]

Commands:
  sync      Auto-detect related worktrees in your stack, create missing PRs if needed, then rebase descendants in order
  resume    Continue a previously failed sync
  status    Show detected stack plan and current checkpoint state
  jump      Interactively select a stack branch and print the target path
  bootstrap Seed local worktrees and spr-meta.json from an already-open stacked PR chain
  link      Create or update one parent-child linkage in spr-meta.json
  skill     Install the bundled spr-usage skill for Codex and Claude
  branch    Create a branch from parent and persist stack parent metadata

Options:
  --dry-run Show plan only, do not mutate branches
  --from    Override start branch for stack component detection
  --print   For 'jump': print selected worktree path only
  --cd      For 'jump': print a shell-safe 'cd -- <path>' command for eval
  --worktree-root Directory where bootstrap creates missing worktrees
  --parent  For 'link': treat [branch] (or current branch) as child and link it to this parent
  --child   For 'link': treat [branch] (or current branch) as parent and link this child to it
  --path    For 'skill': install into one skills root directory
  --codex-path  For 'skill': override Codex skills root (default: $CODEX_HOME/skills or ~/.codex/skills)
  --claude-path For 'skill': override Claude skills root (default: ~/.claude/skills)
`);
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (args.command === "resume") {
    await runSync({ resume: true });
    return;
  }

  if (args.command === "status") {
    await runStatus({ fromBranch: args.fromBranch });
    return;
  }

  if (args.command === "branch") {
    await runBranch({ name: args.name, fromBranch: args.fromBranch, worktreePath: args.worktreePath });
    return;
  }

  if (args.command === "bootstrap") {
    await runBootstrap({
      fromBranch: args.fromBranch,
      worktreeRoot: args.worktreeRoot,
      dryRun: args.dryRun,
    });
    return;
  }

  if (args.command === "link") {
    await runLink({
      branch: args.branch,
      parentBranch: args.parentBranch,
      childBranch: args.childBranch,
    });
    return;
  }

  if (args.command === "skill") {
    await runSkill({ path: args.path, codexPath: args.codexPath, claudePath: args.claudePath });
    return;
  }

  if (args.command === "jump") {
    await runJump({
      fromBranch: args.fromBranch,
      branch: args.branch,
      printOnly: args.printOnly,
      cdCommand: args.cdCommand,
    });
    return;
  }

  await runSync({ dryRun: args.dryRun, fromBranch: args.fromBranch });
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(ui.styleError(message));
  process.exit(1);
});
