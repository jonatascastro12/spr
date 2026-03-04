# GW Plan

## Goal
Build a Bun-based CLI (`gw`) to manage stacked pull requests across Git worktrees, with Graphite-like ergonomics but worktree-native behavior.

Primary outcome:
- If a base PR branch changes, one command should rebase and push the rest of the stack in order, even when each branch lives in a different worktree.

## Design Principles
- Auto-detect, do not require `--all-worktrees`.
- Depend only on `git` and `gh` CLIs.
- Be safe by default (`--force-with-lease`, dirty-tree stash prompt, stop on conflict).
- Keep state resumable and inspectable.
- Prefer deterministic behavior over magic.

## Scope
### In scope
- Local stack discovery from worktrees + persisted parent metadata.
- Ordered rebasing of descendant branches.
- One-command sync for the connected stack.
- Resume failed syncs from checkpoint.
- Dry-run preview.
- Creating stacked branches with parent linkage.
- Prompted creation of missing PRs during sync.

### Out of scope (initially)
- Auto-squash / merge queue integration.
- Cross-repo stacks.
- Background daemon.

## Core UX
### Commands
- `gw sync`
  - Auto-detect all local worktrees.
  - Fast-forward the stack root branch from `origin/<root>` before rebasing descendants.
  - Auto-seed missing `gw-meta.json` parent links from open PR base refs before planning.
  - Detect ancestor branches whose PRs are closed-but-merged (including merge-queue close behavior) and collapse them out of the stack.
  - Update open PR base refs to match the resolved stack parent graph.
  - Discover stack connected to current branch.
  - Prompt to create missing PRs in stack order; continue sync if creation is declined.
  - Rebase descendants in topological order.
  - Push each updated branch with `--force-with-lease`.

- `gw sync --dry-run`
  - Compute and print plan only.
  - No mutation.

- `gw sync --from <branch>`
  - Optional branch override when not invoked from stack worktree.

- `gw restack [--dry-run] [--from <branch>]`
  - Rebase and push only descendants of current branch (or `--from`) in stack order.
  - Skip PR creation/base-update logic; this is a pure stack rebase operation.

- `gw resume`
  - Continue from last failed step using saved state.

- `gw status`
  - Show detected stack plan and current checkpoint state.

- `gw jump [branch] [--from <branch>] [--print | --cd]`
  - Interactively select a branch from the detected stack with arrow keys and resolve its worktree path.
  - Optional positional `branch` jumps directly without interactive selection.
  - `--print` returns only the selected worktree path for scripts.
  - `--cd` returns a shell-safe `cd -- <path>` command for `eval`.

- `gw bootstrap [--from <branch>] [--worktree-root <path>] [--dry-run]`
  - Discover an already-open stacked PR chain from GitHub starting at `--from` (or current branch).
  - Create missing local worktrees for stack branches from local or `origin/<branch>`.
  - Persist discovered `child -> parent` metadata in `gw-meta.json`.

- `gw link [branch] (--parent <parent> | --child <child>)`
  - Create or update one parent linkage in `gw-meta.json`.
  - If `branch` is omitted, uses current branch.
  - Works even before PRs are opened (manual metadata seeding).

- `gw skill [--path <skills-dir>] [--codex-path <skills-dir>] [--claude-path <skills-dir>]`
  - Install the bundled `gw-usage` skill for both Codex and Claude.
  - Defaults to `$CODEX_HOME/skills` (or `~/.codex/skills`) and `~/.claude/skills`.

- `gw branch <name> [--from <branch>] [--worktree <path>]`
  - Create a branch from a parent branch.
  - Optionally create the branch in a dedicated worktree.
  - Persist parent linkage for stack planning.

## Auto-Detection Model
1. Enumerate worktrees using `git worktree list --porcelain`.
2. Load parent metadata from `gw-meta.json` in git common dir.
3. Build local graph from worktree branches + `parentByBranch`.
4. Find connected component containing current (or `--from`) branch.
5. Compute root and topological order.

## Execution Semantics
- Root branch is not rebased by `gw sync`, but it is fast-forwarded from `origin/<root>` before descendant rebases.
- If `--from` is a merged/isolated branch, `gw sync` may pivot planning to a local downstream open-PR branch so stack updates still apply.
- If stack branches are missing PRs, `gw sync` prompts to create them and still proceeds when declined.
- Missing-PR creation flow:
  1. `git -C <wt> push -u origin <branch>`
  2. `gh pr create --head <branch> --base <parentOrDefaultBase> --fill`
  3. `gh api --method PATCH repos/<owner>/<repo>/pulls/<number> -f body=<updatedBodyWithStackSection>`
