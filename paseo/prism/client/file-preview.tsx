import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Markdown, ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { Image, Text, View } from "react-native";

import { fileBytesRpc, mediaUrlRpc, type MediaKind } from "../shared/contracts.js";
import type { MediaViewProps, PierreApi } from "../shared/pierre-api.js";
import { useWorkspaceDirectory } from "./data.js";
import { PierreMount } from "./pierre.js";
import { appearanceOf, pierreColorsOf, type Typography } from "./styling.js";

const NATIVE_IMAGE_LIMIT_BYTES = 8 * 1024 * 1024;
// A multiple of three, so the base64 slices join into one valid string.
const NATIVE_SLICE_BYTES = 3 * 170_000;

export interface MediaFile {
  kind: Exclude<MediaKind, "text">;
  mimeType: string;
  size: number;
  mtimeMs: number;
}

export const isMarkdownPath = (path: string) => /\.(md|mdx|markdown)$/i.test(path);

/** An image, video, audio file or PDF. Web and desktop play them; phones can show images. */
export function MediaPreview({
  api,
  theme,
  typo,
  workspaceId,
  path,
  file,
}: {
  api: PierreApi | null;
  theme: PluginTheme;
  typo: Typography;
  workspaceId: string;
  path: string;
  file: MediaFile;
}) {
  const cwd = useWorkspaceDirectory(workspaceId);
  const readBytes = useRpc(fileBytesRpc);
  const mediaUrl = useRpc(mediaUrlRpc);
  const fetchChunk = useCallback(
    (offset: number, length: number) => readBytes({ cwd: cwd ?? "", path, offset, length }).then((result) => result.chunk),
    [readBytes, cwd, path],
  );
  const getUrls = useCallback(() => mediaUrl({ cwd: cwd ?? "", path }).then((result) => result.urls), [mediaUrl, cwd, path]);
  const create = useCallback(
    (host: unknown, initial: MediaViewProps) => api?.createMediaView(host, initial) ?? { update() {}, destroy() {} },
    [api],
  );
  const props = useMemo<MediaViewProps>(
    () => ({
      name: path,
      kind: file.kind,
      mimeType: file.mimeType,
      size: file.size,
      version: file.mtimeMs,
      appearance: appearanceOf(theme),
      colors: pierreColorsOf(theme),
      fetchChunk,
      getUrls,
    }),
    [path, file, theme, fetchChunk, getUrls],
  );
  const nativeImage = useQuery({
    queryKey: ["prism", "native-image", cwd, path, file.mtimeMs],
    queryFn: async () => {
      const parts: string[] = [];
      for (let offset = 0; offset < file.size; offset += NATIVE_SLICE_BYTES) parts.push(await fetchChunk(offset, NATIVE_SLICE_BYTES));
      return `data:${file.mimeType};base64,${parts.join("")}`;
    },
    enabled: !api && file.kind === "image" && file.size <= NATIVE_IMAGE_LIMIT_BYTES,
    gcTime: 0,
  });

  if (api) return <PierreMount create={create} props={props} style={{ flex: 1 }} />;
  const notice = { color: theme.colors.foregroundMuted, padding: 16, fontSize: typo.ui };
  if (file.kind !== "image") return <Text style={notice}>{`Playing ${file.kind === "pdf" ? "PDFs" : file.kind} is only available on web and desktop.`}</Text>;
  if (file.size > NATIVE_IMAGE_LIMIT_BYTES) return <Text style={notice}>Image is too large to preview on mobile (over 8 MB).</Text>;
  if (nativeImage.isError) return <Text style={notice}>{`Could not load image: ${nativeImage.error.message}`}</Text>;
  if (!nativeImage.data) return <Text style={notice}>Loading…</Text>;
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <Image source={{ uri: nativeImage.data }} resizeMode="contain" style={{ flex: 1 }} />
    </View>
  );
}

/** Rendered Markdown, drawn by the host on every platform. */
export function MarkdownPreview({ theme, typo, text }: { theme: PluginTheme; typo: Typography; text: string }) {
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: typo.ui + 6 }}>
      <Markdown>{text}</Markdown>
    </ScrollView>
  );
}
