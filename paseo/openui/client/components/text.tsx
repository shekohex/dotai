import { openExternalUrl } from "@getpaseo/plugin/client";
import { copyText, Icon as HostIcon, useToast } from "@getpaseo/plugin/client/react-native";
import { Fragment } from "react";
import { Pressable, ScrollView, Text as RNText, View } from "react-native";
import { type Block, parseMarkdown, type Span } from "../../shared/markdown";
import { LTR_TEXT, useBidi } from "../bidi";
import { FONT, GAP, MONO, RADIUS, toneColor, type Tone, useUiEnv, wash } from "../tokens";
import { AnimatedIcon } from "./animated-icon";
import type { NodeProps } from "./types";

const HEADINGS = [FONT.h1, FONT.h2, FONT.h3];

export function Heading({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const level = Math.min(Math.max(Math.round(props.level ?? 2), 1), 3);
  const heading = (
    <RNText
      accessibilityRole="header"
      selectable
      style={{ color: colors.foreground, fontSize: HEADINGS[level - 1], fontWeight: "600", ...bidi.text(String(props.text ?? "")) }}
    >
      {props.text}
    </RNText>
  );
  if (!props.icon) return heading;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: GAP.s, ...bidi.row(String(props.text ?? "")) }}>
      <AnimatedIcon name={String(props.icon)} size={HEADINGS[level - 1] as number} color={colors.accent} />
      <View style={{ flexShrink: 1 }}>{heading}</View>
    </View>
  );
}

export function Text({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const size = { s: FONT.s, m: FONT.m, l: FONT.l }[(props.size as "s" | "m" | "l") ?? "m"];
  return (
    <RNText
      selectable
      style={{
        color: toneColor(colors, props.tone as Tone | undefined),
        fontSize: size,
        lineHeight: Math.round(size * 1.45),
        fontWeight: props.bold ? "700" : "400",
        fontStyle: props.italic ? "italic" : "normal",
        fontFamily: props.mono ? MONO : undefined,
        ...(props.mono ? LTR_TEXT : bidi.text(String(props.text ?? ""))),
      }}
    >
      {props.text}
    </RNText>
  );
}

// ── Stopgap: the app has a Markdown renderer the plugin host does not export yet ──

function Spans({ spans }: { spans: Span[] }) {
  const { colors } = useUiEnv();
  return (
    <>
      {spans.map((span, index) => {
        if (span.code) {
          return (
            <RNText key={index} style={{ fontFamily: MONO, backgroundColor: colors.surface2 }}>
              {span.text}
            </RNText>
          );
        }
        if (span.link) {
          const url = span.link;
          return (
            <RNText
              key={index}
              accessibilityRole="link"
              onPress={/^https?:\/\//i.test(url) ? () => void openExternalUrl(url) : undefined}
              style={{ color: colors.accent, textDecorationLine: "underline" }}
            >
              {span.text}
            </RNText>
          );
        }
        if (span.bold || span.italic) {
          return (
            <RNText
              key={index}
              style={{ fontWeight: span.bold ? "700" : undefined, fontStyle: span.italic ? "italic" : undefined }}
            >
              {span.text}
            </RNText>
          );
        }
        return <Fragment key={index}>{span.text}</Fragment>;
      })}
    </>
  );
}

const plain = (spans: Span[]) => spans.map((span) => span.text).join("");

function BlockView({ block }: { block: Block }) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const body = { color: colors.foreground, fontSize: FONT.m, lineHeight: 21 };
  switch (block.kind) {
    case "heading":
      return (
        <RNText accessibilityRole="header" selectable style={{ ...body, ...bidi.text(plain(block.spans)), fontSize: HEADINGS[Math.min(block.level, 3) - 1], fontWeight: "600" }}>
          <Spans spans={block.spans} />
        </RNText>
      );
    case "item":
      return (
        <View style={{ flexDirection: "row", gap: GAP.s, paddingStart: block.depth * 18, ...bidi.row(plain(block.spans)) }}>
          <RNText style={{ ...body, minWidth: 14, color: colors.foregroundMuted, ...LTR_TEXT }}>{block.marker}</RNText>
          <RNText selectable style={{ ...body, ...bidi.text(plain(block.spans)), flex: 1 }}>
            <Spans spans={block.spans} />
          </RNText>
        </View>
      );
    case "quote":
      return (
        <View style={{ borderStartWidth: 3, borderStartColor: colors.border, paddingStart: GAP.m, ...bidi.row(plain(block.spans)) }}>
          <RNText selectable style={{ ...body, ...bidi.text(plain(block.spans)), color: colors.foregroundMuted }}>
            <Spans spans={block.spans} />
          </RNText>
        </View>
      );
    case "table":
      return (
        <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.s, overflow: "hidden", ...bidi.row(block.rows[0]?.map(plain).join(" ") ?? "") }}>
          {block.rows.map((row, rowIndex) => (
            <View
              key={rowIndex}
              style={{
                flexDirection: "row",
                borderTopWidth: rowIndex ? 1 : 0,
                borderTopColor: colors.border,
                backgroundColor: rowIndex ? "transparent" : colors.surface1,
              }}
            >
              {row.map((cell, cellIndex) => (
                <RNText
                  key={cellIndex}
                  selectable
                  style={{ ...body, ...bidi.text(plain(cell)), flex: 1, fontWeight: rowIndex ? "400" : "600", padding: GAP.s }}
                >
                  <Spans spans={cell} />
                </RNText>
              ))}
            </View>
          ))}
        </View>
      );
    case "rule":
      return <View style={{ height: 1, backgroundColor: colors.border }} />;
    case "code":
      return <CodeSurface code={block.text} />;
    default:
      return (
        <RNText selectable style={{ ...body, ...bidi.text(plain(block.spans)) }}>
          <Spans spans={block.spans} />
        </RNText>
      );
  }
}

