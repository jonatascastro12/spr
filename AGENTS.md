# AGENTS.md

This file documents architectural decisions and operating rules for contributors working on `gw`.

## Purpose
`gw` manages stacked branches/PRs across Git worktrees with deterministic, low-surprise behavior.

## Hard Decisions (Do Not Revert Without Discussion)
1. Stack discovery is metadata-first, not PR-first.
- Source of truth for parent linkage is `gw-meta.json` in git common dir.
- `gw branch` must persist `child -> parent` linkage.
- Open PRs are optional for planning; required only for PR-specific operations.

2. Worktree scope is auto-detected.
- No `--all-worktrees` flag.
- Commands discover all local worktrees, then operate only on the connected component from current branch (or `--from`).

3. Sync behavior is ordered and safe.
- Rebase order is topological from root descendants.
- Use `git push --force-with-lease` after rebase.
- Abort on first conflict and persist checkpoint.

4. Missing PRs are handled in `sync`.
- If PRs are missing, prompt user to create them.
- Creation order must follow stack order.

5. PR creation requires remote branch first.
- Always push branch to `origin` before `gh pr create`.
- This avoids GraphQL errors (`Head sha can't be blank`, `Head ref must be a branch`).

## Command Semantics
- `gw branch <name> [--from <branch>] [--worktree <path>]`
  - Creates branch/worktree and records parent linkage in `gw-meta.json`.

- `gw status [--from <branch>]`
  - Prints detected stack plan and checkpoint summary.

- `gw jump [branch] [--from <branch>] [--print | --cd]`
  - Interactively selects a branch from the detected stack with arrow keys and resolves its worktree path.
  - Optional positional `branch` skips interactive prompt.
  - `--print` outputs only the selected worktree path.
  - `--cd` outputs a shell-safe `cd -- <path>` command for `eval`.

- `gw bootstrap [--from <branch>] [--worktree-root <path>] [--dry-run]`
  - Discovers an already-open PR stack from GitHub, creates missing local worktrees, and persists parent linkage into `gw-meta.json`.

- `gw link [branch] (--parent <parent> | --child <child>)`
  - Manually writes one `child -> parent` linkage in `gw-meta.json` (creates file automatically if missing).
  - If `branch` is omitted, uses current branch.

- `gw skill [--path <skills-dir>] [--codex-path <skills-dir>] [--claude-path <skills-dir>]`
  - Installs the bundled `gw-usage` skill for Codex (`$CODEX_HOME/skills` or `~/.codex/skills`) and Claude (`~/.claude/skills`).

- `gw sync [--dry-run] [--from <branch>]`
  - Auto-seeds missing parent links from open PR base refs, detects closed-but-merged ancestor PRs (merge queue), rewrites parent links to bypass merged branches, updates open PR base refs to match the resolved stack, then optionally creates missing PRs, rebases descendants in order, and pushes updates.

- `gw resume`
  - Continues failed sync from `gw-state.json`.

## Persistence Contract
Stored under git common dir (`git rev-parse --git-common-dir`):
- `gw-meta.json`: durable parent graph (`parentByBranch`).
- `gw-state.json`: in-progress sync checkpoint only.

If changing these schemas, include migration or backward-compat read logic.

## Safety Rules
- Never run mutating operations when any involved worktree is dirty; prompt user to stash first and abort if declined.
- Keep `--dry-run` side-effect free.
- Stop on first rebase conflict; print direct recovery path.
- Never replace `--force-with-lease` with `--force`.

## Determinism Rules
- Topological sort must be stable (explicit tie-break sorting).
- Error messages should include branch + worktree path where applicable.
- Avoid implicit behavior that depends on non-deterministic command output ordering.

## Known Pitfalls (Already Hit)
1. Running CLI outside a git repo
- `git rev-parse --show-toplevel` fails. Ensure commands run within repo/worktree.

2. Creating PRs for local-only branches
- `gh pr create` fails unless branch is pushed first.

3. Treating root/default branch as a PR candidate
- Root branch may not need PR creation; only branches with recorded parents should be PR candidates in sync bootstrap.

## Test Checklist for Changes
1. `gw status` prints expected stack for a 3-branch worktree stack.
2. `gw sync --dry-run` prints plan and performs no writes.
3. `gw sync` with missing PRs:
- prompts once
- on `y`, pushes + creates PRs in order
- then rebases/pushes descendants
4. Inject a conflict and verify `gw-state.json` supports `gw resume`.
5. Validate behavior with no checkpoint (`resume` should fail clearly).
6. Validate dirty-worktree flow:
- `gw sync`/`gw resume` prompts to stash when uncommitted changes are present
- on `y`, stash is created and command proceeds
- on `n`, command aborts with a clear message
7. Validate merge-queue closed PR handling:
- if a parent PR is `CLOSED` but merged into base branch, `gw sync` rewrites child base to the merged PR base and removes merged branch from stack metadata
8. Validate jump navigation:
- `gw jump` shows arrow-key interactive selection and returns selected worktree path
- `gw jump <branch> --print` prints only worktree path for that branch
- `gw jump --cd` prints a shell-safe `cd` command

## Coding Rules
- Keep modules small and single-purpose (`git`, `gh`, `plan`, `stack`, `state`, `meta`, `commands/*`).
- Reuse shared plan discovery path; avoid duplicated graph logic in commands.
- Prefer explicit typed errors for user-facing failures.
- Update `PLAN.md` and `README.md` whenever command semantics or persistence change.
