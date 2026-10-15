/** Draws parsed markdown with React Native text, so reports read as documents, not raw source. */
import { openExternalUrl } from "@getpaseo/plugin/client";
import { Fragment } from "react";
import { Platform, Text, View } from "react-native";

import { type Block, parseMarkdown, type Span } from "../../shared/markdown.js";
import { MentionSpans } from "./mentions.js";
import { type Colors, FONT, LINE } from "./ui.js";

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";
const HEADING_SIZE = [FONT.title + 3, FONT.title, FONT.section, FONT.body];

export function Markdown({
  colors,
  source,
}: {
  colors: Colors;
  source: string;
}) {
  const blocks = parseMarkdown(source);
  return (
    <View style={{ gap: 10 }}>
      {blocks.map((block, index) => (
        <BlockView
          key={index}
          colors={colors}
          block={block}
          first={index === 0}
        />
      ))}
    </View>
  );
}

function BlockView({
  colors,
  block,
  first,
}: {
  colors: Colors;
  block: Block;
  first: boolean;
}) {
  const body = {
    color: colors.foreground,
    fontSize: FONT.body,
    lineHeight: LINE.body,
  };
  switch (block.kind) {
    case "heading": {
      const size = HEADING_SIZE[Math.min(block.level, 4) - 1] ?? FONT.body;
      return (
        <Text
          accessibilityRole="header"
          selectable
          style={{
            color: colors.foreground,
            fontSize: size,
            lineHeight: Math.round(size * 1.35),
            fontWeight: "600",
            marginTop: first ? 0 : 8,
          }}
        >
          <Spans colors={colors} spans={block.spans} />
        </Text>
      );
    }
    case "item":
      return (
        <View
          style={{
            flexDirection: "row",
            gap: 8,
            paddingStart: block.depth * 18,
          }}
        >
          <Text
            style={{
              ...body,
              minWidth: 14,
              color: colors.foregroundMuted,
              fontVariant: ["tabular-nums"],
            }}
          >
            {block.marker}
          </Text>
          <Text selectable style={{ ...body, flex: 1 }}>
            <Spans colors={colors} spans={block.spans} />
          </Text>
        </View>
      );
    case "quote":
      return (
        <View
          style={{
            borderLeftWidth: 3,
            borderLeftColor: colors.border,
            paddingLeft: 12,
          }}
        >
          <Text selectable style={{ ...body, color: colors.foregroundMuted }}>
            <Spans colors={colors} spans={block.spans} />
          </Text>
        </View>
      );
    case "table":
      return (
        <View
          style={{
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
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
                <Text
                  key={cellIndex}
                  selectable
                  style={{
                    flex: 1,
                    color: colors.foreground,
                    fontSize: FONT.secondary,
                    lineHeight: LINE.secondary,
                    fontWeight: rowIndex ? "400" : "600",
                    paddingHorizontal: 8,
                    paddingVertical: 6,
                    borderLeftWidth: cellIndex ? 1 : 0,
                    borderLeftColor: colors.border,
                  }}
                >
                  <Spans colors={colors} spans={cell} />
                </Text>
              ))}
            </View>
          ))}
        </View>
      );
    case "rule":
      return <View style={{ height: 1, backgroundColor: colors.border }} />;
    case "code":
      return (
        <View
          style={{
            padding: 10,
            borderRadius: 6,
            backgroundColor: colors.surface0,
          }}
        >
          <Text
            selectable
            style={{
              color: colors.foreground,
              fontFamily: MONO,
              fontSize: FONT.secondary,
              lineHeight: LINE.secondary,
            }}
          >
            {block.text}
          </Text>
        </View>
      );
    default:
      return (
        <Text selectable style={body}>
          <Spans colors={colors} spans={block.spans} />
        </Text>
      );
  }
}

function Spans({ colors, spans }: { colors: Colors; spans: Span[] }) {
  return (
    <>
      {spans.map((span, index) =>
        span.code ? (
          <Text
            key={index}
            style={{
              fontFamily: MONO,
              fontSize: FONT.secondary,
              color: colors.foreground,
              backgroundColor: colors.surface2,
            }}
          >
            {span.text}
          </Text>
        ) : span.link ? (
          <Text
            key={index}
            accessibilityRole="link"
            onPress={
              /^https?:\/\//i.test(span.link)
                ? () => void openExternalUrl(span.link ?? "")
                : undefined
            }
            style={{ color: colors.accent, textDecorationLine: "underline" }}
          >
            {span.text}
          </Text>
        ) : span.bold || span.italic ? (
          <Text
            key={index}
            style={{
              fontWeight: span.bold ? "700" : undefined,
              fontStyle: span.italic ? "italic" : undefined,
            }}
          >
            <MentionSpans colors={colors} text={span.text} />
          </Text>
        ) : (
          <Fragment key={index}>
            <MentionSpans colors={colors} text={span.text} />
          </Fragment>
        ),
      )}
    </>
  );
}
