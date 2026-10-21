import { useRpc, useSettings, useWorkspace } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";

import {
  branchesRpc,
  diffRpc,
  filesRpc,
  statusRpc,
  syntaxThemeRpc,
  type ChangedFile,
  type Compare,
} from "../shared/contracts.js";
import { prismSettings } from "../shared/settings.js";
import { appearanceOf } from "./styling.js";
import { useWorkspaceView } from "./store.js";

const STATUS_POLL_MS = 8_000;

export function useWorkspaceDirectory(workspaceId: string): string | null {
  return useWorkspace(workspaceId, (workspace) => workspace.directory);
}

/** Repo status. The workspace's live diff totals are part of the key, so edits refetch it. */
/** `compareOverride` reads a fixed comparison instead of the one picked in the panels. */
export function useRepoStatus(workspaceId: string, compareOverride?: Compare) {
  const status = useRpc(statusRpc);
  const snapshot = useWorkspace(workspaceId, (workspace) => ({
    cwd: workspace.directory,
    additions: workspace.diffStat?.additions ?? 0,
    deletions: workspace.diffStat?.deletions ?? 0,
  }));
  const cwd = snapshot?.cwd ?? null;
  const viewCompare = useWorkspaceView(workspaceId, (state) => state.compare);
  const compare = compareOverride ?? viewCompare;
  return useQuery({
    queryKey: ["prism", "status", cwd, compare, snapshot?.additions, snapshot?.deletions],
    queryFn: () => status({ cwd: cwd ?? "", compare }),
    enabled: cwd !== null,
    placeholderData: keepPreviousData,
    refetchInterval: STATUS_POLL_MS,
    staleTime: 2_000,
  });
}

export function useBranches(workspaceId: string, enabled: boolean) {
  const branches = useRpc(branchesRpc);
  const cwd = useWorkspaceDirectory(workspaceId);
  return useQuery({
    queryKey: ["prism", "branches", cwd],
    queryFn: () => branches({ cwd: cwd ?? "" }),
    enabled: enabled && cwd !== null,
    staleTime: 15_000,
  });
}

export function useProjectFiles(workspaceId: string, includeIgnored: boolean) {
  const files = useRpc(filesRpc);
  const cwd = useWorkspaceDirectory(workspaceId);
  return useQuery({
    queryKey: ["prism", "files", cwd, includeIgnored],
    queryFn: () => files({ cwd: cwd ?? "", includeIgnored }),
    enabled: cwd !== null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

/** One diff query per open file, so only what the user expanded is ever fetched. */
export function useFileDiffs(
  workspaceId: string,
  files: readonly ChangedFile[],
  ignoreWhitespace: boolean,
  syntax: string | null,
) {
  const diff = useRpc(diffRpc);
  const cwd = useWorkspaceDirectory(workspaceId);
  const compare = useWorkspaceView(workspaceId, (state) => state.compare);
  return useQueries({
    queries: files.map((file) => ({
      // `rev` changes whenever the file does, so an edit can never leave a stale diff behind.
      queryKey: ["prism", "diff", cwd, compare, file.path, file.status, file.rev, ignoreWhitespace, syntax],
      queryFn: () =>
        diff({ cwd: cwd ?? "", path: file.path, oldPath: file.oldPath, compare, ignoreWhitespace, syntax: syntax ?? "" }),
      enabled: cwd !== null && syntax !== null,
      staleTime: 30_000,
    })),
  });
}

/**
 * The Highlights theme for code: the user's pick, or the bundled theme whose background is the Paseo
 * theme's surface (Catppuccin, Tokyo Night, ...). Null until settings and the daemon have answered.
 */
export function useSyntaxTheme(theme: PluginTheme): string | null {
  const settings = useSettings(prismSettings);
  const resolve = useRpc(syntaxThemeRpc);
  const choice = settings.status === "ready" ? settings.values.syntaxTheme : null;
  const background = theme.colors.surface0;
  const appearance = appearanceOf(theme);
  const query = useQuery({
    queryKey: ["prism", "syntax-theme", choice, background, appearance],
    queryFn: () => resolve({ choice: choice ?? "auto", background, appearance }),
    enabled: choice !== null,
    staleTime: Infinity,
  });
  return query.data?.name ?? null;
}
