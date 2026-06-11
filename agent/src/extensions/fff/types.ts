import type { Text } from "@earendil-works/pi-tui";
import type { FileFinder } from "@ff-labs/fff-node";

export interface SearchToolDetails {
  totalMatched?: number;
  totalFiles?: number;
  elapsedMs?: number;
  query?: string;
  path?: string;
  hasMore?: boolean;
}

export interface SearchRenderState {
  callComponent?: Text;
  callText?: string;
  baseCallText?: string;
  startedAt?: number;
}

export type SearchRenderContext = {
  state?: SearchRenderState;
  cwd: string;
  lastComponent: unknown;
  isPartial: boolean;
  isError: boolean;
};

export type FffToolRuntime = {
  ensureFinder: (cwd: string) => Promise<FileFinder>;
  getActiveCwd: () => string;
};
