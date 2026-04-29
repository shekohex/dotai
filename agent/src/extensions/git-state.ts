import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { GitStatusEntry } from "./files/model.js";
import { toCanonicalPath, toCanonicalPathMaybeMissing } from "./files/path-utils.js";
import { isAuthoritativeRuntime } from "./runtime-authority.js";

const GIT_TIMEOUT_MS = 900;
export const GIT_STATE_UPDATED_EVENT = "git:state-updated";

const GitTrackedFileSchema = Type.Object({
  canonicalPath: Type.String(),
  isDirectory: Type.Boolean(),
});

const GitStatusEntrySchema = Type.Object({
  status: Type.String(),
  exists: Type.Boolean(),
  isDirectory: Type.Boolean(),
});

const GitProjectInfoSchema = Type.Object({
  repoSlug: Type.Optional(Type.String()),
  worktreeName: Type.Optional(Type.String()),
  dirty: Type.Boolean(),
  addedLines: Type.Number(),
  removedLines: Type.Number(),
  aheadCommits: Type.Number(),
  behindCommits: Type.Number(),
});

export const GitRuntimeStateSchema = Type.Object({
  gitRoot: Type.Union([Type.String(), Type.Null()]),
  trackedFiles: Type.Array(GitTrackedFileSchema),
  trackedSet: Type.Array(Type.String()),
  statusEntries: Type.Array(
    Type.Object({
      canonicalPath: Type.String(),
      entry: GitStatusEntrySchema,
    }),
  ),
  projectInfo: GitProjectInfoSchema,
});

export type SerializedGitRuntimeState = Static<typeof GitRuntimeStateSchema>;

export type GitRuntimeState = {
  gitRoot: string | null;
  trackedFiles: Array<{ canonicalPath: string; isDirectory: boolean }>;
  trackedSet: Set<string>;
  statusMap: Map<string, GitStatusEntry>;
  projectInfo: Static<typeof GitProjectInfoSchema>;
};

type GitStateUpdatedEvent = {
  cwd: string;
  state: SerializedGitRuntimeState;
};

const hydratedGitStateSymbol = Symbol.for("@shekohex/agent/git-runtime-state");

type SessionManagerWithHydratedGitState = {
  [hydratedGitStateSymbol]?: SerializedGitRuntimeState;
};

const stateByCwd = new Map<string, GitRuntimeState>();

function createEmptyGitState(): GitRuntimeState {
  return {
    gitRoot: null,
    trackedFiles: [],
    trackedSet: new Set(),
    statusMap: new Map(),
    projectInfo: {
      dirty: false,
      addedLines: 0,
      removedLines: 0,
      aheadCommits: 0,
      behindCommits: 0,
    },
  };
}

