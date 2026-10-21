import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";

import { buildTrie, flattenTrie, type TreeRow } from "../shared/tree.js";
import { useAppAppearance } from "./appearance.js";
import { useProjectFiles, useRepoStatus } from "./data.js";
import { fileMenuFor, useFileActions } from "./file-actions.js";
import { FileMenuSheet } from "./file-menu.js";
import { useSyncBuiltinHiding } from "./hide-builtins.js";
import { HeaderBar, HeaderButton } from "./panel-header.js";
import { collapseDirs, toggleDir, updateWorkspaceView, useWorkspaceView } from "./store.js";
import { usePierre } from "./pierre.js";
import { PierreTree } from "./pierre-tree.js";
import { useCommentCounts } from "./review-data.js";
import { statusColor, statusLetter, typographyFor } from "./styling.js";
import { TreeList, type RowDecoration } from "./tree-list.js";

const SCOPE = "files";
const NO_FILES: readonly never[] = [];
const SEARCH_RESULT_LIMIT = 300;
const IGNORED_DECORATION: RowDecoration = { letter: "", color: "", additions: 0, deletions: 0, dim: true };

const isDotPath = (path: string) => path.split("/").some((part) => part.startsWith("."));

export function FilesPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const { compact } = layout;
  useSyncBuiltinHiding();
  const typo = typographyFor(useAppAppearance(), compact);
  const hideDotfiles = useWorkspaceView(workspaceId, (state) => state.hideDotfiles);
  const showIgnored = useWorkspaceView(workspaceId, (state) => state.showIgnored);
  const filesQuery = useProjectFiles(workspaceId, showIgnored);
  const status = useRepoStatus(workspaceId);
  const selectedPath = useWorkspaceView(workspaceId, (state) => state.selectedPath);
  const toggled = useWorkspaceView(workspaceId, (state) => state.toggledDirs);
  const [search, setSearch] = useState("");
  const pierre = usePierre();
  const commentCounts = useCommentCounts(workspaceId);

  const paths = useMemo(
    () => (hideDotfiles ? filesQuery.data?.paths.filter((path) => !isDotPath(path)) : filesQuery.data?.paths),
    [filesQuery.data, hideDotfiles],
  );
  const ignored = useMemo(
    () => new Set((filesQuery.data?.ignored ?? []).map((path) => path.replace(/\/$/, ""))),
    [filesQuery.data],
  );
  const trie = useMemo(() => buildTrie(paths ?? []), [paths]);
  const changed = useMemo(
    () => new Map((status.data?.files ?? []).map((file) => [file.path, file])),
    [status.data],
  );
  const rows = useMemo<TreeRow[]>(() => {
    const query = search.trim().toLowerCase();
    if (query === "") return flattenTrie(trie, (dirPath) => Boolean(toggled[`${SCOPE}:${dirPath}`]));
    return (paths ?? [])
      .filter((path) => !path.endsWith("/") && path.toLowerCase().includes(query))
      .slice(0, SEARCH_RESULT_LIMIT)
      .map((path) => ({ key: path, path, name: path, isDir: false, depth: 0, expanded: false }));
  }, [trie, toggled, search, paths]);

  const decorate = useCallback(
    (row: TreeRow): RowDecoration | null => {
      if (ignored.has(row.path)) return IGNORED_DECORATION;
      const file = row.isDir ? undefined : changed.get(row.path);
      if (!file) return null;
      return {
        letter: statusLetter(file.status),
        color: statusColor(theme, file.status),
        additions: file.additions,
        deletions: file.deletions,
        comments: commentCounts[file.path],
      };
    },
    [changed, ignored, theme, commentCounts],
  );
  const onToggleDir = useCallback((path: string) => toggleDir(workspaceId, SCOPE, path), [workspaceId]);
  const runAction = useFileActions(workspaceId);
  const onPressFile = useCallback((path: string) => runAction("open", path), [runAction]);
  const [menuRow, setMenuRow] = useState<TreeRow | null>(null);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <HeaderBar theme={theme} compact={compact}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search files"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={{
            flex: 1,
            color: theme.colors.foreground,
            fontSize: typo.ui,
            paddingVertical: compact ? 10 : 4,
          }}
        />
        {search !== "" ? (
          <HeaderButton theme={theme} compact={compact} icon="X" label="Clear search" onPress={() => setSearch("")} />
        ) : null}
        <HeaderButton
          theme={theme}
          compact={compact}
          icon="ListChevronsDownUp"
          label="Collapse all folders"
          onPress={() => collapseDirs(workspaceId, SCOPE)}
        />
        <HeaderButton
          theme={theme}
          compact={compact}
          icon="EyeOff"
          label="Hide dotfiles"
          active={hideDotfiles}
          onPress={() => updateWorkspaceView(workspaceId, (state) => ({ hideDotfiles: !state.hideDotfiles }))}
        />
        <HeaderButton
          theme={theme}
          compact={compact}
          icon="FileX"
          label="Show git-ignored files"
          active={showIgnored}
          onPress={() => updateWorkspaceView(workspaceId, (state) => ({ showIgnored: !state.showIgnored }))}
        />
        <HeaderButton
          theme={theme}
          compact={compact}
          icon="RotateCw"
          label="Refresh files"
          busy={filesQuery.isFetching}
          onPress={() => void Promise.all([filesQuery.refetch(), status.refetch()])}
        />
      </HeaderBar>
      {filesQuery.isError ? (
        <Text style={{ color: theme.colors.statusDanger, padding: 16, fontSize: typo.ui }}>
          {`Could not list files: ${filesQuery.error.message}`}
        </Text>
      ) : pierre && paths ? (
        <PierreTree
          api={pierre}
          theme={theme}
          typo={typo}
          paths={paths}
          changed={status.data?.files ?? NO_FILES}
          ignored={filesQuery.data?.ignored ?? NO_FILES}
          commentCounts={commentCounts}
          expandAll={false}
          search={search}
          onOpenFile={onPressFile}
          onAction={runAction}
        />
      ) : (
        <TreeList
          theme={theme}
          compact={compact}
          typo={typo}
          rows={rows}
          selectedPath={selectedPath}
          decorate={decorate}
          onPressFile={onPressFile}
          onToggleDir={onToggleDir}
          onLongPressRow={setMenuRow}
          empty={filesQuery.isPending ? "Loading files…" : search === "" ? "No files" : "No matches"}
        />
      )}
      {menuRow ? (
        <FileMenuSheet
          theme={theme}
          title={menuRow.name}
          items={fileMenuFor(menuRow.isDir, !menuRow.isDir && changed.has(menuRow.path))}
          onSelect={(id) => runAction(id, menuRow.path)}
          onClose={() => setMenuRow(null)}
        />
      ) : null}
    </View>
  );
}
