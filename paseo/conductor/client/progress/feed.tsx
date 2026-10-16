/**
 * The run's story at a glance: colored chips for tickets, labels, and agents, activity rows shaped
 * like commit messages, their details, and a ticket's timeline as a rail of steps and events.
 */
import {
  Icon,
  ScrollView,
  TextInput,
} from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type TextInput as NativeTextInput,
  Pressable,
  Text,
  View,
} from "react-native";

import { useAgentSnapshot } from "../data.js";
import { chipTone, isDarkSurface } from "../../shared/colors.js";
import {
  type TimelineEvent,
  type TimelineStep,
} from "../../shared/dashboard.js";
import {
  formatAgo,
  formatClock,
  formatMinutes,
  formatTimeOfDay,
  unbroken,
} from "../../shared/format.js";
import type { ActivityItem, ActivityKind } from "../../shared/progress.js";
import {
  applySuggestion,
  type Facet,
  hasToken,
  parseQuery,
  removeToken,
  type SearchKey,
  type Suggestion,
  suggest,
  type TicketSort,
  toggleToken,
} from "../../shared/search.js";
import { Markdown } from "./markdown.js";
import {
  type Colors,
  FONT,
  LINE,
  PressableRow,
  Spinner,
  StalledPulse,
  text,
} from "./ui.js";
import { MentionSpans } from "./mentions.js";

export const KIND_META: Record<ActivityKind, { icon: string; label: string }> =
  {
    feat: { icon: "Sparkles", label: "Feature" },
    fix: { icon: "Wrench", label: "Fix" },
    refactor: { icon: "Shuffle", label: "Refactor" },
    test: { icon: "FlaskConical", label: "Test" },
    build: { icon: "Hammer", label: "Build" },
    docs: { icon: "BookOpen", label: "Docs" },
    research: { icon: "Search", label: "Research" },
    review: { icon: "Eye", label: "Review" },
    plan: { icon: "Map", label: "Plan" },
    deploy: { icon: "Rocket", label: "Deploy" },
    chore: { icon: "Brush", label: "Chore" },
  };

/** Kinds get the theme's own colors, so the feed reads calm with a few strong marks. */
function kindColor(colors: Colors, kind: ActivityKind | undefined): string {
  switch (kind) {
    case "feat":
    case "deploy":
      return colors.accent;
    case "fix":
      return colors.statusDanger;
    case "test":
    case "review":
      return colors.statusSuccess;
    case "research":
    case "plan":
      return colors.statusWarning;
    default:
      return colors.foregroundMuted;
  }
}

export function KindIcon({
  colors,
  kind,
  size = 16,
}: {
  colors: Colors;
  kind: ActivityKind | undefined;
  size?: number;
}) {
  return (
    <Icon
      name={kind ? KIND_META[kind].icon : "MessageSquareText"}
      size={size}
      color={kindColor(colors, kind)}
    />
  );
}

/** A GitHub-label-like chip; the same name always gets the same color. */
export function Chip({
  colors,
  label,
  colorKey,
  icon,
  selected,
  onPress,
  accessibilityLabel,
  maxWidth = 200,
}: {
  colors: Colors;
  label: string;
  /** Hashed to the color; defaults to the label. Omit both for a neutral chip. */
  colorKey?: string | null;
  icon?: string;
  selected?: boolean;
  onPress?(): void;
  accessibilityLabel?: string;
  maxWidth?: number;
}) {
  const tone =
    colorKey === null
      ? {
          fg: colors.foregroundMuted,
          bg: colors.surface2,
          border: colors.border,
        }
      : chipTone(colorKey ?? label, isDarkSurface(colors.surface0));
  const body = (
    <>
      {icon ? <Icon name={icon} size={12} color={tone.fg} /> : null}
      <Text
        numberOfLines={1}
        style={{
          color: tone.fg,
          fontSize: FONT.small,
          lineHeight: LINE.small,
          fontWeight: "600",
          flexShrink: 1,
        }}
      >
        {label}
      </Text>
    </>
  );
  const style = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 4,
    maxWidth,
    flexShrink: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: selected ? tone.fg : tone.border,
    backgroundColor: selected ? `${tone.border}` : tone.bg,
  };
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityState={selected === undefined ? undefined : { selected }}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [style, { opacity: pressed ? 0.7 : 1 }]}
    >
      {body}
    </Pressable>
  ) : (
    <View style={style}>{body}</View>
  );
}

