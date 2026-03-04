# gw

`gw` syncs stacked PR branches across Git worktrees. It auto-detects your local worktrees, finds the PR stack connected to your current branch, and rebases descendants in topological order.

## Install

### Quick install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/jonatascastro12/gw/main/install.sh | bash
```

This downloads a standalone binary for your platform and installs it to `/usr/local/bin`.
Override the install location with `GW_INSTALL_DIR`:

```bash
GW_INSTALL_DIR=~/.local/bin curl -fsSL https://raw.githubusercontent.com/jonatascastro12/gw/main/install.sh | bash
```

### Build from source

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/jonatascastro12/gw.git
cd gw
bun install
bun run build            # outputs dist/gw
cp dist/gw /usr/local/bin/gw
```

Or in one step:

```bash
bun run install-cli
```

## Requirements

- `git`
- `gh` — [GitHub CLI](https://cli.github.com/), authenticated (`gh auth login`)

## Quick Start

### 1. Create your first stacked branch

From your repo, create a branch off `main` with its parent link tracked:

```bash
gw branch feature/auth --from main
```

Create a child branch on top of it:

```bash
gw branch feature/auth-ui --from feature/auth
```

### 2. Check the stack

```bash
gw status
```

This prints a tree showing your stack, branch order, and rebase plan.

### 3. Sync the stack

Preview what will happen:

```bash
gw sync --dry-run
```

Run the sync (rebases descendants, pushes, creates missing PRs):

```bash
gw sync
```

Use `--yes` to skip all prompts (useful for scripts and AI agents):

```bash
gw sync --yes
```

### 4. Handle conflicts

If a rebase hits a conflict, `gw` saves a checkpoint and stops. Fix the conflict in the reported worktree, then:

```bash
gw resume
```

## Commands

| Command | Description |
|---------|-------------|
| `gw sync` | Rebase and push the full stack in order, create missing PRs |
| `gw restack` | Rebase and push only descendant branches of current branch |
| `gw resume` | Continue a previously failed sync from checkpoint |
| `gw status` | Show the detected stack tree and checkpoint state |
| `gw branch <name>` | Create a branch + worktree and record the parent link |
| `gw jump` | Interactively pick a stack branch and jump to its worktree |
| `gw bootstrap` | Seed local worktrees and metadata from an existing PR chain |
| `gw link` | Manually create or update a parent-child link in metadata |
| `gw skill` | Install the `gw-usage` skill for Codex and Claude |

## Common Options

| Option | Applies to | Description |
|--------|-----------|-------------|
| `--dry-run` | sync, restack, bootstrap | Preview plan without making changes |
| `--from <branch>` | sync, restack, status, jump, bootstrap | Override start branch for stack detection |
| `-y, --yes` | sync, resume, restack | Auto-confirm all prompts |
| `--print` | jump | Print selected worktree path only |
| `--cd` | jump | Print a `cd` command for `eval` |

## Examples

```bash
# Jump to a stack branch worktree
eval "$(gw jump --cd)"

# Bootstrap an existing PR stack into local worktrees
gw bootstrap --from feature/top

# Link a branch to a parent manually
gw link feature/b --parent feature/a

# Restack only children of current branch
gw restack

# Non-interactive sync (CI / agents)
gw sync --yes --from feature/a
```

## How It Works

- **Metadata**: Stack parent links are stored in `gw-meta.json` under the git common dir. This is the source of truth.
- **Sync flow**: Fetch origin, fast-forward root, detect merged parents, update PR bases, create missing PRs, rebase descendants in order, push with `--force-with-lease`.
- **Merged parent detection**: If a parent PR is closed but merged (by commit ancestry or merge-queue `(#PR)` markers), `gw` auto-reparents children and removes the merged branch from the stack.
- **Dirty worktree safety**: If any worktree in the stack has uncommitted changes, `gw` prompts to stash before proceeding and offers to restore after completion.
- **Checkpoints**: On conflict, state is saved to `gw-state.json` so `gw resume` picks up where it left off.
- **PR descriptions**: Stack navigation tables are auto-injected into PR bodies on create and push.

## Development

```bash
bun install
bun run typecheck        # type-check without emitting
bun run dev              # run CLI directly via bun
bun run test:e2e         # run end-to-end tests
bun run build            # compile standalone binary
```

## License

MIT
