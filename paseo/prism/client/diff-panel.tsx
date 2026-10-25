import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { FlatList, Icon } from "@getpaseo/plugin/client/ui";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View, type FlatList as NativeFlatList } from "react-native";

import type { ChangedFile } from "../shared/contracts.js";
import { parsePatchRows, type DiffLine } from "../shared/diff-parse.js";
import { limitPatch } from "../shared/patch-limit.js";
import type { DiffSide, DiffViewProps, PierreApi, ReviewComment } from "../shared/pierre-api.js";
import type { Author } from "../shared/review.js";
import { useReview, useReviewActions, useViewer } from "./review-data.js";
import { ReviewBar, ReviewScreen } from "./review-screen.js";
import { NativeComment, NativeDraft } from "./native-review.js";
import { useAppAppearance } from "./appearance.js";
import { useFileDiffs, useRepoStatus, useSyntaxTheme } from "./data.js";
import { FileIcon } from "./file-icon.js";
import { PierreFileIcon, PierreMount, usePierre } from "./pierre.js";
import { useSyncBuiltinHiding } from "./hide-builtins.js";
import { HeaderBar, HeaderButton } from "./panel-header.js";
import {
  cancelDraft,
  clearFocus,
  goToComment,
  startDraft,
  setCompare,
  setExpandedFiles,
  toggleFileExpanded,
  updateWorkspaceView,
  useWorkspaceView,
} from "./store.js";
import { ComparePicker, compareLabel } from "./compare-picker.js";
import {
  statusColor,
  statusLetter,
  typographyFor,
  CODE_SURFACE_PROPS,
  pierreColorsOf,
  pierreFontOf,
  appearanceOf,
  withAlpha,
  type Typography,
} from "./styling.js";

/** Opening every file of a huge change set at once would fan out one git call per file. */
const EXPAND_ALL_LIMIT = 40;
const NO_COMMENTS: readonly ReviewComment[] = [];
/** Pierre renders every line it gets, so longer patches are cut until the user asks for the rest. */
const PIERRE_MAX_PATCH_LINES = 3_000;

type Token = [text: string, color: string];

type Item =
  | { key: string; type: "file"; file: ChangedFile; expanded: boolean }
  | { key: string; type: "hunk"; header: string }
  | { key: string; type: "line"; path: string; line: DiffLine; tokens: Token[] | undefined }
  | { key: string; type: "comment"; comment: ReviewComment }
  | { key: string; type: "draft"; path: string; side: DiffSide; line: number }
  | { key: string; type: "pierre"; path: string; patch: string; truncated: boolean }
  | { key: string; type: "notice"; text: string; danger: boolean };

const rowCache = new Map<string, ReturnType<typeof parsePatchRows>>();

function cachedRows(patch: string) {
  let rows = rowCache.get(patch);
  if (!rows) {
    rows = parsePatchRows(patch);
    rowCache.set(patch, rows);
    if (rowCache.size > 60) rowCache.delete(rowCache.keys().next().value as string);
  }
  return rows;
}

