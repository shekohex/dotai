import { useRpc, useSettings, useWorkspace } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { keepPreviousData, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import {
  branchesRpc,
  diffRpc,
  fileRpc,
  filesRpc,
  statusRpc,
  syntaxThemeRpc,
  type ChangedFile,
} from "../shared/contracts.js";
import { prismSettings } from "../shared/settings.js";
import { appearanceOf } from "./styling.js";
import { useWorkspaceView } from "./store.js";

const STATUS_POLL_MS = 8_000;

export function useWorkspaceDirectory(workspaceId: string): string | null {
  return useWorkspace(workspaceId, (workspace) => workspace.directory);
}

/** Repo status. The workspace's live diff totals are part of the key, so edits refetch it. */
export function useRepoStatus(workspaceId: string) {
  const status = useRpc(statusRpc);
  const snapshot = useWorkspace(workspaceId, (workspace) => ({
    cwd: workspace.directory,
    additions: workspace.diffStat?.additions ?? 0,
    deletions: workspace.diffStat?.deletions ?? 0,
  }));
  const cwd = snapshot?.cwd ?? null;
  const compare = useWorkspaceView(workspaceId, (state) => state.compare);
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
  const queryClient = useQueryClient();
  // The key leaves out `rev`, so an edit refetches in place and the old diff stays on screen meanwhile
  // instead of collapsing the file to a loading notice.
  const seen = useRef(new Map<string, string>());
  useEffect(() => {
    for (const file of files) {
      const stamp = `${file.status}\0${file.rev}`;
      const previous = seen.current.get(file.path);
      seen.current.set(file.path, stamp);
      if (previous !== undefined && previous !== stamp) {
        void queryClient.invalidateQueries({ queryKey: ["prism", "diff", cwd, compare, file.path] });
      }
    }
  }, [files, cwd, compare, queryClient]);
  return useQueries({
    queries: files.map((file) => ({
      queryKey: ["prism", "diff", cwd, compare, file.path, ignoreWhitespace, syntax],
      queryFn: () =>
        diff({ cwd: cwd ?? "", path: file.path, oldPath: file.oldPath, compare, ignoreWhitespace, syntax: syntax ?? "" }),
      enabled: cwd !== null && syntax !== null,
      staleTime: 0,
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

/** One file's text and tokens. Always refetched on open, so the view never shows a stale file. */
export function useFile(workspaceId: string, path: string | null, syntax: string | null) {
  const read = useRpc(fileRpc);
  const cwd = useWorkspaceDirectory(workspaceId);
  return useQuery({
    queryKey: ["prism", "file", cwd, path, syntax],
    queryFn: () => read({ cwd: cwd ?? "", path: path ?? "", syntax: syntax ?? "" }),
    enabled: cwd !== null && path !== null && syntax !== null,
    staleTime: 0,
    gcTime: 0,
  });
}
