/**
 * Conductor's own traffic in the chat: steer notes shrink to a chip that expands on tap, and
 * progress tool calls render as cards. The agent still gets the full text; only the view changes.
 */
import type {
  PluginClientContext,
  PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";

import {
  BRIEF_KIND,
  briefBody,
  CALL_KIND,
  NOTE_KIND,
  noteChip,
  parseShow,
  type ProgressCall,
  progressCall,
  systemNoteBody,
} from "../shared/timeline.js";
import { formatMinutes } from "../shared/format.js";
import type { ActivityKind } from "../shared/progress.js";
import {
  AgentChip,
  Chip,
  KIND_META,
  KindIcon,
  PercentBar,
} from "./progress/feed.js";
import { Markdown } from "./progress/markdown.js";
import {
  type Colors,
  FONT,
  LINE,
  Spinner,
  STATUS_LABEL,
  StatusBadge,
  text,
} from "./progress/ui.js";
import type { TicketStatus } from "../shared/progress.js";
import { MentionSpans } from "./progress/mentions.js";

const noteSchema = z.object({ body: z.string() });
const callSchema = z.custom<ProgressCall>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as ProgressCall).input?.op === "string",
);

export function contributeTimeline(client: PluginClientContext): () => void {
  const cleanups = [
    client.addTimelineTransformer({
      id: "conductor-notes",
      query: { itemType: "user_message" },
      transform: ({ item }) => {
        const brief = briefBody(item.text);
        if (brief !== null)
          return {
            items: [
              {
                type: "plugin",
                kind: BRIEF_KIND,
                version: 1,
                data: { body: brief },
              },
            ],
          };
        const body = systemNoteBody(item.text);
        return body === null
          ? undefined
          : {
              items: [
                { type: "plugin", kind: NOTE_KIND, version: 1, data: { body } },
              ],
            };
      },
    }),
    client.addTimelineTransformer({
      id: "conductor-progress-calls",
      query: { itemType: "tool_call" },
      transform: ({ item }) => {
        const call = progressCall(item);
        return call
          ? {
              items: [
                {
                  type: "plugin",
                  kind: CALL_KIND,
                  version: 1,
                  data: JSON.parse(JSON.stringify(call)),
                },
              ],
            }
          : undefined;
      },
    }),
    client.addTimelineRenderer({
      kind: NOTE_KIND,
      version: 1,
      schema: noteSchema,
      Component: NoteChipView,
    }),
    client.addTimelineRenderer({
      kind: BRIEF_KIND,
      version: 1,
      schema: noteSchema,
      Component: BriefCard,
    }),
    client.addTimelineRenderer({
      kind: CALL_KIND,
      version: 1,
      schema: callSchema,
      Component: CallCard,
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

function NoteChipView({
  theme,
  item,
}: PluginTimelineItemProps<z.output<typeof noteSchema>>) {
  const colors = theme.colors;
  const [open, setOpen] = useState(false);
  const chip = noteChip(item.data.body);
  return (
    <View style={{ alignItems: "flex-start", gap: 6, paddingVertical: 2 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityHint="Shows the note the agent received"
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          maxWidth: "100%",
          paddingHorizontal: 10,
          paddingVertical: 4,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: pressed ? colors.surface2 : colors.surface1,
        })}
      >
        <Icon name={chip.icon} size={16} color={colors.foregroundMuted} />
        <Text
          numberOfLines={1}
          style={[
            text(colors).body,
            { color: colors.foregroundMuted, flexShrink: 1 },
          ]}
        >
          {chip.label}
        </Text>
        <Icon
          name={open ? "ChevronUp" : "ChevronDown"}
          size={14}
          color={colors.foregroundMuted}
        />
      </Pressable>
      {open ? (
        <Text
          selectable
          style={[
            text(colors).muted,
            {
              paddingLeft: 12,
              borderLeftWidth: 2,
              borderLeftColor: colors.border,
            },
          ]}
        >
          {item.data.body}
        </Text>
      ) : null}
    </View>
  );
}

const STATUSES = new Set<string>(Object.keys(STATUS_LABEL));

/** Header icon and line per op; the body adds what is worth reading. */
function headline(call: ProgressCall): { icon: string; line: string } {
  const input = call.input;
  switch (input.op) {
    case "start":
      return { icon: "Flag", line: `Started run: ${input.title ?? ""}` };
    case "ticket":
      return {
        icon: "Ticket",
        line: [
          input.id ?? (call.output?.split(" ")[0] || "New ticket"),
          input.title && !input.id ? input.title : null,
          input.stage ? `stage ${input.stage}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    case "ask":
      return {
        icon: "MessageCircleQuestion",
        line: `Asked${call.output ? ` ${call.output.split(" ")[1]?.replace(/\.$/, "") ?? ""}` : ""}: ${input.title ?? ""}`,
      };
    case "answer":
      return {
        icon: "MessageSquareReply",
        line: `Answered ${input.id ?? ""}${input.choice ? `: ${input.choice.replaceAll(",", ", ")}` : ""}`,
      };
    case "deliver":
      return { icon: "PackageCheck", line: `Delivered ${input.title ?? ""}` };
    case "stuck":
      return { icon: "OctagonAlert", line: "Flagged stuck" };
    case "unstuck":
      return { icon: "CircleCheck", line: `Cleared ${input.id ?? ""}` };
    case "ticker":
      return { icon: "Activity", line: input.text ?? "" };
    case "finish":
      return { icon: "PartyPopper", line: `Finished: ${input.title ?? ""}` };
    case "withdraw":
      return { icon: "Undo2", line: `Withdrew ${input.id ?? ""}` };
    case "show":
      return { icon: "ListChecks", line: "Checked progress" };
    case "help":
      return { icon: "BookOpen", line: "Read the progress guide" };
    default:
      return { icon: "ListChecks", line: input.op };
  }
}

function CallCard({
  theme,
  item,
}: PluginTimelineItemProps<z.output<typeof callSchema>>) {
  const colors = theme.colors;
  const call = item.data;
  const { icon, line } = headline(call);
  const failed = call.status === "failed";
  const input = call.input;
  const status =
    input.op === "ticket" && input.status && STATUSES.has(input.status)
      ? (input.status as TicketStatus)
      : null;
  const show = input.op === "show" ? parseShow(call.output) : null;
  return (
    <View
      style={{
        gap: 8,
        padding: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: failed ? colors.statusDanger : colors.border,
        backgroundColor: colors.surface1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {call.status === "running" ? (
          <Spinner color={colors.accent} size={16} />
        ) : (
          <Icon
            name={failed ? "CircleAlert" : icon}
            size={16}
            color={failed ? colors.statusDanger : colors.accent}
          />
        )}
        <Text
          numberOfLines={2}
          style={[text(colors).body, { flex: 1, fontWeight: "600" }]}
        >
          <MentionSpans colors={colors} text={line} />
        </Text>
        {status ? <StatusBadge colors={colors} status={status} /> : null}
      </View>
      <CallBody colors={colors} call={call} />
      {show ? <ShowSummaryView colors={colors} show={show} /> : null}
      {failed && call.error ? (
        <Text
          selectable
          style={[text(colors).muted, { color: colors.statusDanger }]}
        >
          {call.error}
        </Text>
      ) : null}
    </View>
  );
}

function CallBody({ colors, call }: { colors: Colors; call: ProgressCall }) {
  const input = call.input;
  const muted = [text(colors).body, { color: colors.foregroundMuted }];
  switch (input.op) {
    case "start":
      return input.text ? <Text style={muted}>{input.text}</Text> : null;
    case "ticket":
    case "ticker":
      return <UpdateBody colors={colors} call={call} />;
    case "stuck":
      return input.text ? (
        <Text style={text(colors).body}>{input.text}</Text>
      ) : null;
    case "answer":
      return input.words ? <Text style={muted}>“{input.words}”</Text> : null;
    case "deliver":
      return input.target ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon
            name={/^https?:\/\//i.test(input.target) ? "Globe" : "FileText"}
            size={16}
            color={colors.foregroundMuted}
          />
          <Text
            selectable
            numberOfLines={1}
            ellipsizeMode="middle"
            style={[muted, { flex: 1 }]}
          >
            {input.target}
          </Text>
        </View>
      ) : null;
    case "ask":
      return (
        <View style={{ gap: 4 }}>
          {input.text ? (
            <Text style={text(colors).body}>{input.text}</Text>
          ) : null}
          {(input.options ?? []).map((option) => {
            const recommended = (input.recommend ?? "")
              .split(/[\s,]+/)
              .includes(option.key);
            return (
              <Text key={option.key} style={muted}>
                <Text style={{ color: colors.foreground, fontWeight: "600" }}>
                  {option.key}
                </Text>{" "}
                {option.label}
                {recommended ? (
                  <Text style={{ color: colors.accent }}> · recommended</Text>
                ) : null}
              </Text>
            );
          })}
        </View>
      );
    default:
      return null;
  }
}

function ShowSummaryView({
  colors,
  show,
}: {
  colors: Colors;
  show: NonNullable<ReturnType<typeof parseShow>>;
}) {
  const facts = [
    show.counts.working ? `${show.counts.working} working` : null,
    show.counts.blocked ? `${show.counts.blocked} blocked` : null,
    show.counts.questions ? `${show.counts.questions} waiting for you` : null,
    show.counts.stuck ? `${show.counts.stuck} stuck` : null,
  ].filter(Boolean);
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text numberOfLines={1} style={[text(colors).body, { flex: 1 }]}>
          {show.title}
        </Text>
        <Text
          style={{
            color: colors.foreground,
            fontSize: FONT.section,
            lineHeight: LINE.section,
            fontWeight: "600",
            fontVariant: ["tabular-nums"],
          }}
        >
          {show.percent}%
        </Text>
      </View>
      <PercentBar colors={colors} fraction={show.percent / 100} reported />
      <Text style={[text(colors).body, { color: colors.foregroundMuted }]}>
        {show.done} of {show.total} done
        {facts.length ? ` · ${facts.join(" · ")}` : ""}
      </Text>
      {show.finished ? (
        <Text style={[text(colors).muted, { color: colors.statusSuccess }]}>
          Finished: {show.finished}
        </Text>
      ) : show.now ? (
        <Text numberOfLines={2} style={text(colors).muted}>
          Now: {show.now}
        </Text>
      ) : null}
    </View>
  );
}

/** A ticket or ticker update: the line with its kind, details, labels, ETA, and percent. */
function UpdateBody({ colors, call }: { colors: Colors; call: ProgressCall }) {
  const input = call.input;
  const [open, setOpen] = useState(false);
  const line = input.op === "ticker" ? null : input.note;
  const kind =
    input.kind && input.kind in KIND_META
      ? (input.kind as ActivityKind)
      : undefined;
  const chips =
    Boolean(input.labels?.length) ||
    input.estimate !== undefined ||
    Boolean(input.agent);
  if (!line && !input.body && !chips && input.percent === undefined && !kind)
    return null;
  return (
    <View style={{ gap: 8 }}>
      {line || kind ? (
        <View
          style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}
        >
          {kind ? (
            <View style={{ height: LINE.body, justifyContent: "center" }}>
              <KindIcon colors={colors} kind={kind} />
            </View>
          ) : null}
          {line ? (
            <Text style={[text(colors).body, { flex: 1 }]}>
              <MentionSpans colors={colors} text={line} />
            </Text>
          ) : null}
        </View>
      ) : null}
      {input.body ? (
        open ? (
          <Markdown colors={colors} source={input.body} />
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => setOpen(true)}
            style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
          >
            <Icon name="AlignLeft" size={16} color={colors.foregroundMuted} />
            <Text
              numberOfLines={2}
              style={[
                text(colors).body,
                { color: colors.foregroundMuted, flex: 1 },
              ]}
            >
              {input.body}
            </Text>
          </Pressable>
        )
      ) : null}
      {input.percent !== undefined ? (
        <PercentBar colors={colors} fraction={input.percent / 100} reported />
      ) : null}
      {chips ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {input.labels?.map((label) => (
            <Chip key={label} colors={colors} icon="Tag" label={label} />
          ))}
          {input.estimate !== undefined ? (
            <Chip
              colors={colors}
              colorKey={null}
              icon="Timer"
              label={`ETA ${formatMinutes(input.estimate)}`}
            />
          ) : null}
          {input.agent ? (
            <AgentChip colors={colors} agentId={input.agent} conductorId="" />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** A message from the conductor: its first line, the rest one tap away. */
function BriefCard({
  theme,
  item,
}: PluginTimelineItemProps<z.output<typeof noteSchema>>) {
  const colors = theme.colors;
  const [open, setOpen] = useState(false);
  const lines = item.data.body.split("\n");
  const title = (lines.find((line) => line.trim()) ?? "")
    .replace(/^#+\s*/, "")
    .trim();
  return (
    <View
      style={{
        gap: 8,
        padding: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
      >
        <Icon name="Workflow" size={16} color={colors.accent} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[text(colors).muted, { fontWeight: "600" }]}>
            From the conductor
          </Text>
          <Text numberOfLines={open ? undefined : 2} style={text(colors).body}>
            {title}
          </Text>
        </View>
        <Icon
          name={open ? "ChevronUp" : "ChevronDown"}
          size={16}
          color={colors.foregroundMuted}
        />
      </Pressable>
      {open ? <Markdown colors={colors} source={item.data.body} /> : null}
    </View>
  );
}