export function Markdown({ props }: NodeProps) {
  return (
    <View style={{ gap: GAP.s }}>
      {parseMarkdown(String(props.text ?? "")).map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </View>
  );
}

function CodeSurface({ code, header }: { code: string; header?: string }) {
  const { colors } = useUiEnv();
  const toast = useToast();
  return (
    <View style={{ borderRadius: RADIUS.s, backgroundColor: colors.surface0, borderWidth: 1, borderColor: colors.border, direction: "ltr" }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: GAP.m, paddingTop: GAP.s }}>
        <RNText style={{ flex: 1, color: colors.foregroundMuted, fontSize: FONT.s, ...LTR_TEXT }}>{header ?? ""}</RNText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy code"
          hitSlop={8}
          onPress={() => {
            copyText(code).then(
              () => toast.show("Copied"),
              () => toast.error("Could not copy"),
            );
          }}
        >
          <HostIcon name="Copy" size={14} color={colors.foregroundMuted} />
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <RNText selectable style={{ color: colors.foreground, fontFamily: MONO, fontSize: FONT.s + 1, lineHeight: 18, padding: GAP.m, ...LTR_TEXT }}>
          {code}
        </RNText>
      </ScrollView>
    </View>
  );
}

export function CodeBlock({ props }: NodeProps) {
  const header = [props.title, props.language].filter(Boolean).join(" · ");
  return <CodeSurface code={String(props.code ?? "")} header={header} />;
}

