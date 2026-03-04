import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export type GwConfig = {
  repos: Record<string, { worktreeRoot: string }>;
};

const CONFIG_DIR = join(homedir(), ".gw");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function configPath(): string {
  return CONFIG_PATH;
}

export async function loadConfig(): Promise<GwConfig> {
  if (!existsSync(CONFIG_PATH)) {
    return { repos: {} };
  }
  const raw = await readFile(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as GwConfig;
}

export async function saveConfig(config: GwConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export async function getRepoWorktreeRoot(repoId: string): Promise<string | undefined> {
  const config = await loadConfig();
  return config.repos[repoId]?.worktreeRoot;
}
