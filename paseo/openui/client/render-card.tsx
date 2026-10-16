import { openExternalUrl, type PluginTimelineItemProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { BuiltinActionType, type ActionEvent } from "../shared/lang-core/index.mjs";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { hashText } from "../shared/hash";
import type { RenderCall } from "../shared/render";
import { formatAnswer, parseAnswer } from "../shared/answer";
import { plainState, respondRpc } from "../shared/respond";
import { AnswerValues } from "./answer";
import { createBidi, programIsRtl } from "./bidi";
import { labels } from "./labels";
import { Spinner } from "./components/viz";
import { useExpandedUi } from "./expand";
import { OpenUiView } from "./runtime";
import { FONT, GAP, RADIUS, UiEnvContext, type UiEnv } from "./tokens";

/** One rendered OpenUI program as a card: from a render tool call, or from an ```openui block in a message. */
export function RenderCardBody({ item, theme, layout, agentId }: PluginTimelineItemProps<RenderCall>) {
  const respond = useRpc(respondRpc);
  const toast = useToast();
  const { ui, title, wait, status, phase, output } = item.data;
  const { colors } = theme;
  const [note, setNote] = useState<string | null>(null);
  const [problems, setProblems] = useState(0);
  const key = useMemo(() => hashText(ui), [ui]);
  const expanded = useExpandedUi(ui, phase === "complete", agentId);
  const answer = useMemo(() => (output ? parseAnswer(output) : null), [output]);
  const answered = wait === true && answer !== null;
  const rtl = useMemo(() => programIsRtl(`${title ?? ""} ${ui}`), [title, ui]);
  const bidi = createBidi(rtl);
  const words = labels(rtl);
  const waiting = wait === true && status === "running";
  const env = useMemo<UiEnv>(
    () => ({ colors, compact: layout.compact, rtl, agentId, disabled: answered }),
    [colors, layout.compact, rtl, agentId, answered],
  );

  function onAction(event: ActionEvent) {
    if (event.type === BuiltinActionType.OpenUrl) {
      const url = String(event.params?.url ?? "");
      if (/^https?:\/\//i.test(url)) void openExternalUrl(url);
      return;
    }
    if (event.type !== BuiltinActionType.ContinueConversation) return;
    const values = plainState(event.formState ?? {});
    const text = formatAnswer({
      ...(title ? { title } : {}),
      message: event.humanFriendlyMessage,
      ...(Object.keys(values).length > 0 ? { values } : {}),
      ...(event.params?.context === undefined ? {} : { context: event.params.context }),
    });
    respond({ agentId, key, text }).then(
      (result) => setNote(result.delivered === "tool_result" ? words.answerSent : words.sent),
      (error: unknown) => toast.error(error instanceof Error ? error.message : "Could not send"),
    );
  }

  return (
    <UiEnvContext.Provider value={env}>
      <View
        style={{
          gap: GAP.m,
          padding: layout.compact ? GAP.m : GAP.l,
          borderRadius: RADIUS.m,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface1,
          direction: rtl ? "rtl" : "ltr",
        }}
      >
        {title || waiting ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: GAP.s }}>
            {title ? (
              <Text accessibilityRole="header" style={{ flex: 1, color: colors.foreground, fontSize: FONT.l, fontWeight: "600", ...bidi.text(title) }}>
                {title}
              </Text>
            ) : (
              <View style={{ flex: 1 }} />
            )}
            {waiting ? (
              <Text style={{ color: colors.accent, fontSize: FONT.s, fontWeight: "600", ...bidi.text(words.waiting) }}>{words.waiting}</Text>
            ) : null}
          </View>
        ) : null}
        {expanded.ui === null ? (
          expanded.errors.length > 0 ? (
            <Text style={{ color: colors.statusWarning, fontSize: FONT.s, ...bidi.text(expanded.errors.join(" "))  }}>
              {expanded.errors.join("\n")}
            </Text>
          ) : (
            <Spinner props={{}} renderNode={() => null} />
          )
        ) : (
          <OpenUiView
            source={expanded.ui}
            onAction={onAction}
            onProblems={(list) => setProblems(list.length)}
          />
        )}
        {problems > 0 && phase === "complete" ? (
          <View style={{ flexDirection: "row", gap: GAP.s, alignItems: "center" }}>
            <Icon name="TriangleAlert" size={14} color={colors.statusWarning} />
            <Text style={{ flex: 1, color: colors.statusWarning, fontSize: FONT.s, ...bidi.text(words.brokenPart) }}>
              {words.brokenPart}
            </Text>
          </View>
        ) : null}
        {answered || note ? (
          <View style={{ flexDirection: "row", gap: GAP.s, alignItems: "center" }}>
            <Icon name="Check" size={14} color={colors.statusSuccess} />
            <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: FONT.s, ...bidi.text(answered ? answer.message : (note ?? "")) }}>
              {answered ? `${words.answered} · ${answer.message}` : note}
            </Text>
          </View>
        ) : null}
        {answered && answer.values && Object.keys(answer.values).length > 0 ? (
          <AnswerValues values={answer.values} colors={colors} rtl={rtl} />
        ) : null}
      </View>
    </UiEnvContext.Provider>
  );
}
