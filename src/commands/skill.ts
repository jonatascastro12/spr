import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GwError } from "../lib/errors";
import * as ui from "../lib/ui";

type SkillOptions = {
  path?: string;
  codexPath?: string;
  claudePath?: string;
};

const SKILL_NAME = "gw-usage";

export async function runSkill(opts: SkillOptions): Promise<void> {
  const sourceDir = resolve(fileURLToPath(new URL("../../skills/gw-usage", import.meta.url)));
  if (!existsSync(sourceDir)) {
    throw new GwError(`Bundled skill source not found: ${sourceDir}`);
  }

  const targets = resolveTargetRoots(opts);
  for (const targetRoot of targets) {
    const targetDir = join(targetRoot, SKILL_NAME);
    await mkdir(targetRoot, { recursive: true });
    if (existsSync(targetDir)) {
      await rm(targetDir, { recursive: true, force: true });
    }
    await cp(sourceDir, targetDir, { recursive: true, force: true });
    ui.printSuccess(`Installed skill '${SKILL_NAME}' to ${ui.stylePath(targetDir)}`);
  }
}

function resolveTargetRoots(opts: SkillOptions): string[] {
  if (opts.path) {
    return [resolve(opts.path)];
  }

  const codexRoot = resolve(opts.codexPath ?? defaultCodexSkillsRoot());
  const claudeRoot = resolve(opts.claudePath ?? defaultClaudeSkillsRoot());
  return [...new Set([codexRoot, claudeRoot])];
}

function defaultCodexSkillsRoot(): string {
  const codexHome = process.env.CODEX_HOME?.trim();
  if (codexHome && codexHome.length > 0) {
    return join(codexHome, "skills");
  }
  return join(homedir(), ".codex", "skills");
}

function defaultClaudeSkillsRoot(): string {
  return join(homedir(), ".claude", "skills");
}