/** "You", "Conductor", or the agent's title from Paseo. */
export function useAgentLabel(
  agentId: string | undefined,
  conductorId: string,
): string | null {
  const title = useAgentSnapshot(agentId ?? "")?.title;
  if (!agentId) return null;
  if (agentId === "user") return "You";
  if (agentId === conductorId) return "Conductor";
  return title?.trim() || `Agent ${agentId.slice(0, 6)}`;
}

export function AgentChip({
  colors,
  agentId,
  conductorId,
  suffix,
  selected,
  onPress,
  compact = false,
}: {
  colors: Colors;
  agentId: string;
  conductorId: string;
  suffix?: string;
  selected?: boolean;
  onPress?(): void;
  /** Narrower, for one-line chip rows. */
  compact?: boolean;
}) {
  const label = useAgentLabel(agentId, conductorId) ?? agentId;
  return (
    <Chip
      colors={colors}
      icon={agentId === "user" ? "User" : "Bot"}
      label={suffix ? `${label} · ${suffix}` : label}
      colorKey={`agent:${agentId}`}
      selected={selected}
      onPress={onPress}
      maxWidth={compact ? 130 : 200}
    />
  );
}

export function TicketChip({
  colors,
  id,
  onPress,
}: {
  colors: Colors;
  id: string;
  onPress?(): void;
}) {
  return (
    <Chip
      colors={colors}
      label={id}
      onPress={onPress}
      accessibilityLabel={`Open ${id}`}
    />
  );
}

/** One feed entry: kind icon, ticket and agent chips, the title, and when. */
export function ActivityRow({
  colors,
  item,
  now,
  conductorId,
  showTicket = true,
  first,
  onPress,
}: {
  colors: Colors;
  item: ActivityItem;
  now: number;
  conductorId: string;
  showTicket?: boolean;
  first: boolean;
  onPress(): void;
}) {
  return (
    <PressableRow
      colors={colors}
      accessibilityRole="button"
      accessibilityLabel={`${item.title}, details`}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: colors.border,
      }}
    >
      <View style={{ height: LINE.body, justifyContent: "center" }}>
        <KindIcon colors={colors} kind={item.kind} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text numberOfLines={2} style={text(colors).body}>
          <MentionSpans colors={colors} text={item.title} />
        </Text>
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 6,
          }}
        >
          {showTicket && item.ticket ? (
            <TicketChip colors={colors} id={item.ticket} />
          ) : null}
          {item.by ? (
            <AgentChip
              colors={colors}
              agentId={item.by}
              conductorId={conductorId}
            />
          ) : null}
          <Text style={text(colors).small}>
            {unbroken(formatAgo(item.ts, now))}
          </Text>
          {item.body ? (
            <Icon name="AlignLeft" size={12} color={colors.foregroundMuted} />
          ) : null}
        </View>
      </View>
      <View style={{ height: LINE.body, justifyContent: "center" }}>
        <Icon name="ChevronRight" size={16} color={colors.foregroundMuted} />
      </View>
    </PressableRow>
  );
}

/** Time until the next entry on the same ticket (or the run), or still going. */
export function activityDuration(
  item: ActivityItem,
  activity: readonly ActivityItem[],
  now: number,
): { minutes: number; ongoing: boolean } {
  const start = Date.parse(item.ts);
  const next = activity
    .filter(
      (other) =>
        Date.parse(other.ts) > start &&
        (item.ticket ? other.ticket === item.ticket : true),
    )
    .map((other) => Date.parse(other.ts))
    .sort((a, b) => a - b)[0];
  return {
    minutes: Math.max(0, ((next ?? now) - start) / 60_000),
    ongoing: next === undefined,
  };
}

function Fact({
  colors,
  label,
  children,
}: {
  colors: Colors;
  label: string;
  children: ReactNode;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
      <Text style={[text(colors).muted, { width: 92 }]}>{label}</Text>
      <View
        style={{
          flex: 1,
          minWidth: 0,
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
        }}
      >
        {children}
      </View>
    </View>
  );
}

