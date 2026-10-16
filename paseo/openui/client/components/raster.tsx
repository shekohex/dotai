import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Image as RNImage, PixelRatio, Text, View } from "react-native";
import type { RASTER_KINDS } from "../../shared/raster";
import { rasterRpc } from "../../shared/raster";
import { useBidi } from "../bidi";
import { FONT, GAP, RADIUS, useUiEnv } from "../tokens";
import type { NodeProps } from "./types";

type Kind = (typeof RASTER_KINDS)[number];
type Loaded = { uri: string; width: number; height: number } | { error: string };

/** Drawings stay loaded while the timeline remounts rows as they scroll. */
const drawings = new Map<string, Promise<Loaded>>();

/** SVG, LaTeX, DOT and QR sources, drawn by the daemon as a PNG sized to the card. */
function Raster({ kind, source, display, caption, align }: { kind: Kind; source: string; display?: boolean; caption?: unknown; align?: "center" | "start" }) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const render = useRpc(rasterRpc);
  const [maxWidth, setMaxWidth] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const scale = Math.min(4, Math.max(1, Math.ceil(PixelRatio.get())));

  useEffect(() => {
    if (maxWidth === 0) return;
    let alive = true;
    const key = JSON.stringify([kind, source, display, colors.foreground, scale, maxWidth]);
    let pending = drawings.get(key);
    if (!pending) {
      pending = render({ kind, source, ...(display === undefined ? {} : { display }), color: colors.foreground.slice(0, 7), scale, maxWidth }).then(
        ({ data, width, height }): Loaded => ({ uri: `data:image/png;base64,${data}`, width, height }),
        (error: unknown): Loaded => ({ error: error instanceof Error ? error.message : "Could not draw this" }),
      );
      drawings.set(key, pending);
    }
    void pending.then((result) => {
      if (alive) setLoaded(result);
    });
    return () => {
      alive = false;
    };
  }, [kind, source, display, colors.foreground, scale, maxWidth]);

  return (
    <View style={{ gap: GAP.xs }} onLayout={(event) => setMaxWidth(Math.floor(event.nativeEvent.layout.width))}>
      {loaded === null ? (
        <View style={{ height: 56, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.foregroundMuted} />
        </View>
      ) : "error" in loaded ? (
        <View style={{ flexDirection: "row", gap: GAP.s, alignItems: "center", padding: GAP.m, borderRadius: RADIUS.s, backgroundColor: colors.surface2 }}>
          <Icon name="TriangleAlert" size={16} color={colors.statusWarning} />
          <Text selectable style={{ flex: 1, color: colors.foregroundMuted, fontSize: FONT.s, ...bidi.text(loaded.error) }}>{loaded.error}</Text>
        </View>
      ) : (
        <RNImage
          source={{ uri: loaded.uri }}
          resizeMode="contain"
          style={{ width: loaded.width, height: loaded.height, alignSelf: align === "center" ? "center" : "flex-start", maxWidth: "100%" }}
        />
      )}
      {caption ? <Text style={{ color: colors.foregroundMuted, fontSize: FONT.s, ...bidi.text(String(caption)), textAlign: "center" }}>{String(caption)}</Text> : null}
    </View>
  );
}

export function Latex({ props }: NodeProps) {
  return <Raster kind="latex" source={String(props.tex ?? "")} display={props.inline !== true} caption={props.caption} align={props.inline === true ? "start" : "center"} />;
}

export function Svg({ props }: NodeProps) {
  return <Raster kind="svg" source={String(props.source ?? "")} caption={props.caption} align="center" />;
}

export function Graph({ props }: NodeProps) {
  return <Raster kind="dot" source={String(props.dot ?? "")} caption={props.caption} align="center" />;
}

export function QrCode({ props }: NodeProps) {
  return <Raster kind="qr" source={String(props.value ?? "")} caption={props.caption} align="center" />;
}
