#!/usr/bin/env bun
import { runAbort } from "./commands/abort";
import { runBranch } from "./commands/branch";
import { runBootstrap } from "./commands/bootstrap";
import { runInit } from "./commands/init";
import { runLink } from "./commands/link";
import { runJump } from "./commands/jump";
import { runResolve } from "./commands/resolve";
import { runSkill } from "./commands/skill";
import { runStatus } from "./commands/status";
import { runRestack } from "./commands/restack";
import { runSubmit } from "./commands/submit";
import { runSync } from "./commands/sync";
import { ConflictError, GwError } from "./lib/errors";
import * as ui from "./lib/ui";

type ParsedArgs =
  | {
      command: "sync" | "resume" | "status" | "restack" | "submit";
      dryRun: boolean;
      yes: boolean;
      fromBranch?: string;
      help?: boolean;
    }
  | {
      command: "init";
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
      noWorktree?: boolean;
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
    }
  | {
      command: "abort";
      rollback?: boolean;
      yes?: boolean;
      help?: boolean;
    }
  | {
      command: "resolve";
      tool?: "claude" | "codex";
      help?: boolean;
    };

function parseArgs(argv: string[]): ParsedArgs {
  const [firstRaw, ...restRaw] = argv;
  if (!firstRaw || firstRaw === "-h" || firstRaw === "--help") {
    return { command: "sync", dryRun: false, yes: false, help: true };
  }

  if (firstRaw === "init") {
    if (restRaw.includes("-h") || restRaw.includes("--help")) {
      return { command: "init", help: true };
    }
    return { command: "init" };
  }

  if (firstRaw === "branch") {
    const [name, ...rest] = restRaw;
    if (!name || name.startsWith("-")) {
      throw new GwError("Usage: gw branch <name> [--from <branch>] [--worktree <path>]");
    }

    let fromBranch: string | undefined;
    let worktreePath: string | undefined;
    let noWorktree = false;

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
      if (arg === "--no-worktree") {
        noWorktree = true;
        continue;
      }
      if (arg === "-h" || arg === "--help") {
        return { command: "branch", name, fromBranch, worktreePath, noWorktree, help: true };
      }
      if (arg.startsWith("-")) {
        throw new GwError(`Unknown option: ${arg}`);
      }
    }

    return { command: "branch", name, fromBranch, worktreePath, noWorktree };
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
        throw new GwError(`Unknown option: ${arg}`);
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
        throw new GwError(`Unknown option: ${arg}`);
      }
    }

    const modeCount = Number(Boolean(parentBranch)) + Number(Boolean(childBranch));
    if (modeCount !== 1) {
      throw new GwError("Usage: gw link [branch] (--parent <parent> | --child <child>)");
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
        throw new GwError(`Unknown option: ${arg}`);
      }
    }
    return { command: "skill", path, codexPath, claudePath };
  }

  if (firstRaw === "abort") {
    let rollback = false;
    let yes = false;
    for (let i = 0; i < restRaw.length; i += 1) {
      const arg = restRaw[i];
      if (arg === "--rollback") {
        rollback = true;
        continue;
      }
      if (arg === "--yes" || arg === "-y") {
        yes = true;
        continue;
      }
      if (arg === "-h" || arg === "--help") {
        return { command: "abort", rollback, yes, help: true };
      }
      if (arg.startsWith("-")) {
        throw new GwError(`Unknown option: ${arg}`);
      }
    }
    return { command: "abort", rollback, yes };
  }

  if (firstRaw === "resolve") {
    let tool: "claude" | "codex" | undefined;
    for (let i = 0; i < restRaw.length; i += 1) {
      const arg = restRaw[i];
      if (arg === "--tool") {
        const val = restRaw[i + 1];
        if (val !== "claude" && val !== "codex") {
          throw new GwError("--tool must be 'claude' or 'codex'");
        }
        tool = val;
        i += 1;
        continue;
      }
      if (arg === "-h" || arg === "--help") {
        return { command: "resolve", tool, help: true };
      }
      if (arg.startsWith("-")) {
        throw new GwError(`Unknown option: ${arg}`);
      }
    }
    return { command: "resolve", tool };
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
        throw new GwError(`Unknown option: ${arg}`);
      }
    }

    if (printOnly && cdCommand) {
      throw new GwError("Use either --print or --cd with 'jump', not both.");
    }

    return { command: "jump", fromBranch, branch, printOnly, cdCommand };
  }

  let command: "sync" | "resume" | "status" | "restack" | "submit" = "sync";
  let rest = restRaw;
  if (firstRaw === "sync" || firstRaw === "resume" || firstRaw === "status" || firstRaw === "restack" || firstRaw === "submit") {
    command = firstRaw;
  } else if (firstRaw.startsWith("-")) {
    rest = [firstRaw, ...restRaw];
  } else {
    throw new GwError(`Unknown command: ${firstRaw}`);
  }

  let dryRun = false;
  let yes = false;
  let fromBranch: string | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }
    if (arg === "--from") {
      fromBranch = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      return { command, dryRun, yes, fromBranch, help: true };
    }
    if (arg.startsWith("-")) {
      throw new GwError(`Unknown option: ${arg}`);
    }
  }

  return { command, dryRun, yes, fromBranch };
}

