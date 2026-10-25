import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { FlatList, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useRpc, useTabState } from "@getpaseo/plugin/client";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { z } from "zod";

import { writeFileRpc } from "../shared/contracts.js";
import type { FileViewProps } from "../shared/pierre-api.js";
import { useAppAppearance } from "./appearance.js";
import { useFile, useSyntaxTheme, useWorkspaceDirectory } from "./data.js";
import { useFileActions } from "./file-actions.js";
import { useSyncBuiltinHiding } from "./hide-builtins.js";
import { HeaderBar, HeaderButton } from "./panel-header.js";
import { updateWorkspaceView, useWorkspaceView } from "./store.js";
import { isMarkdownPath, MarkdownPreview, MediaPreview } from "./file-preview.js";
import { PierreMount, usePierre } from "./pierre.js";
import { CODE_SURFACE_PROPS, appearanceOf, pierreColorsOf, pierreFontOf, typographyFor, type Typography } from "./styling.js";

// What the tab remembers across reloads.
const tabStateSchema = z.object({ path: z.string().nullable(), rendered: z.boolean() });
const DEFAULT_TAB_STATE = { path: null, rendered: true };

type LineToken = [text: string, color: string];

const FileLine = memo(function FileLine({
  number,
  text,
  tokens,
  foreground,
  muted,
  typo,
}: {
  number: number;
  text: string;
  tokens: LineToken[] | undefined;
  foreground: string;
  muted: string;
  typo: Typography;
}) {
  return (
    <View {...CODE_SURFACE_PROPS} style={{ flexDirection: "row" }}>
      <Text style={{ width: 52, paddingRight: 10, textAlign: "right", fontFamily: typo.mono, fontSize: typo.code, color: muted }}>
        {number}
      </Text>
      <Text selectable style={{ flex: 1, fontFamily: typo.mono, fontSize: typo.code, color: foreground }}>
        {tokens && tokens.length > 0
          ? tokens.map(([part, color], index) => (
              <Text key={index} style={{ color }}>
                {part}
              </Text>
            ))
          : text === ""
            ? " "
            : text}
      </Text>
    </View>
  );
});

