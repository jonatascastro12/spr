# spr

`spr` is a Bun CLI for syncing stacked PR branches across Git worktrees.

It auto-detects all local worktrees, finds the PR stack connected to your current branch, then rebases descendants in order.

## Design Plan

See `PLAN.md` for the full product and implementation plan.

## Requirements

- `bun`
- `git`
- `gh` authenticated against GitHub

## Usage

```bash
bun install
bun run src/cli.ts status
bun run src/cli.ts jump
bun run src/cli.ts jump feature/a
bun run src/cli.ts jump --from feature/top --print
bun run src/cli.ts jump --from feature/top --cd
eval "$(bun run src/cli.ts jump --cd)"
bun run src/cli.ts bootstrap --from feature/top
bun run src/cli.ts link feature/top --parent feature/mid
bun run src/cli.ts link --parent feature/mid
bun run src/cli.ts link feature/mid --child feature/top
bun run src/cli.ts skill
bun run src/cli.ts skill --codex-path ~/.codex/skills --claude-path ~/.claude/skills
bun run src/cli.ts branch feature/a --from main --worktree ../wt-feature-a
bun run src/cli.ts sync --dry-run
bun run src/cli.ts sync
bun run src/cli.ts resume
```

## Behavior

- Detect worktrees: `git worktree list --porcelain`
- Read PR metadata: `gh pr view <branch> --json number,headRefName,baseRefName,url,title,body`
- Bootstrap existing open stacks: discover ancestor/descendant PR chain, create missing worktrees, and write `spr-meta.json`
- Manually link stack metadata in either direction with `spr link` (defaults to current branch when omitted)
- Install bundled `spr-usage` skill for both Codex and Claude via `spr skill`
- Build stack graph by local parent/child branch references
- `status` prints a stack tree view with branch tags (`root`, `current`, `rebase:n`)
- `jump` supports interactive arrow-key selection (up/down + enter) and prints the selected worktree path
- `jump --cd` prints a shell-safe `cd -- <path>` command so you can run `eval "$(spr jump --cd)"` in your current shell
- Terminal output is colorized when running in an interactive TTY (respects `NO_COLOR`)
- Persist parent metadata in `spr-meta.json` (git common dir) when using `spr branch`
- During `sync`, auto-infer missing parent links from open PR base refs and write them to `spr-meta.json` (real runs)
- During `sync`, if an ancestor PR is `CLOSED` but detected as merged into its base branch (commit ancestry or `(#PR)` commit marker), auto-reparent descendants to that base and remove the merged branch from local stack metadata
- If connected stack worktrees are dirty during `sync`/`resume`, prompt to stash changes before continuing
- Prompt to create missing PRs during `sync`
- Auto-update PR descriptions with a managed stack section on PR create and push
- Update PR body via GitHub REST API (`gh api`) for compatibility with deprecated classic project fields
- Rebase descendants in topological order
- Push each updated branch with `--force-with-lease`
- Save checkpoint in `.git/spr-state.json` (actually in `git-common-dir`)
