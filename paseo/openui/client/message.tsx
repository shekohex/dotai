import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import type { MessageData } from "../shared/message";
import type { RenderCall } from "../shared/render";
import { createBidi, programIsRtl } from "./bidi";
import { Markdown } from "./components/text";
import { labels } from "./labels";
import { RenderCardBody } from "./render-card";
import { FONT, GAP, RADIUS, UiEnvContext, type UiEnv } from "./tokens";

const NO_CHILDREN = () => null;

/** An assistant message with ```openui blocks: prose as Markdown, each block through the same card as the render tool. */
export function MessageView(props: PluginTimelineItemProps<MessageData>) {
  const { item, theme, layout, agentId } = props;
  const rtl = programIsRtl(item.data.segments.map((segment) => (segment.kind === "text" ? segment.text : "")).join(" "));
  const env: UiEnv = { colors: theme.colors, compact: layout.compact, rtl, agentId, disabled: false };
  return (
    <UiEnvContext.Provider value={env}>
      <View style={{ gap: GAP.m }}>
        {item.data.segments.map((segment, index) =>
          segment.kind === "text" ? (
            <Markdown key={index} props={{ text: segment.text }} renderNode={NO_CHILDREN} />
          ) : (
            <RenderCardBody
              key={index}
              {...props}
              item={{
                ...props.item,
                data: {
                  ui: segment.ui,
                  ...(segment.title ? { title: segment.title } : {}),
                  status: "completed",
                  phase: segment.complete ? "complete" : "streaming",
                } satisfies RenderCall,
              }}
            />
          ),
        )}
      </View>
    </UiEnvContext.Provider>
  );
}

/** The one-line notice that replaces the long `/openui` setup message. */
export function SetupCard({ theme }: PluginTimelineItemProps<Record<string, never>>) {
  const { colors } = theme;
  const rtl = false;
  const words = labels(rtl);
  const bidi = createBidi(rtl);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: GAP.s,
        padding: GAP.m,
        borderRadius: RADIUS.m,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      }}
    >
      <Icon name="Sparkles" size={14} color={colors.accent} />
      <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: FONT.s, ...bidi.text(words.setup) }}>{words.setup}</Text>
    </View>
  );
}
