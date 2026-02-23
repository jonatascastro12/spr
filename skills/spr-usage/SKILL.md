---
name: spr-usage
description: Use when working with the spr CLI to manage stacked branches and PRs across git worktrees, including creating links in spr-meta.json, bootstrapping existing PR stacks, running sync/resume safely, and troubleshooting stack detection or dirty-worktree errors.
---

# SPR Usage

Use this workflow to operate `spr` safely and predictably.

## Establish Stack Context

1. Run `spr status` or `spr status --from <branch>` to inspect:
- root branch
- stack branch order
- rebase execution order
- checkpoint state
2. If the expected parent link is missing:
- Run `spr link [branch] --parent <parent>` or `spr link [branch] --child <child>`.
- Omit `[branch]` to use the current branch.
3. If PRs already exist and local metadata/worktrees are missing:
- Run `spr bootstrap --from <branch>`.

## Sync Safely

1. Run `spr sync --dry-run --from <branch>` first.
2. Confirm stack order and missing-PR prompts are correct.
3. Run `spr sync --from <branch>`.
4. If sync stops on conflict, resolve in the reported worktree and run `spr resume`.

## Metadata Rules

1. Treat `spr-meta.json` as source of truth for parent linkage.
2. Use `spr link` or `spr branch` to update linkage instead of manual edits.
3. Expect `spr sync` to auto-seed missing parent links from open PR base refs when possible.

## Troubleshooting

1. Dirty worktree errors:
- Clean or ignore the listed path, then retry.
2. Branch not in local worktree graph:
- Create/check out a worktree for that branch first, or run `spr bootstrap`.
3. Missing PR inference:
- Ensure the branch has an open PR, otherwise add linkage with `spr link`.
