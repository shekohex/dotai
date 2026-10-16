import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Image as RNImage, Pressable, Text, View } from "react-native";
import { imageRpc, shareRpc } from "../../shared/media";
import { useBidi } from "../bidi";
import { FONT, GAP, RADIUS, useUiEnv } from "../tokens";
import type { NodeProps } from "./types";

type Loaded = { uri: string } | { error: string };

/** Images stay loaded while the timeline remounts rows as they scroll. */
const images = new Map<string, Promise<Loaded>>();

function useOpenFile() {
  const { agentId } = useUiEnv();
  const share = useRpc(shareRpc);
  const toast = useToast();
  return (path: string) => {
    share({ agentId, path }).then(
      ({ url }) => void openExternalUrl(url),
      (error: unknown) => toast.error(error instanceof Error ? error.message : "Could not open the file"),
    );
  };
}

export function Image({ props }: NodeProps) {
  const { colors, agentId } = useUiEnv();
  const bidi = useBidi();
  const load = useRpc(imageRpc);
  const open = useOpenFile();
  const src = String(props.src ?? "");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [ratio, setRatio] = useState(16 / 9);

  useEffect(() => {
    let alive = true;
    const key = `${agentId}\0${src}`;
    let pending = images.get(key);
    if (!pending) {
      pending = load({ agentId, path: src }).then(
        ({ mime, data }): Loaded => ({ uri: `data:${mime};base64,${data}` }),
        (error: unknown): Loaded => ({ error: error instanceof Error ? error.message : "Could not load the image" }),
      );
      images.set(key, pending);
    }
    void pending.then((result) => {
      if (alive) setLoaded(result);
    });
    return () => {
      alive = false;
    };
  }, [agentId, src]);

  return (
    <View style={{ gap: GAP.xs }}>
      {loaded === null ? (
        <View style={{ aspectRatio: ratio, alignItems: "center", justifyContent: "center", borderRadius: RADIUS.s, backgroundColor: colors.surface2 }}>
          <ActivityIndicator color={colors.foregroundMuted} />
        </View>
      ) : "error" in loaded ? (
        <View style={{ flexDirection: "row", gap: GAP.s, alignItems: "center", padding: GAP.m, borderRadius: RADIUS.s, backgroundColor: colors.surface2 }}>
          <Icon name="ImageOff" size={16} color={colors.foregroundMuted} />
          <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: FONT.s }}>{loaded.error}</Text>
        </View>
      ) : (
        <Pressable accessibilityRole="imagebutton" accessibilityLabel={props.alt ?? "Open image"} onPress={() => open(src)}>
          <RNImage
            source={{ uri: loaded.uri }}
            accessibilityLabel={props.alt}
            resizeMode="contain"
            onLoad={(event) => {
              const { width, height } = event.nativeEvent.source;
              if (width > 0 && height > 0) setRatio(width / height);
            }}
            style={{ width: "100%", aspectRatio: ratio, borderRadius: RADIUS.s, backgroundColor: colors.surface2 }}
          />
        </Pressable>
      )}
      {props.caption ? <Text style={{ color: colors.foregroundMuted, fontSize: FONT.s, ...bidi.text(String(props.caption)) }}>{props.caption}</Text> : null}
    </View>
  );
}

function fileIcon(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (["mp4", "m4v", "mov", "webm"].includes(ext)) return "CirclePlay";
  if (["mp3", "m4a", "wav", "ogg"].includes(ext)) return "Music";
  if (ext === "pdf") return "FileText";
  if (ext === "html" || ext === "htm") return "Globe";
  return "File";
}

function FileCard({ src, title, hint }: { src: string; title: string; hint: string }) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const open = useOpenFile();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${hint}`}
      onPress={() => open(src)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: GAP.m,
        padding: GAP.m,
        borderRadius: RADIUS.m,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface2,
        opacity: pressed ? 0.8 : 1,
        ...bidi.row(title),
      })}
    >
      <Icon name={fileIcon(src)} size={28} color={colors.accent} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: FONT.m, fontWeight: "600", ...bidi.text(title) }}>
          {title}
        </Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: FONT.s, ...bidi.text(hint) }}>{hint}</Text>
      </View>
      <Icon name="ExternalLink" size={16} color={colors.foregroundMuted} />
    </Pressable>
  );
}

const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function Video({ props }: NodeProps) {
  const src = String(props.src ?? "");
  return <FileCard src={src} title={props.title ?? basename(src)} hint="Opens in your browser" />;
}

export function Attachment({ props }: NodeProps) {
  const src = String(props.src ?? "");
  return <FileCard src={src} title={props.label ?? basename(src)} hint="Opens in your browser" />;
}