/** Everything about one feed entry: what, why (the body), when, how long, who, and its ticket. */
export function ActivityDetail({
  colors,
  item,
  activity,
  now,
  conductorId,
  ticketTitle,
  onOpenTicket,
}: {
  colors: Colors;
  item: ActivityItem;
  activity: readonly ActivityItem[];
  now: number;
  conductorId: string;
  ticketTitle?: string;
  onOpenTicket?(id: string): void;
}) {
  const duration = activityDuration(item, activity, now);
  return (
    <View style={{ gap: 16 }}>
      <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
        <KindIcon colors={colors} kind={item.kind} size={18} />
        <Text style={[text(colors).muted, { fontWeight: "600" }]}>
          {item.kind ? KIND_META[item.kind].label : "Update"}
        </Text>
      </View>
      {item.body ? (
        <Markdown colors={colors} source={item.body} />
      ) : (
        <Text style={text(colors).muted}>No details were recorded.</Text>
      )}
      <View
        style={{
          gap: 10,
          paddingTop: 12,
          borderTopWidth: 1,
          borderTopColor: colors.border,
        }}
      >
        <Fact colors={colors} label="Started">
          <Text style={text(colors).body}>
            {formatClock(item.ts)}{" "}
            <Text style={{ color: colors.foregroundMuted }}>
              ({unbroken(formatAgo(item.ts, now))})
            </Text>
          </Text>
        </Fact>
        <Fact colors={colors} label="Took">
          <Text style={text(colors).body}>
            {formatMinutes(duration.minutes)}
            {duration.ongoing ? " so far" : ""}
          </Text>
        </Fact>
        {item.by ? (
          <Fact colors={colors} label="By">
            <AgentChip
              colors={colors}
              agentId={item.by}
              conductorId={conductorId}
            />
          </Fact>
        ) : null}
        {item.ticket ? (
          <Fact colors={colors} label="Ticket">
            <TicketChip
              colors={colors}
              id={item.ticket}
              onPress={
                onOpenTicket ? () => onOpenTicket(item.ticket ?? "") : undefined
              }
            />
            {ticketTitle ? (
              <Text numberOfLines={1} style={[text(colors).muted, { flex: 1 }]}>
                {ticketTitle}
              </Text>
            ) : null}
          </Fact>
        ) : null}
      </View>
    </View>
  );
}

