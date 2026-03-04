import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SyncPlan, SyncState } from "../types";

function stateFilePath(commonGitDir: string): string {
  return resolve(commonGitDir, "gw-state.json");
}

export async function loadState(commonGitDir: string): Promise<SyncState | null> {
  const file = stateFilePath(commonGitDir);
  if (!existsSync(file)) {
    return null;
  }
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw) as SyncState;
}

export async function saveState(commonGitDir: string, state: SyncState): Promise<void> {
  const file = stateFilePath(commonGitDir);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function clearState(commonGitDir: string): Promise<void> {
  const file = stateFilePath(commonGitDir);
  if (existsSync(file)) {
    await rm(file);
  }
}

export function makeInitialState(repoRoot: string, plan: SyncPlan, dryRun: boolean): SyncState {
  return {
    version: 1,
    repoRoot,
    startedAt: new Date().toISOString(),
    command: "sync",
    rootBranch: plan.root,
    stackBranches: plan.allBranches,
    executionOrder: plan.rebaseOrder,
    completed: [],
    dryRun,
  };
}