/** Shows one file with syntax colors, and edits and saves it. */
export function FilePanel({ theme, layout, workspaceId, tab }: PluginWorkspacePanelProps) {
  const { compact } = layout;
  useSyncBuiltinHiding();
  const typo = typographyFor(useAppAppearance(), compact);
  const storedPath = useWorkspaceView(workspaceId, (state) => state.filePath);
  const [tabState, setTabState] = useTabState(tab, tabStateSchema, DEFAULT_TAB_STATE);
  // Opening a file sets the store; a restored tab brings its file back from its saved state.
  const path = storedPath ?? tabState.path;
  const startInEdit = useWorkspaceView(workspaceId, (state) => state.fileEdit);
  const syntax = useSyntaxTheme(theme);
  const file = useFile(workspaceId, path, syntax);
  const cwd = useWorkspaceDirectory(workspaceId);
  const write = useRpc(writeFileRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const runAction = useFileActions(workspaceId);
  const pierre = usePierre();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const rendered = tabState.rendered;

  useEffect(() => {
    if (storedPath !== null && storedPath !== tabState.path) setTabState({ ...tabState, path: storedPath });
  }, [storedPath, tabState, setTabState]);
  // Opening a file (or choosing Edit on it) resets the editor.
  useEffect(() => {
    setDraft(null);
  }, [path]);
  useEffect(() => {
    if (startInEdit && file.data && file.data.kind === "text" && !file.data.binary && !file.data.tooLarge) {
      setDraft((current) => current ?? file.data.content);
      updateWorkspaceView(workspaceId, () => ({ fileEdit: false }));
    }
  }, [startInEdit, file.data, workspaceId]);

  const lines = useMemo(() => (file.data ? file.data.content.split("\n") : []), [file.data]);
  const save = useCallback(async () => {
    if (path === null || draft === null || !file.data) return;
    setSaving(true);
    try {
      await write({ cwd: cwd ?? "", path, content: draft, expectedMtimeMs: file.data.mtimeMs });
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ["prism"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }, [path, draft, file.data, write, cwd, queryClient, toast]);

  const create = useCallback(
    (host: unknown, initial: FileViewProps) => pierre?.createFileView(host, initial) ?? { update() {}, destroy() {} },
    [pierre],
  );
  const viewProps = useMemo<FileViewProps | null>(
    () =>
      path && syntax && file.data
        ? {
            name: path,
            content: file.data.content,
            editing: draft !== null,
            syntax,
            appearance: appearanceOf(theme),
            colors: pierreColorsOf(theme),
            code: pierreFontOf(typo),
            onEdit: setDraft,
          }
        : null,
    [path, syntax, file.data, draft !== null, theme, typo],
  );

  const media = file.data && file.data.kind !== "text" ? { ...file.data, kind: file.data.kind } : null;
  const markdown = path !== null && isMarkdownPath(path) && file.data?.kind === "text";
  const editable = Boolean(file.data && file.data.kind === "text" && !file.data.binary && !file.data.tooLarge);
  const dirty = draft !== null && draft !== file.data?.content;
  useEffect(() => {
    tab.setModified(dirty);
  }, [tab, dirty]);
  const notice = !path
    ? "Open a file from the Files panel."
    : file.isError
      ? `Could not open ${path}: ${file.error.message}`
      : file.data?.binary
        ? "No preview for this binary file."
        : file.data?.tooLarge
          ? "File is too large to show (over 1 MB)."
          : null;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <HeaderBar theme={theme} compact={compact}>
        <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: typo.ui }}>
          {path ?? "File"}
          {dirty ? " •" : ""}
        </Text>
        {path ? (
          <HeaderButton theme={theme} compact={compact} icon="Copy" label="Copy path" onPress={() => runAction("copy-path", path)} />
        ) : null}
        <HeaderButton
          theme={theme}
          compact={compact}
          icon="RotateCw"
          label="Reload file"
          busy={file.isFetching}
          disabled={!path}
          onPress={() => {
            setDraft(null);
            void file.refetch();
          }}
        />
        {markdown && draft === null ? (
          <HeaderButton
            theme={theme}
            compact={compact}
            icon={rendered ? "Code" : "Eye"}
            label={rendered ? "Show Markdown source" : "Show Markdown preview"}
            onPress={() => setTabState({ ...tabState, rendered: !rendered })}
          />
        ) : null}
        {draft === null ? (
          <HeaderButton
            theme={theme}
            compact={compact}
            icon="Pencil"
            label="Edit file"
            disabled={!editable}
            onPress={() => setDraft(file.data?.content ?? "")}
          />
        ) : (
          <>
            <HeaderButton theme={theme} compact={compact} icon="X" label="Discard changes" onPress={() => setDraft(null)} />
            <HeaderButton theme={theme} compact={compact} icon="Save" label="Save file" busy={saving} disabled={!dirty} onPress={() => void save()} />
          </>
        )}
      </HeaderBar>
      {notice ? (
        <Text style={{ color: theme.colors.foregroundMuted, padding: 16, fontSize: typo.ui }}>{notice}</Text>
      ) : media && path ? (
        <MediaPreview api={pierre} theme={theme} typo={typo} workspaceId={workspaceId} path={path} file={media} />
      ) : markdown && rendered && draft === null && file.data ? (
        <MarkdownPreview theme={theme} typo={typo} text={file.data.content} />
      ) : pierre && viewProps ? (
        <PierreMount create={create} props={viewProps} style={{ flex: 1 }} />
      ) : draft !== null ? (
        <TextInput
          {...CODE_SURFACE_PROPS}
          multiline
          value={draft}
          onChangeText={setDraft}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          style={{
            flex: 1,
            padding: 12,
            textAlignVertical: "top",
            color: theme.colors.foreground,
            fontFamily: typo.mono,
            fontSize: typo.code,
          }}
        />
      ) : (
        <FlatList
          data={lines}
          keyExtractor={(_, index) => String(index)}
          initialNumToRender={60}
          renderItem={({ item, index }) => (
            <FileLine
              number={index + 1}
              text={item}
              tokens={file.data?.tokens?.[index]}
              foreground={theme.colors.foreground}
              muted={theme.colors.foregroundMuted}
              typo={typo}
            />
          )}
        />
      )}
    </View>
  );
}