export function dayLabel(iso: string, now: number): string {
  const day = new Date(iso);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (day.toDateString() === today.toDateString()) return "Today";
  if (day.toDateString() === yesterday.toDateString()) return "Yesterday";
  return day.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

const RAIL = 24;

/**
 * A ticket's life as a rail: one node per step (status or stage), with its duration, and the
 * events inside it (feed entries, revised estimates, percent). The current step pulses; blocked
 * steps stand out. Days get a header.
 */
export function TimelineRail({
  colors,
  steps,
  now,
  live,
  conductorId,
  waitingLabel,
  onOpenActivity,
}: {
  colors: Colors;
  steps: TimelineStep[];
  now: number;
  live: boolean;
  conductorId: string;
  /** Replaces the label of a last blocked step that only waits on another ticket. */
  waitingLabel?: string;
  onOpenActivity(item: ActivityItem): void;
}) {
  // Newest first: the current step on top, older steps and days below it.
  const latest = steps.length - 1;
  let lastDay = "";
  return (
    <View>
      {steps
        .map((step, original) => ({ step, original }))
        .reverse()
        .map(({ step, original }, index) => {
          const day = dayLabel(step.ts, now);
          const header = day !== lastDay;
          lastDay = day;
          const current = original === latest;
          const waiting = Boolean(
            current && waitingLabel && step.status === "blocked",
          );
          return (
            <View key={`${step.ts}-${original}`}>
              {header ? (
                <Text
                  style={[
                    text(colors).small,
                    {
                      fontWeight: "600",
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                      paddingTop: index ? 10 : 0,
                      paddingBottom: 6,
                    },
                  ]}
                >
                  {day}
                </Text>
              ) : null}
              <StepNode
                colors={colors}
                step={waiting ? { ...step, label: waitingLabel! } : step}
                waiting={waiting}
                current={current && step.minutes !== null}
                last={index === latest}
                now={now}
                live={live}
                conductorId={conductorId}
                onOpenActivity={onOpenActivity}
              />
            </View>
          );
        })}
    </View>
  );
}

function StepMark({
  colors,
  step,
  current,
  waiting,
  live,
}: {
  colors: Colors;
  step: TimelineStep;
  current: boolean;
  waiting: boolean;
  live: boolean;
}) {
  if (current && step.status === "working")
    return live ? (
      <Spinner color={colors.accent} size={16} />
    ) : (
      <StalledPulse color={colors.statusWarning} size={16} />
    );
  const mark =
    waiting || step.status === "not_started"
      ? {
          name: step.label === "Added" ? "CirclePlus" : "Circle",
          color: colors.foregroundMuted,
        }
      : step.status === "done"
        ? { name: "CircleCheck", color: colors.statusSuccess }
        : step.status === "blocked"
          ? { name: "Ban", color: colors.statusDanger }
          : step.status === "skipped"
            ? { name: "CircleSlash", color: colors.foregroundMuted }
            : { name: "CircleDot", color: colors.accent };
  return <Icon name={mark.name} size={16} color={mark.color} />;
}

function StepNode({
  colors,
  step,
  current,
  waiting,
  last,
  now,
  live,
  conductorId,
  onOpenActivity,
}: {
  colors: Colors;
  step: TimelineStep;
  current: boolean;
  waiting: boolean;
  last: boolean;
  now: number;
  live: boolean;
  conductorId: string;
  onOpenActivity(item: ActivityItem): void;
}) {
  const blocked = step.status === "blocked" && !waiting;
  return (
    <View style={{ flexDirection: "row", gap: 10 }}>
      <View style={{ width: RAIL, alignItems: "center" }}>
        <View
          style={{
            width: RAIL,
            height: RAIL,
            borderRadius: RAIL / 2,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: blocked
              ? `${colors.statusDanger}22`
              : current
                ? colors.surface2
                : colors.surface1,
            borderWidth: 1,
            borderColor: blocked
              ? colors.statusDanger
              : current
                ? colors.accent
                : colors.border,
          }}
        >
          <StepMark
            colors={colors}
            step={step}
            current={current}
            waiting={waiting}
            live={live}
          />
        </View>
        {last && !step.events.length ? null : (
          <View
            style={{
              flex: 1,
              width: 2,
              minHeight: 12,
              backgroundColor: colors.border,
            }}
          />
        )}
      </View>
      <View
        style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : 14, gap: 6 }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            minHeight: RAIL,
            flexWrap: "wrap",
          }}
        >
          <Text
            style={[
              text(colors).body,
              {
                fontWeight: "600",
                color: blocked ? colors.statusDanger : colors.foreground,
              },
            ]}
          >
            {step.label}
          </Text>
          <Text style={[text(colors).muted, { fontVariant: ["tabular-nums"] }]}>
            {formatTimeOfDay(step.ts, now)}
          </Text>
          {step.minutes !== null ? (
            <Chip
              colors={colors}
              colorKey={null}
              icon="Clock"
              label={`${formatMinutes(step.minutes)}${current ? " so far" : ""}`}
            />
          ) : null}
        </View>
        {[...step.events].reverse().map((event, index) => (
          <EventRow
            key={`${event.ts}-${index}`}
            colors={colors}
            event={event}
            now={now}
            conductorId={conductorId}
            onOpenActivity={onOpenActivity}
          />
        ))}
      </View>
    </View>
  );
}

