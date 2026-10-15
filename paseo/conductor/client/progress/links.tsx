/** A ticket's links, GitHub-sidebar style: what it waits on, blocks, its parent and sub-tasks. */
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";

import { isSettled } from "../../shared/dashboard.js";
import { linkIndex } from "../../shared/links.js";
import {
  type ProgressState,
  type Ticket,
  ticketFraction,
} from "../../shared/progress.js";
import { Chip, PercentBar } from "./feed.js";
import { type Colors, PressableRow, StatusIcon, text } from "./ui.js";

interface Group {
  label: string;
  icon: string;
  ids: string[];
  /** Shown beside the heading, like "3/5" for sub-tasks. */
  aside?: string;
}

export function LinkedSection({
  colors,
  state,
  ticket,
  now,
  onOpenTicket,
  onOpenQuestion,
}: {
  colors: Colors;
  state: ProgressState;
  ticket: Ticket;
  now: number;
  onOpenTicket(id: string): void;
  onOpenQuestion(id: string): void;
}) {
  const links = linkIndex(state).get(ticket.id);
  if (!links) return null;
  const byId = new Map(state.tickets.map((other) => [other.id, other]));
  const done = links.children.filter((id) =>
    isSettled(byId.get(id) ?? { status: "not_started" }),
  ).length;
  const groups: Group[] = [
    { label: "Waiting on", icon: "Hourglass", ids: links.waitsFor },
    { label: "Blocks", icon: "Ban", ids: links.blocks },
    {
      label: "Parent",
      icon: "CornerLeftUp",
      ids: links.parent ? [links.parent] : [],
    },
    {
      label: "Sub-tasks",
      icon: "ListTree",
      ids: links.children,
      aside: `${done}/${links.children.length}`,
    },
    { label: "Related", icon: "Link", ids: links.related },
    { label: "Mentioned in", icon: "AtSign", ids: links.mentionedIn },
  ].filter((group) => group.ids.length);
  if (!groups.length) return null;
  return (
    <View style={{ gap: 10 }}>
      {groups.map((group) => (
        <View key={group.label} style={{ gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name={group.icon} size={14} color={colors.foregroundMuted} />
            <Text style={[text(colors).small, { fontWeight: "600" }]}>
              {group.label}
            </Text>
            {group.aside ? (
              <Text
                style={[text(colors).small, { fontVariant: ["tabular-nums"] }]}
              >
                {group.aside}
              </Text>
            ) : null}
          </View>
          {group.ids.map((id) => {
            const other = byId.get(id);
            // Mentions may come from a question.
            if (!other)
              return (
                <LinkRow
                  key={id}
                  colors={colors}
                  id={id}
                  title="Question"
                  onPress={() => onOpenQuestion(id)}
                />
              );
            return (
              <LinkRow
                key={id}
                colors={colors}
                id={id}
                title={other.title}
                ticket={other}
                fraction={
                  group.label === "Sub-tasks" && !isSettled(other)
                    ? ticketFraction(other, now, state.tickets)
                    : undefined
                }
                onPress={() => onOpenTicket(id)}
              />
            );
          })}
        </View>
      ))}
    </View>
  );
}

function LinkRow({
  colors,
  id,
  title,
  ticket,
  fraction,
  onPress,
}: {
  colors: Colors;
  id: string;
  title: string;
  ticket?: Ticket;
  fraction?: number;
  onPress(): void;
}) {
  return (
    <PressableRow
      colors={colors}
      onSurface1
      accessibilityRole="button"
      accessibilityLabel={`Open ${id}: ${title}`}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingVertical: 4,
        paddingHorizontal: 6,
        marginHorizontal: -6,
        borderRadius: 6,
      }}
    >
      {ticket ? (
        <StatusIcon
          colors={colors}
          status={ticket.status}
          live
          waiting={false}
          size={14}
        />
      ) : (
        <Icon
          name="MessageCircleQuestion"
          size={14}
          color={colors.foregroundMuted}
        />
      )}
      <Chip
        colors={colors}
        label={id}
        colorKey={ticket ? id : null}
        maxWidth={90}
      />
      <Text
        numberOfLines={1}
        style={[text(colors).body, { flex: 1, minWidth: 0 }]}
      >
        {title}
      </Text>
      {fraction !== undefined ? (
        <View style={{ width: 80 }}>
          <PercentBar
            colors={colors}
            fraction={fraction}
            reported={ticket?.percent !== undefined}
            compact
          />
        </View>
      ) : null}
    </PressableRow>
  );
}
