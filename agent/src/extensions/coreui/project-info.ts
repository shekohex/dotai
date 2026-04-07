import type { ExecResult, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CoreUIState } from "./types.js";

const REFRESH_TTL_MS = 15_000;
const GIT_TIMEOUT_MS = 900;

type BranchStatus = {
  dirty: boolean;
  ahead: number;
  behind: number;
};

type DiffStat = {
  added: number;
  removed: number;
};

export function createProjectInfoRefresher(
  pi: ExtensionAPI,
  state: CoreUIState,
  requestRender: () => void,
): (ctx: ExtensionContext, force?: boolean) => Promise<void> {
  return async (ctx, force = false) => {
    const cwd = ctx.sessionManager.getCwd();
    const now = Date.now();

    if (!shouldRefreshProjectInfo(state, cwd, now, force)) {
      return;
    }

    state.cwd = cwd;
    state.refreshedAt = now;

    const [remoteResult, gitDirResult, statusResult, diffResult] =
      await Promise.all([
        execGit(pi, ctx, cwd, ["remote", "get-url", "origin"]),
        execGit(pi, ctx, cwd, ["rev-parse", "--git-dir"]),
        execGit(pi, ctx, cwd, ["status", "--porcelain", "--branch"]),
        execGit(pi, ctx, cwd, ["diff", "--shortstat", "HEAD"]),
      ]);

    state.repoSlug =
      remoteResult.code === 0 ? parseRepoSlug(remoteResult.stdout) : undefined;
    state.worktreeName =
      gitDirResult.code === 0
        ? parseWorktreeName(gitDirResult.stdout)
        : undefined;

    applyBranchStatus(state, statusResult);
    applyDiffStat(state, diffResult);
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

function execGit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  cwd: string,
  args: string[],
): Promise<ExecResult> {
  return pi.exec("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    signal: ctx.signal,
  });
}

function applyBranchStatus(state: CoreUIState, result: ExecResult): void {
  if (result.code !== 0) {
    state.dirty = false;
    state.aheadCommits = 0;
    state.behindCommits = 0;
    return;
  }

  const status = parseStatusPorcelain(result.stdout);
  state.dirty = status.dirty;
  state.aheadCommits = status.ahead;
  state.behindCommits = status.behind;
}

function applyDiffStat(state: CoreUIState, result: ExecResult): void {
  if (result.code !== 0) {
    state.addedLines = 0;
    state.removedLines = 0;
    return;
  }

  const diff = parseShortStat(result.stdout);
  state.addedLines = diff.added;
  state.removedLines = diff.removed;
}

function parseRepoSlug(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/\.git\/?$/i, "");
  if (!trimmed) {
    return undefined;
  }

  let repoPath = "";
  const scpLike = trimmed.match(/^[^@]+@[^:]+:(.+)$/);

  if (scpLike?.[1]) {
    repoPath = scpLike[1];
  } else {
    try {
      repoPath = new URL(trimmed).pathname.replace(/^\/+/, "");
    } catch {
      const firstSlashIndex = trimmed.indexOf("/");
      if (firstSlashIndex >= 0) {
        repoPath = trimmed.slice(firstSlashIndex + 1);
      }
    }
  }

  const segments = repoPath
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length < 2) {
    return undefined;
  }

  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}

function parseWorktreeName(gitDir: string): string | undefined {
  const normalized = gitDir.trim().replace(/\\/g, "/");
  const marker = "/worktrees/";
  const markerIndex = normalized.lastIndexOf(marker);

  if (markerIndex === -1) {
    return undefined;
  }

  const value = normalized
    .slice(markerIndex + marker.length)
    .split("/")[0]
    ?.trim();

  return value || undefined;
}

function parseStatusPorcelain(output: string): BranchStatus {
  const lines = output.split("\n").filter((line) => line.length > 0);
  const header = lines[0] ?? "";

  return {
    dirty: lines.slice(1).some((line) => line.trim().length > 0),
    ahead: readCaptureInt(header, /ahead\s+(\d+)/),
    behind: readCaptureInt(header, /behind\s+(\d+)/),
  };
}

function parseShortStat(output: string): DiffStat {
  return {
    added: readCaptureInt(output, /(\d+)\s+insertions?\(\+\)/),
    removed: readCaptureInt(output, /(\d+)\s+deletions?\(-\)/),
  };
}

function readCaptureInt(text: string, regex: RegExp): number {
  const value = text.match(regex)?.[1];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}