const FileHeader = memo(function FileHeader({
  theme,
  compact,
  typo,
  file,
  expanded,
  selected,
  onToggle,
  pierre,
  appearance,
  commentCount,
  onOpenComments,
}: {
  theme: PluginTheme;
  compact: boolean;
  typo: Typography;
  file: ChangedFile;
  expanded: boolean;
  selected: boolean;
  onToggle: (path: string) => void;
  pierre: PierreApi | null;
  appearance: "dark" | "light";
  commentCount: number;
  onOpenComments: (path: string) => void;
}) {
  const name = file.path.split("/").pop() ?? file.path;
  const directory = file.path.slice(0, file.path.length - name.length);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${file.path}`}
      onPress={() => onToggle(file.path)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        minHeight: compact ? 44 : 30,
        paddingHorizontal: 10,
        backgroundColor: selected
          ? withAlpha(theme.colors.accent, 0.22)
          : theme.colors.surface1,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <Icon
        name={expanded ? "ChevronDown" : "ChevronRight"}
        size={14}
        color={theme.colors.foregroundMuted}
      />
      {pierre ? (
        <PierreFileIcon api={pierre} name={name} size={16} appearance={appearance} muted={theme.colors.foregroundMuted} />
      ) : (
        <FileIcon theme={theme} name={name} isDir={false} />
      )}
      <Text numberOfLines={1} style={{ flex: 1, fontSize: typo.ui }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>{directory}</Text>
        <Text style={{ color: theme.colors.foreground }}>{name}</Text>
      </Text>
      {commentCount > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${commentCount} review ${commentCount === 1 ? "comment" : "comments"}, show`}
          onPress={() => onOpenComments(file.path)}
          style={{ flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, backgroundColor: withAlpha(theme.colors.accent, 0.18) }}
        >
          <Icon name="MessageSquare" size={11} color={theme.colors.accent} />
          <Text style={{ color: theme.colors.accent, fontSize: typo.small }}>{commentCount}</Text>
        </Pressable>
      ) : null}
      <Text style={{ color: theme.colors.statusSuccess, fontSize: typo.small }}>{`+${file.additions}`}</Text>
      <Text style={{ color: theme.colors.statusDanger, fontSize: typo.small }}>{`-${file.deletions}`}</Text>
      <Text
        style={{
          width: 14,
          textAlign: "center",
          fontSize: typo.small,
          fontFamily: typo.mono,
          fontWeight: "700",
          color: statusColor(theme, file.status),
        }}
      >
        {statusLetter(file.status)}
      </Text>
    </Pressable>
  );
});

