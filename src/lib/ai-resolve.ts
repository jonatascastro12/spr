import { runCmd } from "./shell";
import * as git from "./git";

export async function detectAiTool(): Promise<"claude" | "codex" | null> {
  for (const tool of ["claude", "codex"] as const) {
    const result = await runCmd(["which", tool], { allowFailure: true });
    if (result.trim().length > 0) {
      return tool;
    }
  }
  return null;
}

export async function aiResolveConflicts(
  worktreePath: string,
  tool: "claude" | "codex"
): Promise<boolean> {
  const conflicted = await git.listConflictedFiles(worktreePath);
  if (conflicted.length === 0) {
    return true;
  }

  const fileList = conflicted.map((f) => `  - ${f}`).join("\n");
  const prompt = `You are resolving a git rebase conflict. The following files have conflicts:
${fileList}

Please resolve ALL conflict markers (<<<<<<< / ======= / >>>>>>>) in these files.
Read each file, understand both sides of the conflict, and produce the correct merged result.
After editing, run: git add ${conflicted.join(" ")}

Do NOT run git rebase --continue. Only resolve the conflicts and stage the files.`;

  if (tool === "claude") {
    await runCmd(
      [
        "claude",
        "-p",
        prompt,
        "--allowedTools",
        "Edit,Read,Bash(git:*)",
        "--cwd",
        worktreePath,
      ],
      { allowFailure: true }
    );
  } else {
    await runCmd(["codex", "exec", "--full-auto", "-s", "workspace-write", prompt], {
      cwd: worktreePath,
      allowFailure: true,
    });
  }

  const remaining = await git.listConflictedFiles(worktreePath);
  return remaining.length === 0;
}
