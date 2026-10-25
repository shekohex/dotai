import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";

import { buildTrie, flattenTrie } from "../shared/tree.js";
import type { ChangedFile } from "../shared/contracts.js";
import { useRepoStatus } from "./data.js";
import { useFileActions } from "./file-actions.js";
import { useSyncBuiltinHiding } from "./hide-builtins.js";
import { HeaderBar, HeaderButton } from "./panel-header.js";
import { setCompare, showDiff, toggleDir, useWorkspaceView } from "./store.js";
import { useAppAppearance } from "./appearance.js";
import { ComparePicker, compareLabel } from "./compare-picker.js";
import { usePierre } from "./pierre.js";
import { PierreTree } from "./pierre-tree.js";
import { useCommentCounts } from "./review-data.js";
import { statusColor, statusLetter, typographyFor } from "./styling.js";
import { TreeList, type RowDecoration } from "./tree-list.js";

const SCOPE = "changes";
const EMPTY: readonly ChangedFile[] = [];
const NO_PATHS: readonly string[] = [];

export function ChangesPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const { compact } = layout;
  useSyncBuiltinHiding();
  const typo = typographyFor(useAppAppearance(), compact);
  const query = useRepoStatus(workspaceId);
  const [picking, setPicking] = useState(false);
  const compare = useWorkspaceView(workspaceId, (state) => state.compare);
  const selectedPath = useWorkspaceView(workspaceId, (state) => state.selectedPath);
  const toggled = useWorkspaceView(workspaceId, (state) => state.toggledDirs);
  const files = query.data?.files ?? EMPTY;
  const pierre = usePierre();
  const commentCounts = useCommentCounts(workspaceId);
  const runAction = useFileActions(workspaceId);
  const changedPaths = useMemo(() => files.map((file) => file.path), [files]);

  const trie = useMemo(() => buildTrie(files.map((file) => file.path)), [files]);
  // Changed folders start open; toggling flips that.
  const rows = useMemo(
    () => flattenTrie(trie, (dirPath) => !toggled[`${SCOPE}:${dirPath}`]),
    [trie, toggled],
  );
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);

  const decorate = useCallback(
    (row: { path: string; isDir: boolean }): RowDecoration | null => {
      const file = row.isDir ? undefined : byPath.get(row.path);
      if (!file) return null;
      return {
        letter: statusLetter(file.status),
        color: statusColor(theme, file.status),
        additions: file.additions,
        deletions: file.deletions,
        comments: commentCounts[file.path],
      };
    },
    [byPath, theme, commentCounts],
  );
  const onToggleDir = useCallback(
    (path: string) => toggleDir(workspaceId, SCOPE, path),
    [workspaceId],
  );
  const onPressFile = useCallback((path: string) => showDiff(workspaceId, path), [workspaceId]);

  const totals = useMemo(
    () => ({
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    }),
    [files],
  );
  const data = query.data;
  const branchLabel = data?.branch ?? (data?.isGit ? "detached HEAD" : "Not a git repository");

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <HeaderBar theme={theme} compact={compact}>
        <Icon name="GitBranch" size={15} color={theme.colors.foregroundMuted} />
        <Text
          numberOfLines={1}
          style={{ flex: 1, color: theme.colors.foreground, fontSize: typo.ui }}
        >
          {branchLabel}
        </Text>
        {data && (data.ahead > 0 || data.behind > 0) ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: typo.small }}>
            {`${data.ahead > 0 ? `↑${data.ahead}` : ""}${data.behind > 0 ? ` ↓${data.behind}` : ""}`.trim()}
          </Text>
        ) : null}
        {files.length > 0 ? (
          <>
            <Text style={{ color: theme.colors.statusSuccess, fontSize: typo.small }}>
              {`+${totals.additions}`}
            </Text>
            <Text style={{ color: theme.colors.statusDanger, fontSize: typo.small }}>
              {`-${totals.deletions}`}
            </Text>
          </>
        ) : null}
        <HeaderButton
          theme={theme}
          compact={compact}
          icon="GitCompare"
          label="Choose what to compare"
          active={picking}
          onPress={() => setPicking((open) => !open)}
        />
        <HeaderButton
          theme={theme}
          compact={compact}
          icon="RotateCw"
          label="Refresh changes"
          busy={query.isFetching}
          onPress={() => void query.refetch()}
        />
      </HeaderBar>
      {data && data.applied.mode !== "uncommitted" ? (
        <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: typo.small, paddingHorizontal: 10, paddingVertical: 4 }}>
          {compareLabel(data.applied)}
        </Text>
      ) : null}
      {picking ? (
        <ComparePicker
          theme={theme}
          compact={compact}
          typo={typo}
          workspaceId={workspaceId}
          compare={compare}
          defaultBase={data?.defaultBase ?? null}
          onChange={(next) => setCompare(workspaceId, next)}
          onClose={() => setPicking(false)}
        />
      ) : query.isError ? (
        <Text style={{ color: theme.colors.statusDanger, padding: 16, fontSize: typo.ui }}>
          {`Could not read changes: ${query.error.message}`}
        </Text>
      ) : pierre && files.length > 0 ? (
        <PierreTree
          api={pierre}
          theme={theme}
          typo={typo}
          paths={changedPaths}
          changed={files}
          ignored={NO_PATHS}
          commentCounts={commentCounts}
          expandAll
          search=""
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
          empty={query.isPending ? "Loading changes…" : "No uncommitted changes"}
        />
      )}
    </View>
  );
}