export function Diff({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const lines = String(props.patch ?? "").split("\n");
  return (
    <View style={{ borderRadius: RADIUS.s, borderWidth: 1, borderColor: colors.border, overflow: "hidden", direction: "ltr" }}>
      {props.title ? (
        <RNText style={{ color: colors.foregroundMuted, fontSize: FONT.s, padding: GAP.s, backgroundColor: colors.surface1, ...LTR_TEXT }}>
          {props.title}
        </RNText>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ minWidth: "100%" }}>
          {lines.map((line, index) => {
            const added = line.startsWith("+") && !line.startsWith("+++");
            const removed = line.startsWith("-") && !line.startsWith("---");
            const hunk = line.startsWith("@@");
            const tone = added ? colors.statusSuccess : removed ? colors.statusDanger : hunk ? colors.accent : colors.foregroundMuted;
            return (
              <RNText
                key={index}
                style={{
                  fontFamily: MONO,
                  fontSize: FONT.s + 1,
                  lineHeight: 18,
                  paddingHorizontal: GAP.m,
                  ...LTR_TEXT,
                  color: added || removed ? colors.foreground : tone,
                  backgroundColor: added || removed ? wash(tone, "transparent", 0.16) : "transparent",
                }}
              >
                {line || " "}
              </RNText>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

export function Callout({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const content = `${props.title ?? ""} ${props.text ?? ""}`;
  const variant = (props.variant as string | undefined) ?? "info";
  const tone = { info: colors.accent, success: colors.statusSuccess, warning: colors.statusWarning, danger: colors.statusDanger }[
    variant as "info"
  ] ?? colors.accent;
  const icon = props.icon ? String(props.icon) : ({ info: "Info", success: "CircleCheck", warning: "TriangleAlert", danger: "CircleAlert" }[variant as "info"] ?? "Info");
  return (
    <View
      accessibilityRole="alert"
      style={{
        flexDirection: "row",
        gap: GAP.s,
        padding: GAP.m,
        borderRadius: RADIUS.s,
        borderWidth: 1,
        borderColor: wash(tone, colors.border, 0.5),
        backgroundColor: wash(tone, colors.surface1, 0.12),
        ...bidi.row(content),
      }}
    >
      <HostIcon name={icon} size={16} color={tone} />
      <View style={{ flex: 1, gap: 2 }}>
        {props.title ? <RNText style={{ color: colors.foreground, fontSize: FONT.m, fontWeight: "600", ...bidi.text(String(props.title)) }}>{props.title}</RNText> : null}
        <RNText selectable style={{ color: colors.foreground, fontSize: FONT.m, lineHeight: 20, ...bidi.text(String(props.text ?? "")) }}>
          {props.text}
        </RNText>
      </View>
    </View>
  );
}

export function Badge({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const tone = props.tone && props.tone !== "default" ? toneColor(colors, props.tone as Tone) : colors.foregroundMuted;
  return (
    <View
      style={{
        alignSelf: "flex-start",
        paddingHorizontal: GAP.s,
        paddingVertical: 2,
        borderRadius: 999,
        backgroundColor: wash(tone, colors.surface2, 0.16),
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        {props.icon ? <AnimatedIcon name={String(props.icon)} size={FONT.s} color={tone} /> : null}
        <RNText style={{ color: tone, fontSize: FONT.s, fontWeight: "600" }}>{props.label}</RNText>
      </View>
    </View>
  );
}

export function Icon({ props }: NodeProps) {
  const { colors } = useUiEnv();
  return <AnimatedIcon name={String(props.name)} size={props.size ?? 16} color={toneColor(colors, props.tone as Tone | undefined)} animation={props.animation as string | undefined} />;
}

export function Link({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const url = String(props.url ?? "");
  const safe = /^https?:\/\//i.test(url);
  return (
    <RNText
      accessibilityRole="link"
      onPress={safe ? () => void openExternalUrl(url) : undefined}
      style={{ color: safe ? colors.accent : colors.foregroundMuted, fontSize: FONT.m, textDecorationLine: "underline", ...bidi.text(String(props.label ?? "")) }}
    >
      {props.label}
    </RNText>
  );
}

export function FileRef({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const toast = useToast();
  const label = props.line ? `${props.path}:${props.line}` : String(props.path);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Copy ${label}`}
      onPress={() => {
        copyText(label).then(
          () => toast.show("Path copied"),
          () => toast.error("Could not copy"),
        );
      }}
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: GAP.s,
        paddingVertical: 3,
        borderRadius: RADIUS.s,
        backgroundColor: colors.surface2,
        direction: "ltr",
      }}
    >
      <HostIcon name="FileText" size={13} color={colors.foregroundMuted} />
      <RNText style={{ color: colors.foreground, fontFamily: MONO, fontSize: FONT.s + 1, ...LTR_TEXT }}>{label}</RNText>
    </Pressable>
  );
}
