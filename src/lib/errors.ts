export class GwError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GwError";
  }
}

export class MissingPrError extends GwError {
  constructor(branch: string) {
    super(`No GitHub PR found for local branch: ${branch}`);
    this.name = "MissingPrError";
  }
}

export class DirtyWorktreeError extends GwError {
  constructor(path: string) {
    super(`Worktree has uncommitted changes: ${path}`);
    this.name = "DirtyWorktreeError";
  }
}

export class ConflictError extends GwError {
  constructor(branch: string, worktreePath: string, cause: string) {
    super(
      `Rebase conflict on ${branch} in ${worktreePath}. Resolve conflicts, then run: git -C ${worktreePath} rebase --continue`
    );
    this.name = "ConflictError";
    this.cause = cause;
  }
}
