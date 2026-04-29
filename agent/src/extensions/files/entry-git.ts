import type { GitStatusEntry } from "./model.js";
import { getGitState } from "../git-state.js";

export function loadGitFileMetadata(cwd: string): {
  gitRoot: string | null;
  statusMap: Map<string, GitStatusEntry>;
  trackedSet: Set<string>;
  gitFiles: Array<{ canonicalPath: string; isDirectory: boolean }>;
} {
  const state = getGitState(cwd);

  return {
    gitRoot: state.gitRoot,
    statusMap: new Map(state.statusMap),
    trackedSet: new Set(state.trackedSet),
    gitFiles: state.trackedFiles.map((file) => ({ ...file })),
  };
}
