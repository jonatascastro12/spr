import * as git from "../lib/git";
import * as metaStore from "../lib/meta";
import * as ui from "../lib/ui";
import { SprError } from "../lib/errors";

export async function runLink(opts: {
  branch?: string;
  parentBranch?: string;
  childBranch?: string;
}): Promise<void> {
  const repoRoot = await git.repoRoot();
  const branch = opts.branch ?? (await git.currentBranch(repoRoot));

  const modeCount = Number(Boolean(opts.parentBranch)) + Number(Boolean(opts.childBranch));
  if (modeCount !== 1) {
    throw new SprError("Usage: spr link [branch] (--parent <parent> | --child <child>)");
  }

  const child = opts.parentBranch ? branch : opts.childBranch!;
  const parent = opts.parentBranch ?? branch;
  if (!child || !parent) {
    throw new SprError("Usage: spr link [branch] (--parent <parent> | --child <child>)");
  }
  if (child === parent) {
    throw new SprError(`Cannot link branch '${child}' to itself.`);
  }

  const commonDir = await git.gitCommonDir(repoRoot);
  const meta = await metaStore.loadMeta(commonDir);
  const previousParent = meta.parentByBranch[child];

  meta.parentByBranch[child] = parent;
  await metaStore.saveMeta(commonDir, meta);

  if (!previousParent) {
    ui.printSuccess(`Linked ${ui.styleBranch(child)} -> ${ui.styleBranch(parent)}`);
    return;
  }

  if (previousParent === parent) {
    ui.printInfo(`Link unchanged: ${ui.styleBranch(child)} -> ${ui.styleBranch(parent)}`);
    return;
  }

  ui.printSuccess(
    `Updated link: ${ui.styleBranch(child)} -> ${ui.styleBranch(parent)} (was: ${ui.styleBranch(previousParent)})`
  );
}
