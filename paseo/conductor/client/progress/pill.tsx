/**
 * The Progress pill above the composer of a conductor and every agent working under it. It counts
 * what needs the user and opens a popover to answer without leaving the chat. Adapted from the
 * Progress plugin by Steve Castaneda (MIT,
 * https://github.com/stevecastaneda/paseo-plugins/tree/main/progress).
 */
import type {
  PluginButton,
  PluginButtonContentProps,
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";

import { type Attachment, canPreview } from "../../shared/attachments.js";
import {
  buildDashboard,
  type Dashboard,
  pillLabel,
} from "../../shared/dashboard.js";
import { findConductorId } from "../../shared/labels.js";
import { getProgressRpc } from "../../shared/progress.js";
import {
  PreviewDialog,
  QuestionDetail,
  QuestionState,
  useAttachmentOpener,
} from "./dialogs.js";
import { type Colors, IconSwap, PressScale, raised, text } from "./ui.js";
import { ProgressView, useProgress } from "./view.js";
import { MentionSpans } from "./mentions.js";

const POLL_MS = 5_000;
type PillIconKind = "stuck" | "questions" | "open";

/** Adds a Progress pill to every conductor and every agent working under one. */
export function contributeProgressPills(
  client: PluginClientContext,
): () => void {
  const pills = new Map<
    string,
    { conductorId: string; label: string; pill: PluginButtonRegistration }
  >();
  const agents = new Map<
    string,
    { workspaceId?: string | null; labels: Record<string, string> }
  >();
  const icons = new Map<string, PillIconKind>();
  const labels = new Map<string, string>();
  const listeners = new Set<() => void>();
  const lifetime = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function PillIcon(props: PluginButtonIconProps & { conductorId: string }) {
    const kind = useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      () => icons.get(props.conductorId) ?? "open",
    );
    return (
      <IconSwap swapKey={kind} size={props.size}>
        {kind === "stuck" ? (
          <Icon
            name="OctagonAlert"
            size={props.size}
            color={props.theme.colors.statusDanger}
          />
        ) : kind === "questions" ? (
          <Icon
            name="MessageCircleQuestion"
            size={props.size}
            color={props.theme.colors.accent}
          />
        ) : (
          <Icon name="ListChecks" size={props.size} color={props.color} />
        )}
      </IconSwap>
    );
  }

  const buttonFor = (
    conductorId: string,
    workspaceId: string,
  ): PluginButton => ({
    title: "Conductor progress",
    label: labels.get(conductorId) ?? "Progress",
    icon: (props: PluginButtonIconProps) => (
      <PillIcon {...props} conductorId={conductorId} />
    ),
    behavior: {
      kind: "popover",
      Content: (props: PluginButtonContentProps) => (
        <ProgressPopover
          {...props}
          conductorId={conductorId}
          openPanel={() =>
            client.openPanel("progress", {
              workspaceId,
              location: props.layout.compact ? "workspace" : "explorer",
            })
          }
        />
      ),
    },
  });

  const register = (agentId: string) => {
    const agent = agents.get(agentId);
    if (lifetime.signal.aborted || !agent?.workspaceId || pills.has(agentId))
      return;
    const conductorId = findConductorId(
      agentId,
      (id) => agents.get(id)?.labels,
    );
    if (!conductorId) return;
    pills.set(agentId, {
      conductorId,
      label: labels.get(conductorId) ?? "Progress",
      pill: client.addComposerPill({
        id: "progress",
        workspaceId: agent.workspaceId,
        agentId,
        button: buttonFor(conductorId, agent.workspaceId),
      }),
    });
  };
  // A worker can arrive before its parent, so every change re-checks agents without a pill.
  const registerAll = () => {
    for (const agentId of agents.keys()) register(agentId);
  };
  const remember = (agent: {
    id: string;
    workspaceId?: string | null;
    labels?: Record<string, string>;
  }) =>
    agents.set(agent.id, {
      workspaceId: agent.workspaceId,
      labels: agent.labels ?? {},
    });
  const removeAll = () => {
    for (const { pill } of pills.values()) pill.remove();
    pills.clear();
  };

  // Counts per conductor; each pill shows its conductor's.
  const poll = async () => {
    const conductorIds = new Set(
      [...pills.values()].map((entry) => entry.conductorId),
    );
    await Promise.all(
      [...conductorIds].map(async (conductorId) => {
        try {
          const { state } = await client.rpc(getProgressRpc, { conductorId });
          const dashboard = state ? buildDashboard(state, Date.now()) : null;
          const questions = dashboard?.questions.open.length ?? 0;
          const stuck = dashboard?.stuck.length ?? 0;
          labels.set(conductorId, pillLabel(questions, stuck));
          icons.set(
            conductorId,
            stuck ? "stuck" : questions ? "questions" : "open",
          );
        } catch {
          // Try again on the next poll.
        }
      }),
    );
    if (lifetime.signal.aborted) return;
    for (const listener of listeners) listener();
    for (const entry of pills.values()) {
      const label = labels.get(entry.conductorId) ?? "Progress";
      if (entry.label !== label) {
        entry.pill.update({ label });
        entry.label = label;
      }
    }
  };
  const loop = () => {
    void poll().finally(() => {
      if (!lifetime.signal.aborted) timer = setTimeout(loop, POLL_MS);
    });
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          agents.clear();
          for (const { agent } of entries) remember(agent);
          registerAll();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            remember(update.agent);
            return registerAll();
          }
          agents.delete(update.agentId);
          pills.get(update.agentId)?.pill.remove();
          pills.delete(update.agentId);
        },
      });
      loop();
      return undefined;
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted)
        console.error("Progress pills failed", error);
    });
  return () => {
    lifetime.abort();
    if (timer) clearTimeout(timer);
    removeAll();
    listeners.clear();
  };
}