function EventRow({
  colors,
  event,
  now,
  conductorId,
  onOpenActivity,
}: {
  colors: Colors;
  event: TimelineEvent;
  now: number;
  conductorId: string;
  onOpenActivity(item: ActivityItem): void;
}) {
  const time = (
    <Text style={[text(colors).small, { fontVariant: ["tabular-nums"] }]}>
      {formatTimeOfDay(event.ts, now)}
    </Text>
  );
  if (event.type === "activity") {
    const { item } = event;
    return (
      <PressableRow
        colors={colors}
        onSurface1
        accessibilityRole="button"
        accessibilityLabel={`${item.title}, details`}
        onPress={() => onOpenActivity(item)}
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 8,
          paddingVertical: 4,
          paddingHorizontal: 6,
          marginHorizontal: -6,
          borderRadius: 6,
        }}
      >
        <View style={{ height: LINE.secondary, justifyContent: "center" }}>
          <KindIcon colors={colors} kind={item.kind} size={14} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={text(colors).muted}>
            <Text style={{ color: colors.foreground }}>
              <MentionSpans colors={colors} text={item.title} />
            </Text>
          </Text>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 6,
            }}
          >
            {time}
            {item.by ? (
              <AgentChip
                colors={colors}
                agentId={item.by}
                conductorId={conductorId}
              />
            ) : null}
          </View>
        </View>
      </PressableRow>
    );
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon
        name={event.type === "estimate" ? "Timer" : "Gauge"}
        size={14}
        color={colors.foregroundMuted}
      />
      <Text style={[text(colors).muted, { flex: 1 }]}>
        {event.type === "estimate"
          ? `ETA updated: ${formatMinutes(event.from)} → ${formatMinutes(event.to)}`
          : `${event.percent}% done`}
      </Text>
      {time}
    </View>
  );
}

/** How far along a ticket is; a soft (time-based) estimate reads as "about". */
export function PercentBar({
  colors,
  fraction,
  reported,
  compact = false,
  caption,
  captionInline = false,
  captionWarn = false,
}: {
  colors: Colors;
  fraction: number;
  /** Whether an agent reported the percent, rather than it coming from time worked. */
  reported: boolean;
  compact?: boolean;
  /** A small line about time, beside the percent when inline, else under the bar. */
  caption?: string;
  captionInline?: boolean;
  captionWarn?: boolean;
}) {
  const percent = Math.round(fraction * 100);
  const captionText = caption ? (
    <Text
      numberOfLines={1}
      style={[
        text(colors).small,
        { fontVariant: ["tabular-nums"], flexShrink: 1 },
        captionWarn ? { color: colors.statusWarning } : null,
      ]}
    >
      {caption}
    </Text>
  ) : null;
  const bar = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: compact ? 6 : 10,
      }}
    >
      <View
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: percent }}
        style={{
          flex: 1,
          minWidth: 60,
          height: compact ? 4 : 6,
          borderRadius: 3,
          overflow: "hidden",
          backgroundColor: colors.surface2,
        }}
      >
        <View
          style={{
            width: `${percent}%`,
            height: "100%",
            borderRadius: 3,
            backgroundColor: colors.accent,
            opacity: reported ? 1 : 0.6,
          }}
        />
      </View>
      <Text
        style={[
          compact ? text(colors).small : text(colors).muted,
          { fontVariant: ["tabular-nums"], minWidth: compact ? 34 : 64 },
        ]}
      >
        {reported ? `${percent}%` : `~${percent}%`}
        {compact ? "" : " done"}
      </Text>
      {captionInline ? captionText : null}
    </View>
  );
  if (!captionText || captionInline) return bar;
  return (
    <View style={{ gap: 2 }}>
      {bar}
      {captionText}
    </View>
  );
}

const KEY_ICON: Partial<Record<SearchKey | "sort", string>> = {
  status: "CircleDot",
  is: "Funnel",
  label: "Tag",
  agent: "Bot",
  stage: "Layers",
  ticket: "Hash",
  kind: "Shapes",
  sort: "ArrowUpDown",
};

/**
 * GitHub-style search: typing suggests filter keys, then the values present in the data (fuzzy,
 * with counts); dropdown buttons pick values per key; active filters show as removable chips.
 * Lists open inline under the box, so they never clip inside panels, popovers, or dialogs.
 */
