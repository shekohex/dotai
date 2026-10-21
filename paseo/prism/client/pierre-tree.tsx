import type { PluginTheme } from "@getpaseo/plugin";
import { useCallback, useMemo } from "react";

import type { ChangedFile } from "../shared/contracts.js";
import type { PierreApi, TreeStatus, TreeViewProps } from "../shared/pierre-api.js";
import { PierreMount } from "./pierre.js";
import { pierreColorsOf, type Typography } from "./styling.js";

const STATUS: Record<ChangedFile["status"], TreeStatus> = {
  modified: "modified",
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  untracked: "added",
  conflicted: "modified",
};

/** `@pierre/trees` with git status and +N −M decorations from the repo's changed files. */
export function PierreTree({
  api,
  theme,
  typo,
  paths,
  changed,
  ignored,
  commentCounts,
  expandAll,
  search,
  onOpenFile,
}: {
  api: PierreApi;
  theme: PluginTheme;
  typo: Typography;
  paths: readonly string[];
  changed: readonly ChangedFile[];
  ignored: readonly string[];
  commentCounts: Readonly<Record<string, number>>;
  expandAll: boolean;
  search: string;
  onOpenFile: (path: string) => void;
}) {
  const create = useCallback(
    (host: unknown, initial: TreeViewProps) => api.createTreeView(host, initial),
    [api],
  );
  const props = useMemo<TreeViewProps>(() => {
    const statuses: Record<string, TreeStatus> = {};
    for (const path of ignored) statuses[path] = "ignored";
    const stats: Record<string, { additions: number; deletions: number }> = {};
    for (const file of changed) {
      statuses[file.path] = STATUS[file.status];
      if (!file.binary) stats[file.path] = { additions: file.additions, deletions: file.deletions };
    }
    return {
      paths,
      statuses,
      stats,
      commentCounts,
      expandAll,
      search,
      colors: pierreColorsOf(theme),
      uiFontSize: typo.ui,
      onOpenFile,
    };
  }, [paths, changed, ignored, commentCounts, expandAll, search, theme, typo.ui, onOpenFile]);
  return <PierreMount create={create} props={props} style={{ flex: 1 }} />;
}
