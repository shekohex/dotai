import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { createElement, useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { EMBED_MAX_HTML, embedHeight, embedOpenRpc, embedRpc, embedSource, htmlDocument } from "../../shared/embed";
import { useBidi } from "../bidi";
import { FONT, GAP, RADIUS, useUiEnv } from "../tokens";
import type { NodeProps } from "./types";

type Request = { src: string } | { html: string };
type Resolved = { url: string } | { doc: string } | { error: string };

const EXTERNAL_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-forms allow-presentation";
// Our own HTML never gets same-origin: it would then share the app's origin and could reach into it.
const OWN_SANDBOX = "allow-scripts allow-popups allow-forms allow-modals";

function hostOf(url: string): string {
  return /^[a-z]+:\/\/([^/]+)/i.exec(url)?.[1] ?? url;
}

/** What to frame: a URL as is, or the page's own HTML as text (read by the daemon for a file), so nothing depends on a server being reachable. */
function useResolved(request: Request): Resolved | null {
  const { agentId } = useUiEnv();
  const read = useRpc(embedRpc);
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const key = "html" in request ? `html\0${request.html}` : request.src;
  useEffect(() => {
    if ("html" in request) {
      setResolved(request.html.length > EMBED_MAX_HTML ? { error: "The HTML is too large to embed" } : { doc: htmlDocument(request.html) });
      return;
    }
    const source = embedSource(request.src);
    if (source.kind === "url") setResolved({ url: source.url });
    else if (source.kind === "invalid") setResolved({ error: source.reason });
    else {
      let alive = true;
      read({ agentId, path: source.path }).then(
        ({ html }) => alive && setResolved({ doc: html }),
        (error: unknown) => alive && setResolved({ error: error instanceof Error ? error.message : "Could not load the page" }),
      );
      return () => {
        alive = false;
      };
    }
  }, [key, agentId]);
  return resolved;
}

function Frame({ request, title, height }: { request: Request; title: string; height: number }) {
  const { colors, agentId } = useUiEnv();
  const bidi = useBidi();
  const toast = useToast();
  const openPage = useRpc(embedOpenRpc);
  const resolved = useResolved(request);
  const label = title || ("html" in request ? "HTML" : hostOf(request.src));

  /** A URL opens directly; our own HTML is served by the daemon for the moment (Tailscale or network address). */
  function open() {
    if (!resolved || "error" in resolved) return;
    if ("url" in resolved) {
      void openExternalUrl(resolved.url);
      return;
    }
    openPage({ agentId, ...("html" in request ? { html: request.html } : { path: request.src }) }).then(
      ({ url }) => void openExternalUrl(url),
      (error: unknown) => toast.error(error instanceof Error ? error.message : "Could not open the page"),
    );
  }

  return (
    <View style={{ gap: GAP.xs }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: GAP.s, ...bidi.row(label) }}>
        <Icon name="Globe" size={14} color={colors.foregroundMuted} />
        <Text numberOfLines={1} style={{ flex: 1, color: colors.foregroundMuted, fontSize: FONT.s + 1, ...bidi.text(label) }}>{label}</Text>
        {resolved && !("error" in resolved) ? (
          <Pressable accessibilityRole="link" accessibilityLabel="Open in browser" hitSlop={8} onPress={open}>
            <Icon name="ExternalLink" size={15} color={colors.foregroundMuted} />
          </Pressable>
        ) : null}
      </View>
      {resolved === null ? (
        <View style={{ height, alignItems: "center", justifyContent: "center", borderRadius: RADIUS.s, backgroundColor: colors.surface2 }}>
          <ActivityIndicator color={colors.foregroundMuted} />
        </View>
      ) : "error" in resolved ? (
        <View style={{ flexDirection: "row", gap: GAP.s, alignItems: "center", padding: GAP.m, borderRadius: RADIUS.s, backgroundColor: colors.surface2 }}>
          <Icon name="TriangleAlert" size={16} color={colors.statusWarning} />
          <Text style={{ flex: 1, color: colors.statusWarning, fontSize: FONT.s + 1, ...bidi.text(resolved.error) }}>{resolved.error}</Text>
        </View>
      ) : Platform.OS === "web" ? (
        <View style={{ height, borderRadius: RADIUS.s, overflow: "hidden", borderWidth: 1, borderColor: colors.border }}>
          {createElement("iframe", {
            ...("url" in resolved ? { src: resolved.url, sandbox: EXTERNAL_SANDBOX } : { srcDoc: resolved.doc, sandbox: OWN_SANDBOX }),
            title: label,
            referrerPolicy: "strict-origin-when-cross-origin",
            allow: "fullscreen; picture-in-picture; encrypted-media; clipboard-write",
            allowFullScreen: true,
            style: { width: "100%", height: "100%", border: 0, background: "#ffffff" },
          })}
        </View>
      ) : (
        <Pressable
          accessibilityRole="link"
          onPress={open}
          style={{ flexDirection: "row", alignItems: "center", gap: GAP.m, padding: GAP.m, borderRadius: RADIUS.s, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2, ...bidi.row(label) }}
        >
          <Icon name="AppWindow" size={28} color={colors.accent} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: FONT.m, fontWeight: "600", ...bidi.text(label) }}>{label}</Text>
            <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: FONT.s, writingDirection: "ltr" }}>{"url" in resolved ? hostOf(resolved.url) : "Interactive page"}</Text>
          </View>
          <Icon name="ExternalLink" size={16} color={colors.foregroundMuted} />
        </Pressable>
      )}
    </View>
  );
}

export function Embed({ props }: NodeProps) {
  return <Frame request={{ src: String(props.src ?? "") }} title={String(props.title ?? "")} height={embedHeight(props.height)} />;
}

export function Html({ props }: NodeProps) {
  return <Frame request={{ html: String(props.code ?? "") }} title={String(props.title ?? "")} height={embedHeight(props.height)} />;
}