const DiffLineRow = memo(function DiffLineRow({
  theme,
  compact,
  typo,
  line,
  tokens,
  path,
  onPressLine,
}: {
  theme: PluginTheme;
  compact: boolean;
  typo: Typography;
  line: DiffLine;
  tokens: Token[] | undefined;
  path: string;
  onPressLine: (path: string, line: DiffLine) => void;
}) {
  const gutter = {
    width: Math.round(typo.code * (compact ? 2.8 : 3.6)),
    paddingRight: 6,
    textAlign: "right" as const,
    color: theme.colors.foregroundMuted,
    fontFamily: typo.mono,
    fontSize: typo.code - 1,
    opacity: 0.7,
  };
  const background =
    line.kind === "add"
      ? withAlpha(theme.colors.statusSuccess, 0.16)
      : line.kind === "del"
        ? withAlpha(theme.colors.statusDanger, 0.16)
        : "transparent";
  const markerColor =
    line.kind === "add"
      ? theme.colors.statusSuccess
      : line.kind === "del"
        ? theme.colors.statusDanger
        : theme.colors.foregroundMuted;
  return (
    <Pressable
      {...CODE_SURFACE_PROPS}
      accessibilityLabel="Comment on this line"
      onPress={() => onPressLine(path, line)}
      style={{ flexDirection: "row", backgroundColor: background }}
    >
      {compact ? null : <Text style={gutter}>{line.oldNo ?? ""}</Text>}
      <Text style={gutter}>{line.newNo ?? ""}</Text>
      <Text style={{ width: typo.code + 2, fontFamily: typo.mono, fontSize: typo.code, color: markerColor }}>
        {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
      </Text>
      <Text
        selectable
        style={{ flex: 1, fontFamily: typo.mono, fontSize: typo.code, color: theme.colors.foreground }}
      >
        {tokens && tokens.length > 0
          ? tokens.map(([text, color], index) => (
              <Text key={index} style={color ? { color } : undefined}>
                {text}
              </Text>
            ))
          : line.text}
      </Text>
    </Pressable>
  );
});

const PierreDiff = memo(function PierreDiff({
  api,
  theme,
  typo,
  workspaceId,
  path,
  patch,
  split,
  syntax,
  comments,
  draft,
  viewer,
  focus,
}: {
  api: PierreApi;
  theme: PluginTheme;
  typo: Typography;
  workspaceId: string;
  path: string;
  patch: string;
  split: boolean;
  syntax: string;
  comments: readonly ReviewComment[];
  draft: { side: DiffSide; line: number } | null;
  viewer: Author | null;
  focus: { side: DiffSide; line: number } | null;
}) {
  const actions = useReviewActions(workspaceId);
  const create = useCallback((host: unknown, initial: DiffViewProps) => api.createDiffView(host, initial), [api]);
  const props = useMemo<DiffViewProps>(
    () => ({
      patch,
      split,
      syntax,
      appearance: appearanceOf(theme),
      colors: pierreColorsOf(theme),
      code: pierreFontOf(typo),
      comments,
      viewer,
      draft,
      onDraft: (side, line) => startDraft(workspaceId, path, side, line),
      onAddComment: (side, line, text) => {
        cancelDraft(workspaceId);
        void actions.add({ path, side, line, text });
      },
      onCancelDraft: () => cancelDraft(workspaceId),
      onRemoveComment: (id) => void actions.remove(id),
      onEditComment: (id, text) => void actions.edit(id, text),
      focus,
      onFocused: () => clearFocus(workspaceId),
    }),
    // `actions` is a new object each render; its methods only close over the workspace id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patch, split, syntax, theme, typo, workspaceId, path, comments, draft, viewer, focus],
  );
  return <PierreMount create={create} props={props} />;
});

export function DiffPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const { compact } = layout;
  useSyncBuiltinHiding();
  const syntax = useSyntaxTheme(theme);
  const pierre = usePierre();
  const review = useReview(workspaceId);
  const comments = review.comments;
  const viewer = useViewer();
  const draft = useWorkspaceView(workspaceId, (state) => state.draft);
  const focus = useWorkspaceView(workspaceId, (state) => state.focus);
  const [reviewing, setReviewing] = useState(false);
  const [uncapped, setUncapped] = useState<Readonly<Record<string, true>>>({});
  const [picking, setPicking] = useState(false);
  const compare = useWorkspaceView(workspaceId, (state) => state.compare);
  const typo = typographyFor(useAppAppearance(), compact);
  const status = useRepoStatus(workspaceId);
  const selectedPath = useWorkspaceView(workspaceId, (state) => state.selectedPath);
  const expandedFiles = useWorkspaceView(workspaceId, (state) => state.expandedFiles);
  const ignoreWhitespace = useWorkspaceView(workspaceId, (state) => state.ignoreWhitespace);
  const split = useWorkspaceView(workspaceId, (state) => state.splitDiff) && !compact;
  const scrollNonce = useWorkspaceView(workspaceId, (state) => state.scrollNonce);
  const files = status.data?.files;
  const listRef = useRef<NativeFlatList<Item>>(null);

  const openFiles = useMemo(
    () => (files ?? []).filter((file) => expandedFiles[file.path]),
    [files, expandedFiles],
  );
  const diffs = useFileDiffs(workspaceId, openFiles, ignoreWhitespace, syntax);
  const diffVersion = diffs.map((diff) => diff.dataUpdatedAt).join(",");

  const items = useMemo(() => {
    const list: Item[] = [];
    const resultByPath = new Map(openFiles.map((file, index) => [file.path, diffs[index]]));
    for (const file of files ?? []) {
      const expanded = Boolean(expandedFiles[file.path]);
      list.push({ key: `f:${file.path}`, type: "file", file, expanded });
      if (!expanded) continue;
      const result = resultByPath.get(file.path);
      const notice = (text: string, danger = false) =>
        list.push({ key: `n:${file.path}`, type: "notice", text, danger });
      if (!result || result.isPending) notice("Loading diff…");
      else if (result.isError) notice(`Could not read diff: ${result.error.message}`, true);
      else if (result.data.tooLarge) notice("This diff is too large to display.");
      else if (result.data.binary) notice("Binary file not shown.");
      else {
        const rows = cachedRows(result.data.patch);
        if (rows.length === 0) notice("No textual changes.");
        else if (pierre) {
          const limited = uncapped[file.path]
            ? { patch: result.data.patch, truncated: false }
            : limitPatch(result.data.patch, PIERRE_MAX_PATCH_LINES);
          list.push({ key: `p:${file.path}`, type: "pierre", path: file.path, ...limited });
          continue;
        }
        let lineIndex = 0;
        for (const row of rows) {
          const key = `${file.path}:${row.key}`;
          if (row.type === "hunk") list.push({ key, type: "hunk", header: row.header });
          else {
            list.push({ key, type: "line", path: file.path, line: row.line, tokens: result.data.tokens?.[lineIndex++] });
            const side: DiffSide = row.line.kind === "del" ? "deletions" : "additions";
            const number = side === "deletions" ? row.line.oldNo : row.line.newNo;
            if (number === null || number === undefined || row.line.kind === "meta") continue;
            for (const comment of comments) {
              if (comment.path === file.path && comment.side === side && comment.line === number) {
                list.push({ key: `c:${comment.id}`, type: "comment", comment });
              }
            }
            if (draft && draft.path === file.path && draft.side === side && draft.line === number) {
              list.push({ key: `d:${file.path}:${side}:${number}`, type: "draft", path: file.path, side, line: number });
            }
          }
        }
      }
    }
    return list;
    // `diffVersion` stands in for the query results, which are a new array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, expandedFiles, openFiles, diffVersion, pierre, uncapped, comments, draft]);

  useEffect(() => {
    if (pierre || !focus) return;
    const index = items.findIndex((item) => item.type === "comment" && item.comment.path === focus.path && item.comment.side === focus.side && item.comment.line === focus.line);
    if (index < 0) return;
    listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.3 });
    clearFocus(workspaceId);
  }, [pierre, focus, items, workspaceId]);

  const lastNonce = useRef(scrollNonce);
  useEffect(() => {
    if (scrollNonce === lastNonce.current || !selectedPath) return;
    lastNonce.current = scrollNonce;
    const index = items.findIndex((item) => item.type === "file" && item.file.path === selectedPath);
    if (index >= 0) listRef.current?.scrollToIndex({ index, animated: false });
  }, [scrollNonce, selectedPath, items]);

  const commentsByPath = useMemo(() => {
    const byPath = new Map<string, ReviewComment[]>();
    for (const comment of comments) byPath.set(comment.path, [...(byPath.get(comment.path) ?? []), comment]);
    return byPath;
  }, [comments]);

  const onOpenComments = useCallback(
    (path: string) => {
      const first = commentsByPath.get(path)?.[0];
      if (first) goToComment(workspaceId, first);
    },
    [commentsByPath, workspaceId],
  );
  const reviewActions = useReviewActions(workspaceId);
  const onPressLine = useCallback(
    (path: string, line: DiffLine) => {
      if (line.kind === "meta") return;
      const side: DiffSide = line.kind === "del" ? "deletions" : "additions";
      const number = side === "deletions" ? line.oldNo : line.newNo;
      if (number !== null && number !== undefined) startDraft(workspaceId, path, side, number);
    },
    [workspaceId],
  );
  const onEditComment = useCallback((id: string, text: string) => void reviewActions.edit(id, text), [reviewActions]);
  const onRemoveComment = useCallback((id: string) => void reviewActions.remove(id), [reviewActions]);
  const onToggleFile = useCallback(
    (path: string) => {
      updateWorkspaceView(workspaceId, () => ({ selectedPath: path }));
      toggleFileExpanded(workspaceId, path);
    },
    [workspaceId],
  );
  const renderItem = useCallback(
    ({ item }: { item: Item }) => {
      switch (item.type) {
        case "file":
          return (
            <FileHeader
              theme={theme}
              compact={compact}
              typo={typo}
              file={item.file}
              expanded={item.expanded}
              selected={item.file.path === selectedPath}
              onToggle={onToggleFile}
              pierre={pierre}
              appearance={appearanceOf(theme)}
              commentCount={commentsByPath.get(item.file.path)?.length ?? 0}
              onOpenComments={onOpenComments}
            />
          );
        case "hunk":
          return (
            <View {...CODE_SURFACE_PROPS} style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: theme.colors.surface2 }}>
              <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontFamily: typo.mono, fontSize: typo.code }}>
                {item.header}
              </Text>
            </View>
          );
        case "line":
          return (
            <DiffLineRow
              theme={theme}
              compact={compact}
              typo={typo}
              line={item.line}
              tokens={item.tokens}
              path={item.path}
              onPressLine={onPressLine}
            />
          );
        case "comment":
          return (
            <NativeComment
              theme={theme}
              typo={typo}
              compact={compact}
              comment={item.comment}
              onEdit={onEditComment}
              onRemove={onRemoveComment}
            />
          );
        case "draft":
          return (
            <NativeDraft
              theme={theme}
              typo={typo}
              compact={compact}
              viewer={viewer ?? null}
              onAdd={(text) => {
                cancelDraft(workspaceId);
                void reviewActions.add({ path: item.path, side: item.side, line: item.line, text });
              }}
              onCancel={() => cancelDraft(workspaceId)}
            />
          );
        case "pierre":
          return pierre ? (
            <View>
              <PierreDiff
                api={pierre}
                theme={theme}
                typo={typo}
                workspaceId={workspaceId}
                path={item.path}
                patch={item.patch}
                split={split}
                syntax={syntax ?? ""}
                comments={commentsByPath.get(item.path) ?? NO_COMMENTS}
                draft={draft && draft.path === item.path ? draft : null}
                viewer={viewer ?? null}
                focus={focus && focus.path === item.path ? focus : null}
              />
              {item.truncated ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setUncapped((current) => ({ ...current, [item.path]: true }))}
                  style={{ padding: 10, backgroundColor: theme.colors.surface1 }}
                >
                  <Text style={{ color: theme.colors.accent, fontSize: typo.ui }}>
                    Large diff cut short. Show all lines
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null;
        case "notice":
          return (
            <Text style={{ padding: 12, fontSize: typo.ui, color: item.danger ? theme.colors.statusDanger : theme.colors.foregroundMuted }}>
              {item.text}
            </Text>
          );
      }
    },
    [theme, compact, typo, selectedPath, onToggleFile, pierre, split, syntax, workspaceId, commentsByPath, draft, viewer, focus, onOpenComments, onPressLine, onEditComment, onRemoveComment, reviewActions],
  );

  const anyOpen = files !== undefined && files.some((file) => expandedFiles[file.path]);
  const total = useMemo(
    () => ({
      additions: (files ?? []).reduce((sum, file) => sum + file.additions, 0),
      deletions: (files ?? []).reduce((sum, file) => sum + file.deletions, 0),
    }),
    [files],
  );

  let body;
  if (reviewing) {
    body = (
      <ReviewScreen
        theme={theme}
        compact={compact}
        typo={typo}
        workspaceId={workspaceId}
        state={review.state}
        scope={status.data ? compareLabel(status.data.applied) : "uncommitted"}
        onClose={() => setReviewing(false)}
        onGoToComment={(comment) => {
          setReviewing(false);
          goToComment(workspaceId, comment);
        }}
      />
    );
  } else if (picking) {
    body = (
      <ComparePicker
        theme={theme}
        compact={compact}
        typo={typo}
        workspaceId={workspaceId}
        compare={compare}
        defaultBase={status.data?.defaultBase ?? null}
        onChange={(next) => setCompare(workspaceId, next)}
        onClose={() => setPicking(false)}
      />
    );
  } else if (status.isError) {
    body = <Text style={{ padding: 16, fontSize: typo.ui, color: theme.colors.statusDanger }}>{`Could not read changes: ${status.error.message}`}</Text>;
  } else if (status.isPending) {
    body = <Text style={{ padding: 16, fontSize: typo.ui, color: theme.colors.foregroundMuted }}>Loading changes…</Text>;
  } else if (!files || files.length === 0) {
    body = <Text style={{ padding: 16, fontSize: typo.ui, color: theme.colors.foregroundMuted }}>No uncommitted changes</Text>;
  } else {
    body = (
      <FlatList
        ref={listRef}
        data={items}
        renderItem={renderItem}
        keyExtractor={(item) => item.key}
        initialNumToRender={40}
        windowSize={11}
        maxToRenderPerBatch={40}
        onScrollToIndexFailed={({ index, averageItemLength }) => {
          listRef.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
          setTimeout(() => listRef.current?.scrollToIndex({ index, animated: false }), 50);
        }}
      />
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <HeaderBar theme={theme} compact={compact}>
        <HeaderButton
          theme={theme}
          compact={compact}
          icon="GitCompare"
          label="Choose what to compare"
          active={picking}
          onPress={() => setPicking((open) => !open)}
        />
        <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: typo.ui }}>
          {status.data ? `${compareLabel(status.data.applied)} · ${files?.length ?? 0} ${files?.length === 1 ? "file" : "files"}` : ""}
        </Text>
        {files && files.length > 0 ? (
          <>
            <Text style={{ color: theme.colors.statusSuccess, fontSize: typo.small }}>{`+${total.additions}`}</Text>
            <Text style={{ color: theme.colors.statusDanger, fontSize: typo.small }}>{`-${total.deletions}`}</Text>
          </>
        ) : null}
        <HeaderButton
          theme={theme}
          compact={compact}
          icon={anyOpen ? "ListChevronsDownUp" : "ListChevronsUpDown"}
          label={anyOpen ? "Collapse all files" : "Expand all files"}
          disabled={!files || files.length === 0}
          onPress={() =>
            setExpandedFiles(workspaceId, anyOpen ? [] : (files ?? []).slice(0, EXPAND_ALL_LIMIT).map((file) => file.path))
          }
        />
        <HeaderButton
          theme={theme}
          compact={compact}
          icon="MessageSquare"
          label={review.state.pending.length > 0 ? `Finish review (${review.state.pending.length} pending)` : "Review"}
          active={reviewing || review.state.pending.length > 0}
          onPress={() => setReviewing((open) => !open)}
        />
        {pierre && !compact ? (
          <HeaderButton
            theme={theme}
            compact={compact}
            icon="Columns2"
            label="Side-by-side diff"
            active={split}
            onPress={() => updateWorkspaceView(workspaceId, (state) => ({ splitDiff: !state.splitDiff }))}
          />
        ) : null}
        <HeaderButton
          theme={theme}
          compact={compact}
          icon="Pilcrow"
          label="Hide whitespace changes"
          active={ignoreWhitespace}
          onPress={() => updateWorkspaceView(workspaceId, (state) => ({ ignoreWhitespace: !state.ignoreWhitespace }))}
        />
        <HeaderButton
          theme={theme}
          compact={compact}
          icon="RotateCw"
          label="Refresh diffs"
          busy={status.isFetching || diffs.some((diff) => diff.isFetching)}
          onPress={() => void Promise.all([status.refetch(), ...diffs.map((diff) => diff.refetch())])}
        />
      </HeaderBar>
      {reviewing ? null : (
        <ReviewBar theme={theme} typo={typo} state={review.state} viewer={viewer} onPress={() => setReviewing(true)} />
      )}
      {body}
    </View>
  );
}
