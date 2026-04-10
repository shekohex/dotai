import { ThemeColor } from "../../mode-utils.js";

export type CoreUITPSStats = {
  current: number;
  min: number;
  median: number;
  max: number;
  sampleCount: number;
  bufferSize: number;
};

export type CoreUIState = {
  cwd: string;
  repoSlug?: string;
  worktreeName?: string;
  activeMode?: string;
  activeModeColor?: ThemeColor;
  tps?: CoreUITPSStats;
  tpsVisible: boolean;
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
    tpsVisible: true,
    dirty: false,
    addedLines: 0,
    removedLines: 0,
    aheadCommits: 0,
    behindCommits: 0,
    totalCost: 0,
    refreshedAt: 0,
  };
}
