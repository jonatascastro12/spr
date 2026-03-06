export type Worktree = {
  path: string;
  branch: string;
  headSha: string;
};

export type PrInfo = {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
  title: string;
  body: string;
};

export type PrStateInfo = {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergedAt: string | null;
  closedAt: string | null;
  headRefOid: string | null;
};

export type StackNode = {
  branch: string;
  worktreePath: string;
  parent?: string;
  children: string[];
};

export type SyncPlan = {
  root: string;
  allBranches: string[];
  rebaseOrder: string[];
};

export type SyncState = {
  version: 1;
  repoRoot: string;
  startedAt: string;
  command: "sync" | "restack";
  rootBranch: string;
  stackBranches: string[];
  executionOrder: string[];
  completed: string[];
  failedAt?: string;
  failedWorktreePath?: string;
  lastError?: string;
  dryRun: boolean;
  snapshotTimestamp?: string;
};

export type GwMeta = {
  version: 1;
  parentByBranch: Record<string, string>;
};
