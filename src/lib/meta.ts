import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { GwMeta } from "../types";

function metaFilePath(commonGitDir: string): string {
  return resolve(commonGitDir, "gw-meta.json");
}

export async function loadMeta(commonGitDir: string): Promise<GwMeta> {
  const file = metaFilePath(commonGitDir);
  if (!existsSync(file)) {
    return { version: 1, parentByBranch: {} };
  }
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw) as GwMeta;
}

export async function saveMeta(commonGitDir: string, meta: GwMeta): Promise<void> {
  const file = metaFilePath(commonGitDir);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

export async function setParent(
  commonGitDir: string,
  childBranch: string,
  parentBranch: string
): Promise<void> {
  const meta = await loadMeta(commonGitDir);
  meta.parentByBranch[childBranch] = parentBranch;
  await saveMeta(commonGitDir, meta);
}

export async function mergeParents(
  commonGitDir: string,
  parents: Record<string, string>
): Promise<void> {
  if (Object.keys(parents).length === 0) {
    return;
  }
  const meta = await loadMeta(commonGitDir);
  meta.parentByBranch = {
    ...meta.parentByBranch,
    ...parents,
  };
  await saveMeta(commonGitDir, meta);
}
