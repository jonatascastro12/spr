import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import * as git from "../lib/git";
import * as config from "../lib/config";
import * as ui from "../lib/ui";

export async function runInit(): Promise<void> {
  const repoId = await git.repoIdentifier();
  const repoName = repoId.split("/")[1];
  const defaultRoot = join(homedir(), ".gw", "worktrees", repoName);

  const existing = await config.getRepoWorktreeRoot(repoId);
  if (existing) {
    ui.printInfo(`Current worktree root for ${ui.styleBold(repoId)}: ${ui.stylePath(existing)}`);
  }

  const prompt = existing
    ? `Worktree root [${existing}]: `
    : `Where should worktrees be stored? [${defaultRoot}]: `;

  process.stdout.write(prompt);

  const answer = await readLine();
  const worktreeRoot = answer.trim() || existing || defaultRoot;

  await mkdir(worktreeRoot, { recursive: true });

  const cfg = await config.loadConfig();
  cfg.repos[repoId] = { worktreeRoot };
  await config.saveConfig(cfg);

  ui.printSuccess(`Configured worktree root for ${ui.styleBold(repoId)}: ${ui.stylePath(worktreeRoot)}`);
  ui.printInfo(ui.styleMuted(`Saved to ${config.configPath()}`));
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.resume();
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
      if (data.includes("\n")) {
        process.stdin.pause();
        resolve(data.split("\n")[0]);
      }
    });
  });
}
