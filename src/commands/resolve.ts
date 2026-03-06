import * as git from "../lib/git";
import * as stateStore from "../lib/state";
import { detectAiTool, aiResolveConflicts } from "../lib/ai-resolve";
import * as ui from "../lib/ui";
import { GwError } from "../lib/errors";

export type ResolveOptions = {
  tool?: "claude" | "codex";
};

export async function runResolve(opts: ResolveOptions): Promise<void> {
  const repoRoot = await git.repoRoot();
  const commonDir = await git.gitCommonDir(repoRoot);
  const state = await stateStore.loadState(commonDir);

  if (!state || !state.failedAt) {
    throw new GwError("No conflict state found. Nothing to resolve.");
  }

  const worktreePath = state.failedWorktreePath;
  if (!worktreePath) {
    throw new GwError("No worktree path saved in state. Cannot determine where the conflict is.");
  }

  const rebaseActive = await git.isRebaseInProgress(worktreePath);
  if (!rebaseActive) {
    throw new GwError("No active rebase found. Nothing to resolve.");
  }

  // Determine AI tool
  const tool = opts.tool ?? (await detectAiTool());
  if (!tool) {
    throw new GwError(
      "No AI tool found. Install claude or codex CLI, or specify --tool <claude|codex>."
    );
  }

  const conflicted = await git.listConflictedFiles(worktreePath);
  ui.printStep(`Using ${tool} to resolve ${conflicted.length} conflicted file(s) in ${worktreePath}`);
  for (const f of conflicted) {
    ui.printStep(`- ${f}`);
  }

  const resolved = await aiResolveConflicts(worktreePath, tool);

  if (resolved) {
    ui.printStep("All conflicts resolved. Running git rebase --continue...");
    // Use GIT_EDITOR=true to skip the editor
    const proc = Bun.spawn(["git", "-C", worktreePath, "rebase", "--continue"], {
      env: { ...process.env, GIT_EDITOR: "true" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      ui.printWarning(`Rebase continue failed: ${stderr.trim()}`);
      ui.printStep("You may need to resolve additional conflicts. Then run: gw resume");
      return;
    }

    ui.printSuccess("Rebase conflict resolved successfully. Run: gw resume");
  } else {
    ui.printWarning("AI could not fully resolve all conflicts.");
    ui.printStep("Please finish resolving manually, then:");
    ui.printStep(`  cd ${worktreePath}`);
    ui.printStep("  git add <resolved files>");
    ui.printStep("  git rebase --continue");
    ui.printStep("  gw resume");
  }
}
