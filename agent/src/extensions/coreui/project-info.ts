import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getGitState } from "../git-state.js";
import type { CoreUIState } from "./types.js";

const REFRESH_TTL_MS = 15_000;

export function createProjectInfoRefresher(
  state: CoreUIState,
  requestRender: () => void,
): (ctx: ExtensionContext, force?: boolean) => void {
  return (ctx, force = false) => {
    const cwd = ctx.sessionManager.getCwd();
    const now = Date.now();

    if (!shouldRefreshProjectInfo(state, cwd, now, force)) {
      return;
    }

    state.cwd = cwd;
    state.refreshedAt = now;

    const gitState = getGitState(cwd);
    state.repoSlug = gitState.projectInfo.repoSlug;
    state.worktreeName = gitState.projectInfo.worktreeName;
    state.dirty = gitState.projectInfo.dirty;
    state.addedLines = gitState.projectInfo.addedLines;
    state.removedLines = gitState.projectInfo.removedLines;
    state.aheadCommits = gitState.projectInfo.aheadCommits;
    state.behindCommits = gitState.projectInfo.behindCommits;
    requestRender();
  };
}

function shouldRefreshProjectInfo(
  state: CoreUIState,
  cwd: string,
  now: number,
  force: boolean,
): boolean {
  if (force) {
    return true;
  }

  return !(cwd === state.cwd && now - state.refreshedAt < REFRESH_TTL_MS);
}
