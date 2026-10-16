import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import type { Answer } from "../shared/answer";
import { createBidi, programIsRtl } from "./bidi";
import { labels } from "./labels";
import { type Colors, FONT, GAP, RADIUS } from "./tokens";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Form answers arrive as { formName: { field: value } }; show the fields, not the wrapper. */
function rowsOf(values: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(values).flatMap(([key, value]): Array<[string, unknown]> =>
    isPlainObject(value) ? Object.entries(value) : [[key, value]],
  );
}

function ValueView({ value, colors, rtl }: { value: unknown; colors: Colors; rtl: boolean }) {
  const bidi = createBidi(rtl);
  if (typeof value === "boolean") {
    return (
      <Icon name={value ? "CircleCheck" : "CircleX"} size={16} color={value ? colors.statusSuccess : colors.foregroundMuted} />
    );
  }
  const items = Array.isArray(value) ? value.map(String) : [String(value ?? "—")];
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: GAP.xs, flexShrink: 1 }}>
      {items.length === 0 ? <Text style={{ color: colors.foregroundMuted, fontSize: FONT.m }}>—</Text> : null}
      {items.map((item, index) => (
        <View
          key={index}
          style={
            Array.isArray(value)
              ? { paddingHorizontal: GAP.s, paddingVertical: 2, borderRadius: 999, backgroundColor: colors.surface2 }
              : undefined
          }
        >
          <Text selectable style={{ color: colors.foreground, fontSize: FONT.m, ...bidi.text(item) }}>
            {item}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** The values of an answer as label and value rows. */
export function AnswerValues({ values, colors, rtl }: { values: Record<string, unknown>; colors: Colors; rtl: boolean }) {
  const bidi = createBidi(rtl);
  return (
    <View style={{ gap: GAP.xs }}>
      {rowsOf(values).map(([key, value]) => (
        <View key={key} style={{ flexDirection: "row", alignItems: "center", gap: GAP.m, ...bidi.row(key) }}>
          <Text style={{ minWidth: 88, color: colors.foregroundMuted, fontSize: FONT.m, ...bidi.text(key) }}>{key}</Text>
          <ValueView value={value} colors={colors} rtl={rtl} />
        </View>
      ))}
    </View>
  );
}

/** The user's tap or form answer, shown where the raw <openui-answer> message would be. */
export function AnswerCard({ item, theme }: PluginTimelineItemProps<Answer>) {
  const { colors } = theme;
  const { title, message, values } = item.data;
  const rtl = programIsRtl(JSON.stringify(item.data));
  const bidi = createBidi(rtl);
  const text = labels(rtl);
  return (
    <View
      style={{
        gap: GAP.s,
        padding: GAP.m,
        borderRadius: RADIUS.m,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        direction: rtl ? "rtl" : "ltr",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: GAP.s }}>
        <Icon name="MessageSquareReply" size={14} color={colors.accent} />
        <Text numberOfLines={1} style={{ flex: 1, color: colors.foregroundMuted, fontSize: FONT.s, ...bidi.text(title ?? "") }}>
          {title ? `${text.youAnsweredOn} · ${title}` : text.youAnswered}
        </Text>
      </View>
      <Text selectable style={{ color: colors.foreground, fontSize: FONT.m, fontWeight: "600", ...bidi.text(message) }}>
        {message}
      </Text>
      {values && Object.keys(values).length > 0 ? <AnswerValues values={values} colors={colors} rtl={rtl} /> : null}
    </View>
  );
}