function splitNullSeparated(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function readCaptureInt(text: string, regex: RegExp): number {
  const value = text.match(regex)?.[1];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function parseRepoSlug(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/\.git\/?$/i, "");
  if (trimmed.length === 0) {
    return undefined;
  }

  let repoPath = "";
  const scpLike = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
  const scpPath = scpLike?.[1];

  if (scpPath !== undefined && scpPath.length > 0) {
    repoPath = scpPath;
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

  return `${segments.at(-2)}/${segments.at(-1)}`;
}

function parseWorktreeName(gitDir: string): string | undefined {
  const normalized = gitDir.trim().replaceAll("\\", "/");
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

function parseStatusPorcelain(output: string): {
  dirty: boolean;
  aheadCommits: number;
  behindCommits: number;
} {
  const lines = output.split("\n").filter((line) => line.length > 0);
  const header = lines[0] ?? "";

  return {
    dirty: lines.slice(1).some((line) => line.trim().length > 0),
    aheadCommits: readCaptureInt(header, /ahead\s+(\d+)/),
    behindCommits: readCaptureInt(header, /behind\s+(\d+)/),
  };
}

function parseShortStat(output: string): { addedLines: number; removedLines: number } {
  return {
    addedLines: readCaptureInt(output, /(\d+)\s+insertions?\(\+\)/),
    removedLines: readCaptureInt(output, /(\d+)\s+deletions?\(-\)/),
  };
}

export function serializeGitRuntimeState(state: GitRuntimeState): SerializedGitRuntimeState {
  return {
    gitRoot: state.gitRoot,
    trackedFiles: state.trackedFiles.map((file) => ({ ...file })),
    trackedSet: [...state.trackedSet],
    statusEntries: [...state.statusMap.entries()].map(([canonicalPath, entry]) => ({
      canonicalPath,
      entry: { ...entry },
    })),
    projectInfo: { ...state.projectInfo },
  };
}

export function deserializeGitRuntimeState(state: SerializedGitRuntimeState): GitRuntimeState {
  return {
    gitRoot: state.gitRoot,
    trackedFiles: state.trackedFiles.map((file) => ({ ...file })),
    trackedSet: new Set(state.trackedSet),
    statusMap: new Map(
      state.statusEntries.map(({ canonicalPath, entry }) => [canonicalPath, { ...entry }]),
    ),
    projectInfo: { ...state.projectInfo },
  };
}

function storeGitState(cwd: string, state: GitRuntimeState): void {
  stateByCwd.set(cwd, state);
}

function emitGitState(pi: ExtensionAPI, cwd: string, state: GitRuntimeState): void {
  pi.events.emit(GIT_STATE_UPDATED_EVENT, {
    cwd,
    state: serializeGitRuntimeState(state),
  } satisfies GitStateUpdatedEvent);
}

export function getGitState(cwd: string): GitRuntimeState {
  return stateByCwd.get(cwd) ?? createEmptyGitState();
}

export function applyGitStateUpdatedEvent(data: unknown): void {
  if (data === null || typeof data !== "object" || !("cwd" in data) || !("state" in data)) {
    return;
  }

  const cwd = data.cwd;
  const state = data.state;
  if (typeof cwd !== "string" || !Value.Check(GitRuntimeStateSchema, state)) {
    return;
  }

  storeGitState(cwd, deserializeGitRuntimeState(Value.Parse(GitRuntimeStateSchema, state)));
}

export function clearGitState(pi: ExtensionAPI, cwd: string): void {
  stateByCwd.delete(cwd);
  emitGitState(pi, cwd, createEmptyGitState());
}

export function seedHydratedGitState(sessionManager: object, state: GitRuntimeState): void {
  const manager = sessionManager as SessionManagerWithHydratedGitState;
  manager[hydratedGitStateSymbol] = Value.Parse(
    GitRuntimeStateSchema,
    serializeGitRuntimeState(state),
  );
}

export function seedHydratedSerializedGitState(
  sessionManager: object,
  state: SerializedGitRuntimeState,
): void {
  const manager = sessionManager as SessionManagerWithHydratedGitState;
  manager[hydratedGitStateSymbol] = Value.Parse(GitRuntimeStateSchema, state);
}

export function readHydratedGitState(
  sessionManager: object | undefined,
): GitRuntimeState | undefined {
  if (sessionManager === undefined) {
    return undefined;
  }

  const manager = sessionManager as SessionManagerWithHydratedGitState;
  const state = manager[hydratedGitStateSymbol];
  if (!Value.Check(GitRuntimeStateSchema, state)) {
    return undefined;
  }

  return deserializeGitRuntimeState(Value.Parse(GitRuntimeStateSchema, state));
}

async function resolveGitRoot(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, "cwd" | "signal">,
): Promise<string | undefined> {
  const gitRootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd: ctx.cwd,
    signal: ctx.signal,
    timeout: GIT_TIMEOUT_MS,
  });

  if (gitRootResult.code !== 0) {
    return undefined;
  }

  const gitRoot = gitRootResult.stdout.trim();
  return gitRoot.length > 0 ? gitRoot : undefined;
}

async function loadGitFileCollections(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, "signal">,
  gitRoot: string,
): Promise<{
  trackedFiles: Array<{ canonicalPath: string; isDirectory: boolean }>;
  trackedSet: Set<string>;
  statusMap: Map<string, GitStatusEntry>;
  branchStatus: { dirty: boolean; aheadCommits: number; behindCommits: number };
}> {
  const [statusResult, trackedResult, untrackedResult] = await Promise.all([
    pi.exec("git", ["status", "--porcelain=1", "--branch", "-z"], {
      cwd: gitRoot,
      signal: ctx.signal,
      timeout: GIT_TIMEOUT_MS,
    }),
    pi.exec("git", ["ls-files", "-z"], {
      cwd: gitRoot,
      signal: ctx.signal,
      timeout: GIT_TIMEOUT_MS,
    }),
    pi.exec("git", ["ls-files", "-z", "--others", "--exclude-standard"], {
      cwd: gitRoot,
      signal: ctx.signal,
      timeout: GIT_TIMEOUT_MS,
    }),
  ]);

  const trackedSet = new Set<string>();
  const trackedFiles: Array<{ canonicalPath: string; isDirectory: boolean }> = [];

  if (trackedResult.code === 0 && trackedResult.stdout) {
    for (const relativePath of splitNullSeparated(trackedResult.stdout)) {
      const canonical = toCanonicalPath(path.resolve(gitRoot, relativePath));
      if (!canonical) {
        continue;
      }
      trackedSet.add(canonical.canonicalPath);
      trackedFiles.push(canonical);
    }
  }

  if (untrackedResult.code === 0 && untrackedResult.stdout) {
    for (const relativePath of splitNullSeparated(untrackedResult.stdout)) {
      const canonical = toCanonicalPath(path.resolve(gitRoot, relativePath));
      if (!canonical) {
        continue;
      }
      trackedFiles.push(canonical);
    }
  }

  const statusMap = new Map<string, GitStatusEntry>();
  const statusText = statusResult.stdout.replaceAll("\0", "\n");
  const statusEntries = splitNullSeparated(statusResult.stdout);
  for (let index = 1; index < statusEntries.length; index += 1) {
    const entry = statusEntries[index];
    if (!entry || entry.length < 4) {
      continue;
    }
    const status = entry.slice(0, 2);
    const statusLabel = status.replaceAll(/\s/g, "") || status.trim();
    let filePath = entry.slice(3);
    if ((status.startsWith("R") || status.startsWith("C")) && statusEntries[index + 1]) {
      filePath = statusEntries[index + 1] ?? filePath;
      index += 1;
    }
    if (filePath.length === 0) {
      continue;
    }

    const canonical = toCanonicalPathMaybeMissing(path.resolve(gitRoot, filePath));
    if (!canonical) {
      continue;
    }

    statusMap.set(canonical.canonicalPath, {
      status: statusLabel,
      exists: canonical.exists,
      isDirectory: canonical.isDirectory,
    });
  }

  return {
    trackedFiles,
    trackedSet,
    statusMap,
    branchStatus:
      statusResult.code === 0
        ? parseStatusPorcelain(statusText)
        : { dirty: false, aheadCommits: 0, behindCommits: 0 },
  };
}

async function loadGitProjectInfo(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, "signal">,
  gitRoot: string,
): Promise<Static<typeof GitProjectInfoSchema>> {
  const [remoteResult, gitDirResult, diffResult] = await Promise.all([
    pi.exec("git", ["remote", "get-url", "origin"], {
      cwd: gitRoot,
      signal: ctx.signal,
      timeout: GIT_TIMEOUT_MS,
    }),
    pi.exec("git", ["rev-parse", "--git-dir"], {
      cwd: gitRoot,
      signal: ctx.signal,
      timeout: GIT_TIMEOUT_MS,
    }),
    pi.exec("git", ["diff", "--shortstat", "HEAD"], {
      cwd: gitRoot,
      signal: ctx.signal,
      timeout: GIT_TIMEOUT_MS,
    }),
  ]);

  const diffStat =
    diffResult.code === 0 ? parseShortStat(diffResult.stdout) : { addedLines: 0, removedLines: 0 };

  return {
    repoSlug: remoteResult.code === 0 ? parseRepoSlug(remoteResult.stdout) : undefined,
    worktreeName: gitDirResult.code === 0 ? parseWorktreeName(gitDirResult.stdout) : undefined,
    dirty: false,
    addedLines: diffStat.addedLines,
    removedLines: diffStat.removedLines,
    aheadCommits: 0,
    behindCommits: 0,
  };
}

function publishGitState(pi: ExtensionAPI, cwd: string, state: GitRuntimeState): GitRuntimeState {
  storeGitState(cwd, state);
  emitGitState(pi, cwd, state);
  return state;
}

export async function refreshGitState(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, "cwd" | "signal">,
): Promise<GitRuntimeState> {
  const gitRoot = await resolveGitRoot(pi, ctx);
  if (gitRoot === undefined) {
    return publishGitState(pi, ctx.cwd, createEmptyGitState());
  }

  const [fileCollections, projectInfo] = await Promise.all([
    loadGitFileCollections(pi, ctx, gitRoot),
    loadGitProjectInfo(pi, ctx, gitRoot),
  ]);

  const state: GitRuntimeState = {
    gitRoot,
    trackedFiles: fileCollections.trackedFiles,
    trackedSet: fileCollections.trackedSet,
    statusMap: fileCollections.statusMap,
    projectInfo: {
      ...projectInfo,
      dirty: fileCollections.branchStatus.dirty,
      aheadCommits: fileCollections.branchStatus.aheadCommits,
      behindCommits: fileCollections.branchStatus.behindCommits,
    },
  };

  return publishGitState(pi, ctx.cwd, state);
}

export default function gitStateExtension(pi: ExtensionAPI): void {
  pi.events.on?.(GIT_STATE_UPDATED_EVENT, (data) => {
    applyGitStateUpdatedEvent(data);
  });

  const queueRefresh = (ctx: ExtensionContext): void => {
    const cwd = ctx.cwd;
    const signal = ctx.signal;
    void refreshGitState(pi, { cwd, signal });
  };

  pi.on("session_start", (_event, ctx) => {
    if (!isAuthoritativeRuntime(ctx)) {
      const hydratedState = readHydratedGitState(ctx.sessionManager);
      if (hydratedState) {
        storeGitState(ctx.cwd, hydratedState);
      }
      return;
    }

    queueRefresh(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!isAuthoritativeRuntime(ctx)) {
      return;
    }

    await refreshGitState(pi, ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    if (!isAuthoritativeRuntime(ctx)) {
      return;
    }

    await refreshGitState(pi, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearGitState(pi, ctx.cwd);
  });
}
