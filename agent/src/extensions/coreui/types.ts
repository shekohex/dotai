export type CoreUIState = {
  cwd: string;
  repoSlug?: string;
  worktreeName?: string;
  dirty: boolean;
  addedLines: number;
  removedLines: number;
  aheadCommits: number;
  behindCommits: number;
  totalCost: number;
  refreshedAt: number;
};

export function createCoreUIState(): CoreUIState {
  return {
    cwd: "",
    dirty: false,
    addedLines: 0,
    removedLines: 0,
    aheadCommits: 0,
    behindCommits: 0,
    totalCost: 0,
    refreshedAt: 0,
  };
}