- Each descendant executes:
  1. `git -C <wt> fetch origin`
  2. `git -C <wt> rebase <parentBranch>`
  3. `git -C <wt> push --force-with-lease origin <branch>`
  4. Refresh the pushed branch PR body stack section.

## Safety and Failure Handling
- If any involved worktree in the connected stack component is dirty, prompt to stash changes before mutating operations; abort if declined.
- After auto-stash, prompt whether to re-apply stashes after a successful `sync`/`resume` run.
- Stop at first conflict.
- Persist checkpoint after each successful branch.
- For closed PRs, only treat them as merged when merge evidence exists on base branch (head commit ancestry or a `(#PR_NUMBER)` commit marker).
- On failure, provide direct recovery hint:
  - `git -C <worktree> rebase --continue`
  - then `gw resume`.

## Persistent Files
Stored under git common dir (`git rev-parse --git-common-dir`):
- `gw-state.json`
  - In-progress sync checkpoint for resume.
- `gw-meta.json`
  - Persisted stack parent linkage (`parentByBranch`), written by `gw branch`.

(Initial design keeps only one active checkpoint file.)

## Data Shapes
```ts
type Worktree = {
  path: string;
  branch: string;
  headSha: string;
};

type StackNode = {
  branch: string;
  worktreePath: string;
  parent?: string;
  children: string[];
};

type SyncPlan = {
  root: string;
  allBranches: string[];
  rebaseOrder: string[];
};

type SyncState = {
  version: 1;
  repoRoot: string;
  startedAt: string;
  command: "sync";
  rootBranch: string;
  stackBranches: string[];
  executionOrder: string[];
  completed: string[];
  failedAt?: string;
  lastError?: string;
  dryRun: boolean;
};

type GwMeta = {
  version: 1;
  parentByBranch: Record<string, string>;
};
```

## Module Layout
- `src/cli.ts`
  - CLI parsing and command dispatch.
- `src/commands/sync.ts`
  - Orchestration of planning, execution, and resume.
- `src/commands/status.ts`
  - Displays stack plan and checkpoint summary.
- `src/commands/jump.ts`
  - Interactive stack worktree navigation and shell handoff.
- `src/commands/bootstrap.ts`
  - Discovers existing PR stacks and initializes worktrees + metadata.
- `src/commands/link.ts`
  - Manually creates/updates a single parent-child metadata link.
- `src/commands/skill.ts`
  - Installs the bundled `gw-usage` Codex skill.
- `src/commands/branch.ts`
  - Creates stacked branches and stores parent metadata.
- `src/lib/git.ts`
  - Git wrappers (`worktree list`, `branch/worktree create`, `rebase`, `push`, cleanliness + stash helpers).
- `src/lib/gh.ts`
  - GitHub PR lookup/create wrappers.
- `src/lib/plan.ts`
  - Shared stack discovery logic.
- `src/lib/meta.ts`
  - `gw-meta.json` read/write helpers.
- `src/lib/stack.ts`
  - Graph build, connected component, topo planning.
- `src/lib/state.ts`
  - Checkpoint persistence.
- `src/lib/ui.ts`
  - Plan/step output formatting.
- `src/lib/errors.ts`
  - Typed errors.

## Algorithm Notes
- Graph roots are component nodes with no parent inside the same component.
- Expect exactly one root per component; otherwise error.
- Topological ordering should be stable and deterministic (sorted queue tie-break).

## Implementation Roadmap
1. Operational hardening
- Better conflict diagnostics.
- Retry/failure classification.
- Optional non-interactive autostash flag.

2. Usability
- Better output formatting and timing info.
- Non-interactive flags for PR creation prompt.

3. Advanced workflows
- Stack surgery commands (reparent/reorder).
- Optional CI/merge-queue integration.

## Open Questions
- Should we support partial sync (`--to` / `--only`) for large stacks?
- Should checkpoints retain history (multiple runs) instead of single state file?
- Should `gw branch` auto-push the branch immediately when created?

## Non-Goals for now
- Replacing full Graphite feature set.
- Managing code review lifecycle.
- Global branch metadata storage outside repository context.