function printHelp(): void {
  ui.printInfo(`${ui.styleBold("gw")} - stacked PR sync for git worktrees

Usage:
  gw init
  gw sync [--dry-run] [--from <branch>] [--yes]
  gw submit [--dry-run] [--from <branch>] [--yes]
  gw restack [--dry-run] [--from <branch>] [--yes]
  gw resume [--yes]
  gw abort [--rollback] [--yes]
  gw resolve [--tool <claude|codex>]
  gw status [--from <branch>]
  gw jump [branch] [--from <branch>] [--print | --cd]
  gw bootstrap [--from <branch>] [--worktree-root <path>] [--dry-run]
  gw link [branch] (--parent <parent> | --child <child>)
  gw skill [--path <skills-dir>] [--codex-path <skills-dir>] [--claude-path <skills-dir>]
  gw branch <name> [--from <branch>] [--worktree <path>] [--no-worktree]

Commands:
  init      Configure worktree root for the current repository
  sync      Auto-detect related worktrees in your stack, create missing PRs if needed, then rebase descendants in order
  submit    Push current branch and descendants, create/update PRs (no rebase)
  restack   Rebase and push only descendant branches below current (or --from) branch
  resume    Continue a previously failed sync or restack
  abort     Abort a failed sync/restack and clean up state (--rollback resets branches to pre-sync SHAs)
  resolve   Use AI (Claude/Codex) to resolve rebase conflicts
  status    Show detected stack plan and current checkpoint state
  jump      Interactively select a stack branch and print the target path
  bootstrap Seed local worktrees and gw-meta.json from an already-open stacked PR chain
  link      Create or update one parent-child linkage in gw-meta.json
  skill     Install the bundled gw-usage skill for Codex and Claude
  branch    Create a branch from parent and persist stack parent metadata

Options:
  -y, --yes Auto-confirm all prompts (useful for non-interactive/agent use)
  --dry-run Show plan only, do not mutate branches
  --from    Override start branch for stack component detection
  --rollback  For 'abort': reset ALL branches to pre-sync SHAs
  --tool    For 'resolve': specify AI tool (claude or codex)
  --print   For 'jump': print selected worktree path only
  --cd      For 'jump': print a shell-safe 'cd -- <path>' command for eval
  --worktree-root Directory where bootstrap creates missing worktrees
  --no-worktree For 'branch': skip automatic worktree creation even if configured
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

  if (args.command === "abort") {
    await runAbort({ rollback: args.rollback, yes: args.yes });
    return;
  }

  if (args.command === "resolve") {
    await runResolve({ tool: args.tool });
    return;
  }

  if (args.command === "resume") {
    await runSync({ resume: true, yes: args.yes });
    return;
  }

  if (args.command === "status") {
    await runStatus({ fromBranch: args.fromBranch });
    return;
  }

  if (args.command === "restack") {
    await runRestack({ dryRun: args.dryRun, fromBranch: args.fromBranch, yes: args.yes });
    return;
  }

  if (args.command === "submit") {
    await runSubmit({ dryRun: args.dryRun, fromBranch: args.fromBranch, yes: args.yes });
    return;
  }

  if (args.command === "init") {
    await runInit();
    return;
  }

  if (args.command === "branch") {
    await runBranch({
      name: args.name,
      fromBranch: args.fromBranch,
      worktreePath: args.worktreePath,
      noWorktree: args.noWorktree,
    });
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

  await runSync({ dryRun: args.dryRun, fromBranch: args.fromBranch, yes: args.yes });
}

main().catch((err) => {
  if (err instanceof ConflictError) {
    console.error(ui.styleError(`Rebase conflict on ${err.branch}`));
    console.error("");
    console.error("  To resolve manually:");
    console.error(`    1. cd ${err.worktreePath}`);
    console.error("    2. Fix conflicting files, then: git add <files>");
    console.error("    3. git rebase --continue");
    console.error("    4. gw resume");
    console.error("");
    console.error("  To resolve with AI:");
    console.error("    gw resolve");
    console.error("");
    console.error("  To abort:");
    console.error("    gw abort              (abort rebase, keep already-synced branches)");
    console.error("    gw abort --rollback   (abort and reset ALL branches to pre-sync state)");
    process.exit(1);
  }

  const message = err instanceof Error ? err.message : String(err);
  console.error(ui.styleError(message));
  process.exit(1);
});
