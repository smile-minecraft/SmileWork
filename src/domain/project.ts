/** 專案身分；projectId 由 git common dir 正規化而來。 */
export interface ProjectContext {
  readonly projectId: string;
  readonly worktreePath: string;
  readonly commonDir: string;
  readonly rootPath: string;
}

export interface ProjectWorktree {
  readonly projectId: string;
  readonly worktreePath: string;
  readonly gitDir: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string;
}

export interface ProjectRecord {
  readonly projectId: string;
  readonly commonDir: string;
  readonly rootPath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSeenAt: string;
  readonly worktrees: readonly ProjectWorktree[];
}