export function SearchBar({
  colors,
  conductorId,
  query,
  onChange,
  facets,
  menus,
  sorts,
  onSort,
  placeholder,
  trailing,
}: {
  colors: Colors;
  conductorId: string;
  query: string;
  onChange(query: string): void;
  facets: Facet[];
  /** Keys that get a dropdown button, in order. */
  menus: SearchKey[];
  /** Offers `sort:` in suggestions when given. */
  sorts?: readonly { id: TicketSort; label: string }[];
  onSort?(sort: TicketSort): void;
  placeholder: string;
  /** Extra controls after the dropdown buttons. */
  trailing?: ReactNode;
}) {
  const input = useRef<NativeTextInput>(null);
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(query.length);
  const [selection, setSelection] = useState<
    { start: number; end: number } | undefined
  >(undefined);
  const [menu, setMenu] = useState<SearchKey | null>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    [],
  );
  const suggestions = focused
    ? suggest(query, Math.min(caret, query.length), facets, sorts ?? [])
    : null;
  const pick = (item: Suggestion) => {
    if (!suggestions) return;
    if (item.type === "sort") onSort?.(item.sort);
    const next = applySuggestion(query, suggestions.token, item);
    onChange(next.query);
    setCaret(next.caret);
    setSelection({ start: next.caret, end: next.caret });
    input.current?.focus();
  };
  const tokens = parseQuery(query).tokens;
  const menuFacet = facets.find((facet) => facet.key === menu);
  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: colors.border,
        paddingVertical: 8,
        paddingHorizontal: 12,
        gap: 6,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 8,
          borderWidth: 1,
          borderColor: focused ? colors.accent : colors.border,
          borderRadius: 6,
          backgroundColor: colors.surface0,
        }}
      >
        <Icon name="Search" size={14} color={colors.foregroundMuted} />
        <TextInput
          ref={input}
          accessibilityLabel={placeholder}
          value={query}
          onChangeText={onChange}
          selection={selection}
          onSelectionChange={(event) => {
            setCaret(event.nativeEvent.selection.end);
            setSelection(undefined);
          }}
          onFocus={() => {
            if (blurTimer.current) clearTimeout(blurTimer.current);
            setFocused(true);
            setMenu(null);
          }}
          // Late, so a tap on a suggestion lands before the list goes away.
          onBlur={() => {
            blurTimer.current = setTimeout(() => setFocused(false), 200);
          }}
          placeholder={placeholder}
          placeholderTextColor={colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={{
            flex: 1,
            minWidth: 0,
            color: colors.foreground,
            fontSize: FONT.small,
            paddingVertical: 6,
          }}
        />
        {query ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            hitSlop={6}
            onPress={() => onChange("")}
          >
            <Icon name="X" size={14} color={colors.foregroundMuted} />
          </Pressable>
        ) : null}
      </View>
      {suggestions?.items.length ? (
        <DropdownList colors={colors}>
          {suggestions.items.map((item) => (
            <DropdownRow
              key={
                item.type === "key"
                  ? `key:${item.key}`
                  : item.type === "sort"
                    ? `sort:${item.sort}`
                    : `${item.key}:${item.value}`
              }
              colors={colors}
              icon={
                item.type === "key"
                  ? KEY_ICON[item.key]
                  : KEY_ICON[item.type === "sort" ? "sort" : item.key]
              }
              label={
                item.type === "key"
                  ? item.label
                  : item.type === "sort"
                    ? `sort: ${item.label}`
                    : `${item.key}:${item.value}`
              }
              detail={
                item.type === "key"
                  ? item.hint
                  : item.type === "value" && item.label !== item.value
                    ? item.label
                    : undefined
              }
              count={item.type === "value" ? item.count : undefined}
              onPress={() => pick(item)}
            />
          ))}
        </DropdownList>
      ) : null}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
        }}
      >
        {menus.flatMap((key) => {
          const facet = facets.find((candidate) => candidate.key === key);
          if (!facet?.values.length) return [];
          const chosen = tokens.filter(
            (token) => token.key === key && !token.negate,
          ).length;
          return [
            <Chip
              key={key}
              colors={colors}
              colorKey={null}
              icon={menu === key ? "ChevronUp" : "ChevronDown"}
              label={chosen ? `${facet.label} · ${chosen}` : facet.label}
              selected={menu === key || chosen > 0}
              onPress={() => setMenu(menu === key ? null : key)}
              accessibilityLabel={`Filter by ${facet.label}`}
            />,
          ];
        })}
        {trailing}
      </View>
      {menuFacet ? (
        <DropdownList colors={colors}>
          {tokens.some((token) => token.key === menuFacet.key) ? (
            <DropdownRow
              colors={colors}
              icon="X"
              label={`Clear ${menuFacet.label.toLowerCase()}`}
              onPress={() =>
                onChange(
                  tokens
                    .filter((token) => token.key === menuFacet.key)
                    .reduce(removeToken, query),
                )
              }
            />
          ) : null}
          {menuFacet.values.map((value) => {
            const checked = hasToken(query, menuFacet.key, value.value);
            return (
              <DropdownRow
                key={value.value}
                colors={colors}
                icon={checked ? "SquareCheck" : "Square"}
                iconColor={checked ? colors.accent : undefined}
                label={value.label ?? value.value}
                detail={
                  value.label && value.label !== value.value
                    ? value.value
                    : undefined
                }
                count={value.count}
                agentId={value.agentId}
                conductorId={conductorId}
                checked={checked}
                onPress={() =>
                  onChange(toggleToken(query, menuFacet.key, value.value))
                }
              />
            );
          })}
        </DropdownList>
      ) : null}
      {tokens.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {tokens.map((token) => (
            <Chip
              key={`${token.negate ? "-" : ""}${token.key}:${token.value}`}
              colors={colors}
              colorKey={token.key === "label" ? token.value : null}
              icon="X"
              label={`${token.negate ? "not " : ""}${token.key}: ${token.value}`}
              onPress={() => onChange(removeToken(query, token))}
              accessibilityLabel={`Remove ${token.key} ${token.value}`}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function DropdownList({
  colors,
  children,
}: {
  colors: Colors;
  children: ReactNode;
}) {
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={{
        maxHeight: 260,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 6,
        backgroundColor: colors.surface1,
      }}
      contentContainerStyle={{ paddingVertical: 4 }}
    >
      {children}
    </ScrollView>
  );
}

function DropdownRow({
  colors,
  icon,
  iconColor,
  label,
  detail,
  count,
  agentId,
  conductorId,
  checked,
  onPress,
}: {
  colors: Colors;
  icon?: string;
  iconColor?: string;
  label: string;
  detail?: string;
  count?: number;
  agentId?: string;
  conductorId?: string;
  checked?: boolean;
  onPress(): void;
}) {
  return (
    <PressableRow
      colors={colors}
      onSurface1
      accessibilityRole={checked === undefined ? "button" : "checkbox"}
      accessibilityState={checked === undefined ? undefined : { checked }}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 6,
      }}
    >
      {icon ? (
        <Icon
          name={icon}
          size={14}
          color={iconColor ?? colors.foregroundMuted}
        />
      ) : null}
      {agentId && conductorId ? (
        <View style={{ flexShrink: 1, minWidth: 0 }}>
          <AgentChip
            colors={colors}
            agentId={agentId}
            conductorId={conductorId}
            compact
          />
        </View>
      ) : (
        <Text
          numberOfLines={1}
          style={[text(colors).body, { flexShrink: 1, fontWeight: "600" }]}
        >
          {label}
        </Text>
      )}
      {detail ? (
        <Text
          numberOfLines={1}
          style={[text(colors).small, { flex: 1, minWidth: 0 }]}
        >
          {detail}
        </Text>
      ) : (
        <View style={{ flex: 1 }} />
      )}
      {count !== undefined ? (
        <Text style={[text(colors).small, { fontVariant: ["tabular-nums"] }]}>
          {count}
        </Text>
      ) : null}
    </PressableRow>
  );
}

/** A day heading in a newest-first list: Today, Yesterday, or the date. */
export function DayHeader({
  colors,
  label,
  first,
}: {
  colors: Colors;
  label: string;
  first: boolean;
}) {
  return (
    <Text
      style={[
        text(colors).small,
        {
          fontWeight: "600",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          paddingHorizontal: 12,
          paddingTop: first ? 8 : 12,
          paddingBottom: 4,
        },
      ]}
    >
      {label}
    </Text>
  );
}

/** Items in order, each marked with the day label when it starts a new day. */
export function withDays<T>(
  items: readonly T[],
  ts: (item: T) => string,
  now: number,
): { item: T; day?: string }[] {
  let last = "";
  return items.map((item) => {
    const day = dayLabel(ts(item), now);
    if (day === last) return { item };
    last = day;
    return { item, day };
  });
}