// Paseo caps the desktop popover; the list scrolls below this so Open Progress stays in view.
const LIST_MAX_HEIGHT = 420;

/** What needs the user (questions to answer, stuck work), or the whole dashboard when nothing does. */
function ProgressPopover({
  theme,
  layout,
  close,
  conductorId,
  openPanel,
}: PluginButtonContentProps & { conductorId: string; openPanel(): void }) {
  const colors = theme.colors;
  const onSurface1 = !layout.compact;
  const progress = useProgress(conductorId);
  const state = progress.data;
  const dashboard = state ? buildDashboard(state, Date.now()) : null;
  const attention =
    dashboard &&
    (dashboard.questions.open.length > 0 || dashboard.stuck.length > 0);
  const body = attention ? (
    <AttentionList
      colors={colors}
      conductorId={conductorId}
      dashboard={dashboard}
      onSurface1={onSurface1}
    />
  ) : (
    <ProgressView conductorId={conductorId} theme={theme} />
  );
  return (
    // A fixed width only suits the desktop popover; the phone sheet must stretch edge to edge.
    <View
      style={
        layout.compact
          ? { alignSelf: "stretch", width: "100%", gap: 10 }
          : { width: 420, maxWidth: "100%", gap: 10 }
      }
    >
      {layout.compact ? (
        <View style={{ gap: 14 }}>{body}</View>
      ) : (
        <ScrollView
          style={{ maxHeight: LIST_MAX_HEIGHT }}
          contentContainerStyle={{ gap: 14 }}
        >
          {body}
        </ScrollView>
      )}
      <View
        style={{
          paddingTop: layout.compact ? 12 : 10,
          borderTopWidth: 1,
          borderTopColor: colors.border,
        }}
      >
        <PressScale
          accessibilityRole="button"
          onPress={() => {
            close();
            openPanel();
          }}
          style={({ pressed }) => ({
            flexDirection: "row",
            justifyContent: "center",
            alignItems: "center",
            gap: 8,
            paddingVertical: 8,
            minHeight: layout.compact ? 44 : undefined,
            borderRadius: 8,
            ...raised(colors),
            backgroundColor: onSurface1
              ? pressed
                ? colors.surface1
                : colors.surface2
              : pressed
                ? colors.surface2
                : colors.surface1,
          })}
        >
          <Icon
            name={layout.compact ? "ListChecks" : "PanelRight"}
            size={16}
            color={colors.foreground}
          />
          <Text style={[text(colors).body, { fontWeight: "600" }]}>
            Open Progress
          </Text>
        </PressScale>
      </View>
    </View>
  );
}

function AttentionList({
  colors,
  conductorId,
  dashboard,
  onSurface1,
}: {
  colors: Colors;
  conductorId: string;
  dashboard: Dashboard;
  onSurface1: boolean;
}) {
  const now = Date.now();
  const [previewing, setPreviewing] = useState<{
    attachment: Attachment;
    group: Attachment[];
  } | null>(null);
  const [group, setGroup] = useState<Attachment[]>([]);
  const opener = useAttachmentOpener({
    conductorId,
    onPreview: (attachment) =>
      setPreviewing({ attachment, group: group.filter(canPreview) }),
  });
  return (
    <>
      {dashboard.questions.open.map((question) => (
        <View key={question.id} style={{ gap: 8 }}>
          <View
            style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}
          >
            <Text style={[text(colors).body, { fontWeight: "600" }]}>
              {question.id}
            </Text>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text style={[text(colors).body, { fontWeight: "500" }]}>
                {question.title}
              </Text>
              <Text style={text(colors).muted}>
                <MentionSpans colors={colors} text={question.text} />
              </Text>
              <QuestionState colors={colors} question={question} />
            </View>
          </View>
          <QuestionDetail
            colors={colors}
            conductorId={conductorId}
            question={question}
            now={now}
            onSurface1={onSurface1}
            onOpenAttachment={(attachment, from) => {
              setGroup(from);
              void opener.open(attachment);
            }}
          />
        </View>
      ))}
      {dashboard.stuck.length ? (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name="OctagonAlert" size={16} color={colors.statusDanger} />
            <Text
              style={[
                text(colors).body,
                { color: colors.statusDanger, fontWeight: "600" },
              ]}
            >
              Stuck
            </Text>
          </View>
          {dashboard.stuck.map((item) => (
            <Text key={item.key} style={text(colors).body}>
              <MentionSpans colors={colors} text={item.title} />
              <Text style={{ color: colors.foregroundMuted }}>
                {item.kind === "overdue"
                  ? " (no update past its estimate)"
                  : item.kind === "blocked"
                    ? ` (blocked${item.note ? `: ${item.note}` : ""})`
                    : item.ticketId
                      ? ` (${item.reason})`
                      : ""}
              </Text>
            </Text>
          ))}
        </View>
      ) : null}
      <PreviewDialog
        colors={colors}
        conductorId={conductorId}
        attachment={previewing?.attachment ?? null}
        onClose={() => setPreviewing(null)}
        onOpenOnHost={(attachment) => void opener.openOutside(attachment)}
        gallery={
          previewing
            ? {
                items: previewing.group,
                onSelect: (attachment) =>
                  setPreviewing({ ...previewing, attachment }),
              }
            : undefined
        }
      />
    </>
  );
}
