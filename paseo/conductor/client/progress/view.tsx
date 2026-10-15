/**
 * The progress dashboard of one conductor run. Layout, sections, and motion are ported from the
 * Progress plugin by Steve Castaneda (MIT,
 * https://github.com/stevecastaneda/paseo-plugins/tree/main/progress).
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import {
  Icon,
  Modal,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Text, View } from "react-native";

import {
  type Attachment,
  attachmentIcon,
  canPreview,
  shortName,
} from "../../shared/attachments.js";
import {
  buildDashboard,
  type Dashboard,
  type DashboardTicket,
  isSettled,
  type ProgressSegment,
  type RowChip,
  rowChips,
  type StuckItem,
  ticketLine,
} from "../../shared/dashboard.js";
import {
  formatAgo,
  formatMinutes,
  formatTicketTimeShort,
  formatWorkDone,
  minutesSince,
  unbroken,
} from "../../shared/format.js";
import {
  type ActivityItem,
  choiceKeys,
  type DashboardView as SavedView,
  dashboardViewSchema,
  displayState,
  getProgressRpc,
  saveViewRpc,
  type ProgressState,
  type Question,
  runHistoryRpc,
  setTicketPrefixRpc,
  displayTicketId,
  ticketFraction,
  ticketPrefixSchema,
  workedMs,
} from "../../shared/progress.js";
import { useConductors, useWorkers } from "../data.js";
import { errorMessage } from "../errors.js";
import {
  ActivityRow,
  AgentChip,
  Chip,
  DayHeader,
  PercentBar,
  SearchBar,
  withDays,
} from "./feed.js";
import {
  type FeedEntry,
  feedFacets,
  matchFeed,
  matchTicket,
  parseQuery,
  type SearchContext,
  sortTickets,
  TICKET_PAGE,
  TICKET_SORTS,
  ticketFacets,
  type TicketSort,
  ticketPage,
} from "../../shared/search.js";
import {
  activityKey,
  deliverableAttachments,
  DialogButton,
  type Navigation,
  PreviewDialog,
  StackedDialog,
  type Step,
  useAttachmentOpener,
} from "./dialogs.js";
import {
  Card,
  type Colors,
  FONT,
  IconSwap,
  LINE,
  NARROW_MAX,
  NarrowProvider,
  nativeDriver,
  PressableRow,
  PressScale,
  Presence,
  raised,
  SectionTitle,
  ShowMoreRow,
  Spinner,
  StaggerRoot,
  StalledPulse,
  STATUS_LABEL,
  StatusIcon,
  StatusLine,
  TabStrip,
  text,
  useNarrow,
  useNow,
  usePaged,
  When,
} from "./ui.js";
import { MentionProvider, MentionSpans } from "./mentions.js";

const REFETCH_MS = 3_000;
/** Two columns when opened as a wide tab; one in the narrow explorer pane. */
const WIDE_MIN = 760;

type ProgressReply = {
  state: ProgressState | null;
  ticketPrefix: string;
  view: SavedView;
  escalated: Record<string, number>;
};
// Stable selectors, so React Query keeps the selected value between polls that changed nothing.
const selectState = ({ state, ticketPrefix }: ProgressReply) =>
  state ? displayState(state, ticketPrefix) : null;
const selectPrefix = (reply: ProgressReply) => reply.ticketPrefix;
const selectView = (reply: ProgressReply) => reply.view;
const selectEscalated = ({ escalated, ticketPrefix }: ProgressReply) =>
  Object.fromEntries(
    Object.entries(escalated).map(([key, count]) => [
      displayTicketId(key, ticketPrefix),
      count,
    ]),
  );
const DEFAULT_VIEW = dashboardViewSchema.parse({});

/** The dashboard's search and sort: saved per conductor on the host, a moment after each change. */
function useSavedView(conductorId: string) {
  const saved = useProgressQuery(conductorId, selectView).data;
  const saveView = useRpc(saveViewRpc);
  const [view, setView] = useState<SavedView | null>(null);
  const current = view ?? saved ?? DEFAULT_VIEW;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const update = (change: Partial<SavedView>) => {
    const next = { ...current, ...change };
    setView(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      saveView({ conductorId, view: next }).catch((error: unknown) =>
        console.warn("Saving the dashboard view failed", error),
      );
    }, 600);
  };
  return [current, update] as const;
}

/** Names people see for the run's agents, for agent: search and chips. */
function useAgentNames(conductorId: string): Map<string, string> {
  const workers = useWorkers(conductorId).data;
  const names = new Map<string, string>([
    ["user", "You"],
    [conductorId, "Conductor"],
  ]);
  for (const worker of workers ?? [])
    if (worker.title?.trim()) names.set(worker.id, worker.title.trim());
  return names;
}

/** Search only pays off on bigger runs; small ones keep the plain list. */
const SEARCH_FROM = 6;

function useProgressQuery<T>(
  conductorId: string,
  select: (reply: ProgressReply) => T,
) {
  const getProgress = useRpc(getProgressRpc);
  return useQuery({
    queryKey: ["conductor", "progress", conductorId],
    queryFn: () => getProgress({ conductorId }),
    refetchInterval: REFETCH_MS,
    select,
  });
}

/** The run, with ticket ids as this conductor's prefix reads them. */
export function useProgress(conductorId: string) {
  return useProgressQuery(conductorId, selectState);
}

/** Whether the conductor or one of its workers is running, so quiet isn't stale. */
function useAgentRunning(conductorId: string): boolean {
  const conductors = useConductors();
  const workers = useWorkers(conductorId);
  return [
    ...(workers.data ?? []),
    ...(conductors.data ?? []).filter((agent) => agent.id === conductorId),
  ].some((agent) => agent.status === "running");
}

/** Live progress of one conductor run, sized to the space it gets. */
export function ProgressView({
  conductorId,
  theme,
  workspaceId,
  navigation,
}: {
  conductorId: string;
  theme: PluginTheme;
  workspaceId?: string;
  navigation?: Navigation;
}) {
  const colors = theme.colors;
  const progress = useProgress(conductorId);
  const agentRunning = useAgentRunning(conductorId);
  const [width, setWidth] = useState(0);
  const state = progress.data;
  return (
    <NarrowProvider value={width > 0 && width <= NARROW_MAX}>
      <View
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={{ paddingBottom: 16 }}
      >
        {progress.isPending ? (
          <ActivityIndicator
            color={colors.foregroundMuted}
            accessibilityLabel="Loading progress"
            style={{ padding: 16 }}
          />
        ) : null}
        {progress.error ? (
          <Text
            accessibilityRole="alert"
            selectable
            style={[
              text(colors).muted,
              { color: colors.statusDanger, padding: 12 },
            ]}
          >
            Could not read progress: {errorMessage(progress.error)}
          </Text>
        ) : null}
        {!progress.isPending && !state && !progress.error ? (
          <EmptyState colors={colors} />
        ) : null}
        {state ? (
          // Keyed by run: a new run starts with fresh tabs, pages, and dialogs.
          <DashboardView
            key={state.startedAt}
            colors={colors}
            conductorId={conductorId}
            dashboardInput={state}
            agentRunning={agentRunning}
            wide={width >= WIDE_MIN}
            workspaceId={workspaceId}
            navigation={navigation}
          />
        ) : null}
        <HistoryRow colors={colors} conductorId={conductorId} />
        <TicketPrefixRow colors={colors} conductorId={conductorId} />
      </View>
    </NarrowProvider>
  );
}

function EmptyState({ colors }: { colors: Colors }) {
  return (
    <View style={{ padding: 14, paddingTop: 20, gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Icon name="ListChecks" size={20} color={colors.foregroundMuted} />
        <Text
          accessibilityRole="header"
          style={[text(colors).body, { fontWeight: "500" }]}
        >
          No progress recorded yet
        </Text>
      </View>
      <Text style={text(colors).muted}>
        The conductor and its workers record progress with the{" "}
        <Text style={{ color: colors.foreground }}>progress</Text> tool. It
        shows up here as soon as the first run starts.
      </Text>
    </View>
  );
}

function DashboardView({
  colors,
  conductorId,
  dashboardInput,
  agentRunning,
  wide,
  workspaceId,
  navigation,
}: {
  colors: Colors;
  conductorId: string;
  dashboardInput: Dashboard["state"];
  agentRunning: boolean;
  wide: boolean;
  workspaceId?: string;
  navigation?: Navigation;
}) {
  const now = useNow(15_000);
  const dashboard = buildDashboard(dashboardInput, now);
  const { state } = dashboard;
  // Quiet isn't stale while an agent of the conductor is still running.
  const stale = dashboard.stale && !agentRunning;
  const live = !stale;
  const [dialog, setDialog] = useState<Step | null>(null);
  const [view, updateView] = useSavedView(conductorId);
  const escalated = useProgressQuery(conductorId, selectEscalated).data ?? {};
  const names = useAgentNames(conductorId);
  const agentName = (agentId: string) =>
    names.get(agentId) ?? agentId.slice(0, 8);
  const byId = new Map(dashboard.tickets.map((ticket) => [ticket.id, ticket]));
  const context: SearchContext = { now, agentNames: names, byId };
  const ticketQuery = parseQuery(view.ticketQuery);
  const tickets = sortTickets(
    dashboard.tickets.filter((ticket) =>
      matchTicket(ticket, ticketQuery, context),
    ),
    view.ticketSort,
    now,
    state.activity,
  );
  const searchTickets =
    dashboard.tickets.length >= SEARCH_FROM || Boolean(view.ticketQuery);
  const feedQuery = parseQuery(view.feedQuery);
  // Scoped, the feed keeps only entries of tickets the ticket search shows.
  const scope =
    view.feedScoped && view.ticketQuery.trim()
      ? new Set(tickets.map((ticket) => ticket.id))
      : null;
  const inFeed = (entry: FeedEntry) =>
    matchFeed(entry, feedQuery, byId, context) &&
    (!scope ||
      (entry.item.ticket !== undefined && scope.has(entry.item.ticket)));
  const activity = dashboard.activity.filter((item) =>
    inFeed({ type: "activity", item }),
  );
  const answered = dashboard.questions.answered.filter((item) =>
    inFeed({ type: "question", item }),
  );
  const deliverables = dashboard.deliverables.filter((item) =>
    inFeed({ type: "deliverable", item }),
  );
  const feedTotal =
    dashboard.activity.length +
    dashboard.questions.answered.length +
    dashboard.deliverables.length;
  const searchFeed = feedTotal >= SEARCH_FROM * 2 || Boolean(view.feedQuery);
  const filteredOut = (shown: number, all: number) =>
    shown < all ? "Nothing matches the search." : undefined;
  const hasHistory =
    dashboard.activity.length +
      dashboard.questions.answered.length +
      dashboard.deliverables.length >
    0;
  const dialogProps = {
    colors,
    conductorId,
    dashboard,
    now,
    live,
    workspaceId,
    navigation,
  };
  return (
    <MentionProvider
      tickets={dashboard.tickets}
      onOpen={(id) => setDialog({ kind: "ticket", id })}
    >
      <StaggerRoot>
        <Presence show order={0}>
          <Header colors={colors} dashboard={dashboard} live={live} now={now} />
        </Presence>
        <Presence show={stale} order={1}>
          <View
            accessibilityRole="alert"
            style={{
              flexDirection: "row",
              gap: 10,
              margin: 12,
              marginBottom: 0,
              padding: 12,
              borderWidth: 1,
              borderColor: colors.statusWarning,
              borderRadius: 8,
            }}
          >
            <View style={{ paddingTop: 2 }}>
              <Icon
                name="TriangleAlert"
                size={16}
                color={colors.statusWarning}
              />
            </View>
            <Text
              style={[
                text(colors).muted,
                { flex: 1, color: colors.statusWarning },
              ]}
            >
              Possibly stale. No update for{" "}
              {unbroken(formatMinutes(minutesSince(state.updatedAt, now)))}. The
              work may have stopped, so working items show a warning until the
              next update.
            </Text>
          </View>
        </Presence>
        <Presence show={dashboard.tickets.length > 0} order={2}>
          <ProgressBar colors={colors} dashboard={dashboard} live={live} />
        </Presence>
        <View
          style={{
            flexDirection: wide ? "row" : "column",
            alignItems: "flex-start",
          }}
        >
          <View
            style={{
              flex: wide ? 3 : undefined,
              alignSelf: "stretch",
              minWidth: 0,
            }}
          >
            <Presence show={dashboard.questions.open.length > 0} order={3}>
              <QuestionsCard
                colors={colors}
                questions={dashboard.questions.open}
                onOpen={(id) => setDialog({ kind: "question", id })}
              />
            </Presence>
            <Presence show={dashboard.stuck.length > 0} order={3}>
              <StuckCard
                colors={colors}
                items={dashboard.stuck}
                escalated={escalated}
                now={now}
                onOpenQuestion={(id) => setDialog({ kind: "question", id })}
              />
            </Presence>
            <Presence show order={4}>
              <Card
                colors={colors}
                icon="ListChecks"
                title="Tickets"
                trailing={
                  searchTickets ? (
                    <>
                      <Text
                        style={[
                          text(colors).small,
                          { fontVariant: ["tabular-nums"] },
                        ]}
                      >
                        {tickets.length === dashboard.tickets.length
                          ? `${tickets.length}`
                          : `${tickets.length} of ${dashboard.tickets.length}`}
                      </Text>
                      <SortPicker
                        colors={colors}
                        sort={view.ticketSort}
                        onChange={(ticketSort) => updateView({ ticketSort })}
                      />
                    </>
                  ) : null
                }
              >
                {dashboard.tickets.length === 0 ? (
                  <Text
                    style={[
                      text(colors).muted,
                      {
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        borderTopWidth: 1,
                        borderTopColor: colors.border,
                      },
                    ]}
                  >
                    No tickets yet.
                  </Text>
                ) : searchTickets ? (
                  <SearchBar
                    colors={colors}
                    conductorId={conductorId}
                    query={view.ticketQuery}
                    onChange={(ticketQuery) => updateView({ ticketQuery })}
                    facets={ticketFacets(dashboard.tickets, agentName, now)}
                    menus={["status", "label", "agent"]}
                    sorts={TICKET_SORTS}
                    onSort={(ticketSort) => updateView({ ticketSort })}
                    placeholder="Search: is:blocked label:ui agent:name text"
                  />
                ) : null}
                {dashboard.tickets.length === 0 ? null : tickets.length ===
                  0 ? (
                  <Text
                    style={[
                      text(colors).muted,
                      {
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        borderTopWidth: 1,
                        borderTopColor: colors.border,
                      },
                    ]}
                  >
                    No tickets match.
                  </Text>
                ) : (
                  <TicketList
                    colors={colors}
                    conductorId={conductorId}
                    dashboard={dashboard}
                    tickets={tickets}
                    resetKey={`${view.ticketQuery}|${view.ticketSort}`}
                    live={live}
                    now={now}
                    onOpen={(id) => setDialog({ kind: "ticket", id })}
                  />
                )}
              </Card>
            </Presence>
          </View>
          <View
            style={{
              flex: wide ? 2 : undefined,
              alignSelf: "stretch",
              minWidth: 0,
            }}
          >
            <Presence show={hasHistory} order={5}>
              <HistoryCard
                colors={colors}
                conductorId={conductorId}
                search={
                  searchFeed ? (
                    <SearchBar
                      colors={colors}
                      conductorId={conductorId}
                      query={view.feedQuery}
                      onChange={(feedQuery) => updateView({ feedQuery })}
                      facets={feedFacets(
                        [
                          ...dashboard.activity.map((item) => ({
                            type: "activity" as const,
                            item,
                          })),
                          ...dashboard.questions.answered.map((item) => ({
                            type: "question" as const,
                            item,
                          })),
                          ...dashboard.deliverables.map((item) => ({
                            type: "deliverable" as const,
                            item,
                          })),
                        ],
                        byId,
                        agentName,
                      )}
                      menus={["kind", "label", "agent", "ticket"]}
                      placeholder="Search: ticket:3 kind:fix agent:name text"
                      trailing={
                        view.ticketQuery.trim() ? (
                          <Chip
                            colors={colors}
                            colorKey={null}
                            icon="ListChecks"
                            label="Only searched tickets"
                            selected={view.feedScoped}
                            onPress={() =>
                              updateView({ feedScoped: !view.feedScoped })
                            }
                          />
                        ) : null
                      }
                    />
                  ) : null
                }
                tabs={[
                  {
                    id: "activity",
                    label: "Activity",
                    icon: "Activity",
                    count: activity.length,
                    empty:
                      filteredOut(activity.length, dashboard.activity.length) ??
                      "No activity yet.",
                    content: (
                      <ActivityList
                        colors={colors}
                        conductorId={conductorId}
                        activity={activity}
                        now={now}
                        onOpen={(item) =>
                          setDialog({ kind: "activity", id: activityKey(item) })
                        }
                      />
                    ),
                  },
                  {
                    id: "answered",
                    label: "Answered",
                    icon: "CircleCheck",
                    count: answered.length,
                    empty:
                      filteredOut(
                        answered.length,
                        dashboard.questions.answered.length,
                      ) ?? "No answered questions yet.",
                    content: (
                      <AnsweredList
                        colors={colors}
                        conductorId={conductorId}
                        questions={answered}
                        now={now}
                        onOpen={(id) => setDialog({ kind: "question", id })}
                      />
                    ),
                  },
                  {
                    id: "deliverables",
                    label: "Deliverables",
                    icon: "Package",
                    count: deliverables.length,
                    empty:
                      filteredOut(
                        deliverables.length,
                        dashboard.deliverables.length,
                      ) ?? "No deliverables yet.",
                    content: (
                      <DeliverablesList
                        colors={colors}
                        conductorId={conductorId}
                        deliverables={deliverables}
                        now={now}
                        workspaceId={workspaceId}
                        navigation={navigation}
                      />
                    ),
                  },
                ]}
              />
            </Presence>
          </View>
        </View>
        <StackedDialog
          {...dialogProps}
          root={dialog}
          onClose={() => setDialog(null)}
        />
      </StaggerRoot>
    </MentionProvider>
  );
}

function Header({
  colors,
  dashboard,
  live,
  now,
}: {
  colors: Colors;
  dashboard: Dashboard;
  live: boolean;
  now: number;
}) {
  const { state } = dashboard;
  const finished = state.finished;
  const ticker = !finished ? state.ticker : undefined;
  return (
    <View
      style={{
        paddingHorizontal: 14,
        paddingTop: 14,
        paddingBottom: 12,
        gap: 6,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <Text accessibilityRole="header" style={text(colors).title}>
        {state.title}
      </Text>
      {state.subtitle ? (
        <Text style={text(colors).muted}>{state.subtitle}</Text>
      ) : null}
      <Text accessibilityLiveRegion="polite" style={text(colors).muted}>
        {dashboard.headline.map((part, index) => (
          <Text
            key={part.text}
            style={
              part.tone === "danger"
                ? { color: colors.statusDanger }
                : undefined
            }
          >
            {index ? ", " : ""}
            {part.text}
          </Text>
        ))}
      </Text>
      {/* One status slot: the icon morphs from spinner (or stalled pulse) to a check on finish. */}
      {finished || ticker ? (
        <StatusLine
          icon={
            <IconSwap
              swapKey={finished ? "finished" : live ? "live" : "stale"}
              size={16}
            >
              {finished ? (
                <Icon
                  name="CircleCheck"
                  size={16}
                  color={colors.statusSuccess}
                />
              ) : live ? (
                <Spinner color={colors.accent} size={16} />
              ) : (
                <StalledPulse color={colors.statusWarning} size={16} />
              )}
            </IconSwap>
          }
        >
          {finished ? (
            <>
              <Text style={text(colors).muted}>
                <Text
                  style={{ color: colors.statusSuccess, fontWeight: "600" }}
                >
                  Finished
                </Text>{" "}
                <When colors={colors} iso={finished.ts} now={now} />
              </Text>
              <Text style={text(colors).body}>{finished.outcome}</Text>
            </>
          ) : (
            <Text accessibilityLiveRegion="polite" style={text(colors).body}>
              {ticker?.text}
            </Text>
          )}
        </StatusLine>
      ) : null}
      {!finished ? (
        <StatusLine
          icon={<Icon name="Clock" size={14} color={colors.foregroundMuted} />}
        >
          <Text style={text(colors).muted}>
            Last updated{" "}
            <When colors={colors} iso={state.updatedAt} now={now} />
          </Text>
        </StatusLine>
      ) : null}
    </View>
  );
}

function ProgressBar({
  colors,
  dashboard,
  live,
}: {
  colors: Colors;
  dashboard: Dashboard;
  live: boolean;
}) {
  const narrow = useNarrow();
  const { progress } = dashboard;
  return (
    <View
      style={{
        paddingHorizontal: 14,
        paddingVertical: 14,
        gap: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text style={[text(colors).muted, { flex: 1 }]}>
          <Text
            style={{
              color: colors.foreground,
              fontWeight: "600",
              fontSize: FONT.body,
            }}
          >
            {progress.percent}%
          </Text>{" "}
          {narrow
            ? "done"
            : progress.totalMin
              ? "of estimated work done"
              : "of tickets done"}
        </Text>
        {progress.totalMin ? (
          <Text style={[text(colors).muted, { fontVariant: ["tabular-nums"] }]}>
            {formatWorkDone(
              progress.doneMin,
              progress.totalMin,
              progress.tookMin,
            )}
          </Text>
        ) : null}
      </View>
      <View
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: progress.percent }}
        style={{
          flexDirection: "row",
          gap: 2,
          height: 10,
          borderRadius: 5,
          overflow: "hidden",
        }}
      >
        {progress.segments.map((segment) => (
          <Segment
            key={segment.id}
            colors={colors}
            segment={segment}
            live={live}
          />
        ))}
      </View>
    </View>
  );
}

/** A ticket's slice of the bar, filled as far as the ticket has come. */
function Segment({
  colors,
  segment,
  live,
}: {
  colors: Colors;
  segment: ProgressSegment;
  live: boolean;
}) {
  const working = segment.status === "working";
  const blocked = segment.status === "blocked" && !segment.waiting;
  const fill = blocked ? colors.statusDanger : colors.accent;
  return (
    <View
      style={{
        flex: segment.weight,
        flexDirection: "row",
        backgroundColor: colors.surface2,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          width: `${Math.round(segment.fraction * 100)}%`,
          backgroundColor: fill,
          opacity: segment.status === "done" ? 1 : 0.75,
          overflow: "hidden",
        }}
      >
        {working && live ? <Shimmer colors={colors} /> : null}
      </View>
      {blocked && segment.fraction === 0 ? (
        <View style={{ flex: 1, backgroundColor: fill, opacity: 0.35 }} />
      ) : null}
    </View>
  );
}

/** A soft pulse on the working segment; stops when stale so a stalled run never looks live. */
function Shimmer({ colors }: { colors: Colors }) {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, {
          toValue: 1,
          duration: 900,
          useNativeDriver: nativeDriver(),
        }),
        Animated.timing(value, {
          toValue: 0,
          duration: 900,
          useNativeDriver: nativeDriver(),
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [value]);
  return (
    <Animated.View
      style={{
        flex: 1,
        backgroundColor: colors.accentForeground,
        opacity: value.interpolate({
          inputRange: [0, 1],
          outputRange: [0, 0.35],
        }),
      }}
    />
  );
}

const STUCK_ICON: Record<StuckItem["kind"], string> = {
  blocked: "Ban",
  overdue: "Hourglass",
  manual: "Flag",
};

function StuckCard({
  colors,
  items,
  escalated,
  now,
  onOpenQuestion,
}: {
  colors: Colors;
  items: StuckItem[];
  /** Blocker key (ticket id or S1) to how often the conductor was told. */
  escalated: Record<string, number>;
  now: number;
  onOpenQuestion(id: string): void;
}) {
  const narrow = useNarrow();
  const onYou = items.filter(
    (item) => item.kind !== "overdue" && item.waitingOn,
  ).length;
  return (
    <View
      style={{
        margin: 12,
        marginBottom: 0,
        borderWidth: 1,
        borderColor: colors.statusDanger,
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <SectionTitle
        colors={colors}
        icon="OctagonAlert"
        title={`Stuck · ${items.length}`}
        color={colors.statusDanger}
        style={{ borderBottomWidth: 1, borderBottomColor: colors.border }}
      >
        {onYou ? (
          <Text
            style={[
              text(colors).small,
              { flex: 1, textAlign: "right", color: colors.accent },
            ]}
          >
            {onYou} waiting on you
          </Text>
        ) : null}
      </SectionTitle>
      {items.map((item, index) => {
        const waitingOn = item.kind === "overdue" ? undefined : item.waitingOn;
        const told =
          item.kind === "blocked"
            ? escalated[item.ticketId]
            : item.kind === "manual"
              ? escalated[item.id]
              : undefined;
        return (
          <View
            key={item.key}
            style={{
              flexDirection: "row",
              gap: 10,
              paddingHorizontal: 12,
              paddingVertical: 10,
              borderTopWidth: index ? 1 : 0,
              borderTopColor: colors.border,
            }}
          >
            <View style={{ paddingTop: 3 }}>
              <Icon
                name={STUCK_ICON[item.kind]}
                size={16}
                color={colors.statusDanger}
              />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text style={text(colors).body}>{item.title}</Text>
              <Text style={text(colors).muted}>
                {item.kind === "overdue"
                  ? `No update for longer than its ${unbroken(formatMinutes(item.estimate))} estimate. Last update `
                  : null}
                {item.kind === "blocked"
                  ? `Blocked${item.note ? `: ${item.note}` : ""}${narrow ? ", " : ". Since "}`
                  : null}
                {item.kind === "manual"
                  ? `${item.ticketId ? `${item.reason}. ` : ""}Flagged `
                  : null}
                <When colors={colors} iso={item.since} now={now} />
              </Text>
              {waitingOn ? (
                <Chip
                  colors={colors}
                  colorKey={null}
                  icon="MessageCircleQuestion"
                  label={`Waiting on you: answer ${waitingOn}`}
                  onPress={() => onOpenQuestion(waitingOn)}
                />
              ) : told ? (
                <Text style={text(colors).small}>
                  Conductor told {told === 1 ? "once" : `${told} times`}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function QuestionsCard({
  colors,
  questions,
  onOpen,
}: {
  colors: Colors;
  questions: Question[];
  onOpen(id: string): void;
}) {
  return (
    <View
      style={{
        margin: 12,
        marginBottom: 0,
        borderWidth: 1,
        borderColor: colors.accent,
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        <Icon name="MessageCircleQuestion" size={16} color={colors.accent} />
        <Text
          accessibilityRole="header"
          style={{
            color: colors.foreground,
            fontSize: FONT.section,
            lineHeight: LINE.section,
            fontWeight: "600",
          }}
        >
          Questions
        </Text>
        <View
          style={{
            backgroundColor: colors.accent,
            borderRadius: 999,
            paddingHorizontal: 10,
            paddingVertical: 2,
          }}
        >
          <Text
            style={{
              color: colors.accentForeground,
              fontSize: FONT.small,
              lineHeight: LINE.small,
            }}
          >
            {questions.length} waiting
          </Text>
        </View>
      </View>
      {questions.map((question, index) => (
        <View
          key={question.id}
          style={{
            flexDirection: "row",
            gap: 10,
            paddingHorizontal: 12,
            paddingVertical: 12,
            borderTopWidth: index ? 1 : 0,
            borderTopColor: colors.border,
          }}
        >
          <View
            style={{
              alignSelf: "flex-start",
              minWidth: 38,
              alignItems: "center",
              paddingHorizontal: 8,
              borderRadius: 999,
              backgroundColor: colors.surface1,
              ...raised(colors),
            }}
          >
            <Text style={[text(colors).body, { fontWeight: "600" }]}>
              {question.id}
            </Text>
          </View>
          <PressableRow
            colors={colors}
            accessibilityRole="button"
            accessibilityLabel={`${question.id} choices`}
            onPress={() => onOpen(question.id)}
            style={{
              flex: 1,
              minWidth: 0,
              flexDirection: "row",
              alignItems: "flex-start",
              gap: 8,
              borderRadius: 6,
              margin: -4,
              padding: 4,
            }}
          >
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text style={[text(colors).body, { fontWeight: "500" }]}>
                {question.title}
              </Text>
              <Text style={text(colors).muted}>
                <MentionSpans colors={colors} text={question.text} />
              </Text>
            </View>
            <View style={{ paddingTop: 3 }}>
              <Icon
                name="ChevronRight"
                size={16}
                color={colors.foregroundMuted}
              />
            </View>
          </PressableRow>
        </View>
      ))}
    </View>
  );
}

// Whether finished tickets are shown, per conductor, for the app session.
const finishedShown = new Map<string, boolean>();

/** Open tickets first, the first page of them, then "Show N more"; finished ones fold into a row. */
function TicketList({
  colors,
  conductorId,
  dashboard,
  tickets,
  resetKey,
  live,
  now,
  onOpen,
}: {
  colors: Colors;
  conductorId: string;
  dashboard: Dashboard;
  /** Already searched and sorted. */
  tickets: DashboardTicket[];
  /** Changes when the search or sort does, to start again from the first page. */
  resetKey: string;
  live: boolean;
  now: number;
  onOpen(id: string): void;
}) {
  const [shown, setShown] = useState(
    () => finishedShown.get(conductorId) ?? false,
  );
  const [limit, setLimit] = useState({ key: resetKey, count: TICKET_PAGE });
  const count = limit.key === resetKey ? limit.count : TICKET_PAGE;
  const toggle = () => {
    finishedShown.set(conductorId, !shown);
    setShown(!shown);
  };
  // Sub-tasks nest under their parent when both are listed; the page counts top-level rows.
  const listed = new Set(tickets.map((ticket) => ticket.id));
  const nested = (ticket: DashboardTicket) =>
    Boolean(ticket.parent && listed.has(ticket.parent));
  const childrenOf = (id: string) =>
    tickets.filter((ticket) => ticket.parent === id);
  const [openParents, setOpenParents] = useState<Record<string, boolean>>({});
  const isOpen = (ticket: DashboardTicket) =>
    openParents[ticket.id] ??
    childrenOf(ticket.id).some(
      (child) => child.status === "working" || child.status === "blocked",
    );
  const page = ticketPage(
    tickets.filter((ticket) => !nested(ticket)),
    count,
  );
  const row = (ticket: DashboardTicket, depth = 0): ReactNode => {
    const children = childrenOf(ticket.id);
    const open = children.length ? isOpen(ticket) : undefined;
    return (
      <Fragment key={ticket.id}>
        <TicketRow
          colors={colors}
          conductorId={conductorId}
          ticket={ticket}
          line={ticketLine(ticket, dashboard)}
          fraction={ticketFraction(ticket, now, dashboard.tickets)}
          depth={depth}
          subtasksOpen={open}
          onToggleSubtasks={() =>
            setOpenParents({ ...openParents, [ticket.id]: !open })
          }
          live={live}
          now={now}
          onOpen={() => onOpen(ticket.id)}
        />
        {open ? children.map((child) => row(child, depth + 1)) : null}
      </Fragment>
    );
  };
  return (
    <>
      {page.shown.map((ticket) => row(ticket))}
      <ShowMoreRow
        colors={colors}
        total={page.shown.length + page.more}
        page={TICKET_PAGE}
        noun="more"
        paged={{
          older: page.more,
          showOlder: () =>
            setLimit({ key: resetKey, count: count + TICKET_PAGE }),
          showFewer: () => setLimit({ key: resetKey, count: TICKET_PAGE }),
        }}
      />
      {page.finished.length ? (
        <>
          <FinishedRow
            colors={colors}
            tickets={page.finished}
            shown={shown}
            onPress={toggle}
          />
          {shown ? page.finished.map((ticket) => row(ticket)) : null}
        </>
      ) : null}
    </>
  );
}

const SORT_ICON = "ArrowUpDown";

function SortPicker({
  colors,
  sort,
  onChange,
}: {
  colors: Colors;
  sort: TicketSort;
  onChange(sort: TicketSort): void;
}) {
  const [open, setOpen] = useState(false);
  const label = TICKET_SORTS.find((option) => option.id === sort)?.label;
  return (
    <>
      <Chip
        colors={colors}
        colorKey={null}
        icon={SORT_ICON}
        label={label ?? "Sort"}
        onPress={() => setOpen(true)}
        accessibilityLabel={`Sort tickets, now by ${label}`}
      />
      <Modal
        title="Sort tickets"
        icon={
          <Icon name={SORT_ICON} size={18} color={colors.foregroundMuted} />
        }
        open={open}
        onOpenChange={setOpen}
      >
        <Modal.Content>
          <Text style={text(colors).muted}>
            Working and blocked tickets stay on top; this orders them and the
            rest.
          </Text>
          <View>
            {TICKET_SORTS.map((option) => (
              <PressableRow
                key={option.id}
                colors={colors}
                accessibilityRole="radio"
                accessibilityState={{ checked: option.id === sort }}
                onPress={() => {
                  onChange(option.id);
                  setOpen(false);
                }}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  paddingHorizontal: 8,
                  paddingVertical: 10,
                  borderRadius: 6,
                }}
              >
                <Icon
                  name={option.id === sort ? "CircleDot" : "Circle"}
                  size={16}
                  color={
                    option.id === sort ? colors.accent : colors.foregroundMuted
                  }
                />
                <Text style={text(colors).body}>{option.label}</Text>
              </PressableRow>
            ))}
          </View>
        </Modal.Content>
      </Modal>
    </>
  );
}

function FinishedRow({
  colors,
  tickets,
  shown,
  onPress,
}: {
  colors: Colors;
  tickets: DashboardTicket[];
  shown: boolean;
  onPress(): void;
}) {
  const narrow = useNarrow();
  const done = tickets.filter((ticket) => ticket.status === "done").length;
  const skipped = tickets.length - done;
  const label = [
    done ? `${done} done` : "",
    skipped ? `${skipped} skipped` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const minutes = tickets.reduce(
    (sum, ticket) =>
      sum + (ticket.status === "done" ? (ticket.estimate ?? 0) : 0),
    0,
  );
  const chevron = shown ? "ChevronUp" : "ChevronDown";
  return (
    <PressableRow
      colors={colors}
      accessibilityRole="button"
      accessibilityState={{ expanded: shown }}
      accessibilityLabel={`${shown ? "Hide" : "Show"} ${label}`}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderTopWidth: 1,
        borderTopColor: colors.border,
      }}
    >
      <View style={{ width: 18, paddingTop: 3, alignItems: "center" }}>
        <Icon
          name={done ? "Check" : "CircleSlash"}
          size={16}
          color={done ? colors.statusSuccess : colors.foregroundMuted}
        />
      </View>
      <Text
        style={[
          text(colors).muted,
          { flex: 1, minWidth: 0, fontWeight: "600" },
        ]}
      >
        {label}
      </Text>
      {narrow ? null : (
        <Text
          style={[
            text(colors).muted,
            { minWidth: 52, textAlign: "right", fontVariant: ["tabular-nums"] },
          ]}
        >
          {minutes ? formatMinutes(minutes) : ""}
        </Text>
      )}
      <View style={{ paddingTop: 3 }}>
        <IconSwap swapKey={chevron} size={16}>
          <Icon name={chevron} size={16} color={colors.foregroundMuted} />
        </IconSwap>
      </View>
    </PressableRow>
  );
}

function TicketRow({
  colors,
  conductorId,
  ticket,
  line,
  fraction,
  depth = 0,
  subtasksOpen,
  onToggleSubtasks,
  live,
  now,
  onOpen,
}: {
  colors: Colors;
  conductorId: string;
  ticket: DashboardTicket;
  /** What it is doing now: its agent's ticker or its last note. */
  line?: string;
  /** How far along, sub-tasks rolled up. */
  fraction: number;
  /** Sub-tasks sit indented under their parent. */
  depth?: number;
  /** Whether its sub-tasks show under it; undefined when it has none listed. */
  subtasksOpen?: boolean;
  onToggleSubtasks?(): void;
  live: boolean;
  now: number;
  onOpen(): void;
}) {
  const narrow = useNarrow();
  const [allChips, setAllChips] = useState(false);
  const muted = ticket.status === "skipped";
  const working = ticket.status === "working";
  const open = working || ticket.status === "blocked";
  const time = formatTicketTimeShort(
    workedMs(ticket, now) / 60_000,
    ticket.estimate,
    isSettled(ticket),
  );
  const status = [working ? ticket.stage : undefined, line]
    .filter(Boolean)
    .join(" · ");
  const chips = rowChips(ticket);
  const chip = (item: RowChip) =>
    item.type === "label" ? (
      <Chip
        key={`label:${item.label}`}
        colors={colors}
        icon="Tag"
        label={item.label}
        maxWidth={120}
      />
    ) : (
      <AgentChip
        key={`agent:${item.agentId}`}
        colors={colors}
        agentId={item.agentId}
        conductorId={conductorId}
        compact
      />
    );
  return (
    <PressableRow
      colors={colors}
      onSurface1={working}
      transparentAtRest={!working}
      accessibilityRole="button"
      accessibilityLabel={`${ticket.id} details`}
      onPress={onOpen}
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: narrow ? 8 : 12,
        paddingLeft: 12 + depth * 22,
        paddingRight: 12,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: colors.border,
      }}
    >
      <View
        accessible
        accessibilityLabel={
          ticket.waitingFor ? "Waiting" : STATUS_LABEL[ticket.status]
        }
        style={{ width: 18, paddingTop: 3, alignItems: "center" }}
      >
        <IconSwap
          swapKey={
            ticket.waitingFor || ticket.status === "not_started"
              ? "waiting"
              : working
                ? `working-${live}`
                : ticket.status
          }
          size={16}
        >
          <StatusIcon
            colors={colors}
            status={ticket.status}
            live={live}
            waiting={Boolean(ticket.waitingFor)}
          />
        </IconSwap>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text
          numberOfLines={1}
          style={[
            text(colors).body,
            muted
              ? {
                  color: colors.foregroundMuted,
                  textDecorationLine: "line-through",
                }
              : null,
          ]}
        >
          {ticket.title}
        </Text>
        {status ? (
          <Text numberOfLines={1} style={text(colors).muted}>
            <MentionSpans colors={colors} text={status} />
          </Text>
        ) : null}
        {open ? (
          <PercentBar
            colors={colors}
            fraction={fraction}
            reported={ticket.percent !== undefined || Boolean(ticket.subtasks)}
            compact
            caption={time.text}
            captionInline={!narrow}
            captionWarn={time.over}
          />
        ) : null}
        {chips.shown.length || ticket.subtasks || ticket.waitingFor ? (
          <View
            style={{
              flexDirection: "row",
              flexWrap: allChips ? "wrap" : "nowrap",
              overflow: "hidden",
              gap: 6,
            }}
          >
            {ticket.subtasks ? (
              <Chip
                colors={colors}
                colorKey={null}
                icon={
                  subtasksOpen === undefined
                    ? "ListTree"
                    : subtasksOpen
                      ? "ChevronUp"
                      : "ChevronDown"
                }
                label={`${ticket.subtasks.done}/${ticket.subtasks.total} sub-tasks`}
                onPress={onToggleSubtasks}
                accessibilityLabel={`${subtasksOpen ? "Hide" : "Show"} sub-tasks`}
              />
            ) : null}
            {ticket.waitingFor ? (
              <Chip
                colors={colors}
                colorKey={null}
                icon="Hourglass"
                label={ticket.waitingFor.map((other) => other.id).join(", ")}
                accessibilityLabel={`Waits for ${ticket.waitingFor.map((other) => other.id).join(", ")}`}
              />
            ) : null}
            {chips.shown.map(chip)}
            {allChips ? chips.hidden.map(chip) : null}
            {chips.hidden.length ? (
              <Chip
                colors={colors}
                colorKey={null}
                label={allChips ? "Show fewer" : `+${chips.hidden.length} more`}
                onPress={() => setAllChips(!allChips)}
              />
            ) : null}
          </View>
        ) : null}
      </View>
      <View
        accessibilityLabel={
          ticket.deliverables
            ? ticket.deliverables === 1
              ? "Has a deliverable"
              : `Has ${ticket.deliverables} deliverables`
            : undefined
        }
        style={{ width: 14, height: LINE.body, justifyContent: "center" }}
      >
        {ticket.deliverables ? (
          <Icon name="Package" size={14} color={colors.foregroundMuted} />
        ) : null}
      </View>
      {narrow ? null : (
        <View style={{ paddingTop: 3 }}>
          <Icon name="ChevronRight" size={16} color={colors.foregroundMuted} />
        </View>
      )}
    </PressableRow>
  );
}

type HistoryTab = "activity" | "answered" | "deliverables";
// The tab chosen per conductor, kept for the app session.
const historyTabs = new Map<string, HistoryTab>();

function HistoryCard({
  colors,
  conductorId,
  search,
  tabs,
}: {
  colors: Colors;
  conductorId: string;
  /** One search for all three tabs, under the tab strip. */
  search?: ReactNode;
  tabs: {
    id: HistoryTab;
    label: string;
    icon: string;
    count: number;
    empty: string;
    content: ReactNode;
  }[];
}) {
  const [tab, setTab] = useState<HistoryTab>(
    () => historyTabs.get(conductorId) ?? "activity",
  );
  const choose = (next: HistoryTab) => {
    historyTabs.set(conductorId, next);
    setTab(next);
  };
  const current = tabs.find((entry) => entry.id === tab) ?? tabs[0];
  if (!current) return null;
  return (
    <View
      style={{
        margin: 12,
        marginBottom: 0,
        ...raised(colors),
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <TabStrip
        colors={colors}
        tabs={tabs}
        selected={current.id}
        onSelect={choose}
        style={{ paddingHorizontal: 12 }}
      />
      {search}
      {current.count === 0 ? (
        <Text
          style={[
            text(colors).muted,
            { paddingHorizontal: 12, paddingVertical: 10 },
          ]}
        >
          {current.empty}
        </Text>
      ) : (
        current.content
      )}
    </View>
  );
}

function ActivityList({
  colors,
  conductorId,
  activity,
  now,
  onOpen,
}: {
  colors: Colors;
  conductorId: string;
  activity: Dashboard["activity"];
  now: number;
  onOpen(item: ActivityItem): void;
}) {
  const paged = usePaged(activity);
  return (
    <View>
      {withDays(paged.shown, (entry) => entry.ts, now).map(
        ({ item: entry, day }, index) => (
          <View key={`${entry.ts}-${index}`}>
            {day ? (
              <DayHeader colors={colors} label={day} first={index === 0} />
            ) : null}
            <ActivityRow
              colors={colors}
              item={entry}
              now={now}
              conductorId={conductorId}
              first={Boolean(day)}
              onPress={() => onOpen(entry)}
            />
          </View>
        ),
      )}
      <ShowMoreRow colors={colors} total={activity.length} paged={paged} />
    </View>
  );
}

function AnsweredList({
  colors,
  conductorId,
  questions,
  now,
  onOpen,
}: {
  colors: Colors;
  conductorId: string;
  questions: Question[];
  now: number;
  onOpen(id: string): void;
}) {
  const paged = usePaged(questions);
  return (
    <View>
      {withDays(
        paged.shown,
        (question) => question.answer?.ts ?? question.askedAt,
        now,
      ).map(({ item: question, day }, index) => {
        const keys = choiceKeys(question.answer?.choice);
        const chosen = question.options.filter((option) =>
          keys.includes(option.key),
        );
        const byUser = !question.answer?.by || question.answer.by === "user";
        return (
          <View key={question.id}>
            {day ? (
              <DayHeader colors={colors} label={day} first={index === 0} />
            ) : null}
            <PressableRow
              colors={colors}
              accessibilityRole="button"
              accessibilityLabel={`${question.id} details`}
              onPress={() => onOpen(question.id)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingHorizontal: 12,
                paddingVertical: 10,
                borderTopWidth: day ? 0 : 1,
                borderTopColor: colors.border,
              }}
            >
              <Text
                numberOfLines={1}
                style={[
                  text(colors).muted,
                  { fontWeight: "600", minWidth: 32, flexShrink: 0 },
                ]}
              >
                {question.id}
              </Text>
              <Text
                numberOfLines={1}
                style={[text(colors).muted, { flex: 1, minWidth: 0 }]}
              >
                {question.title}
                {"  "}
                <Text
                  style={{ color: colors.statusSuccess, fontWeight: "600" }}
                >
                  {keys.length ? keys.join(", ") : "Own answer"}
                </Text>
                {chosen.length ? (
                  <Text style={{ color: colors.foreground }}>
                    {" "}
                    {chosen.map((option) => option.label).join(", ")}
                  </Text>
                ) : null}
                {question.answer?.words ? (
                  <Text style={{ color: colors.foreground }}>
                    {" "}
                    “{question.answer.words}”
                  </Text>
                ) : null}
              </Text>
              {/* Who answered, so a decision the conductor made for you stands out. */}
              <Text
                numberOfLines={1}
                style={[
                  text(colors).small,
                  {
                    flexShrink: 0,
                    paddingHorizontal: 6,
                    borderRadius: 5,
                    overflow: "hidden",
                    color: byUser ? colors.foregroundMuted : colors.accent,
                    backgroundColor: colors.surface2,
                  },
                ]}
              >
                {byUser
                  ? "You"
                  : question.answer?.by === conductorId
                    ? "Conductor"
                    : "Agent"}
              </Text>
              <Icon
                name="ChevronRight"
                size={16}
                color={colors.foregroundMuted}
              />
            </PressableRow>
          </View>
        );
      })}
      <ShowMoreRow colors={colors} total={questions.length} paged={paged} />
    </View>
  );
}

function DeliverablesList({
  colors,
  conductorId,
  deliverables,
  now,
  workspaceId,
  navigation,
}: {
  colors: Colors;
  conductorId: string;
  deliverables: Dashboard["deliverables"];
  now: number;
  workspaceId?: string;
  navigation?: Navigation;
}) {
  const [previewing, setPreviewing] = useState<Attachment | null>(null);
  const opener = useAttachmentOpener({
    conductorId,
    workspaceId,
    navigation,
    onPreview: setPreviewing,
  });
  const attachments = deliverableAttachments(deliverables);
  const paged = usePaged(deliverables);
  return (
    <View>
      {withDays(paged.shown, (deliverable) => deliverable.ts, now).map(
        ({ item: deliverable, day }, index) => {
          const attachment = {
            target: deliverable.target,
            title: deliverable.label,
          };
          const local = !/^https?:\/\//i.test(deliverable.target);
          return (
            <View key={deliverable.id}>
              {day ? (
                <DayHeader colors={colors} label={day} first={index === 0} />
              ) : null}
              <PressableRow
                colors={colors}
                accessibilityRole={local ? "button" : "link"}
                accessibilityLabel={`Open ${deliverable.label}`}
                onPress={() => void opener.open(attachment)}
                style={{
                  flexDirection: "row",
                  gap: 10,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  borderTopWidth: day ? 0 : 1,
                  borderTopColor: colors.border,
                }}
              >
                <View style={{ paddingTop: 3 }}>
                  <Icon
                    name={attachmentIcon(attachment)}
                    size={16}
                    color={colors.foregroundMuted}
                  />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text numberOfLines={3} style={text(colors).body}>
                    {deliverable.label}
                  </Text>
                  <Text numberOfLines={1} style={text(colors).muted}>
                    {[
                      shortName(attachment),
                      deliverable.ticket,
                      formatAgo(deliverable.ts, now),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
                {local ? (
                  <PressScale
                    accessibilityRole="button"
                    accessibilityLabel={`Copy the path of ${deliverable.label}`}
                    hitSlop={6}
                    onPress={() => void opener.copyPath(attachment)}
                    style={({ pressed, hovered }) => ({
                      padding: 5,
                      borderRadius: 6,
                      backgroundColor: pressed
                        ? colors.border
                        : hovered
                          ? colors.surface2
                          : "transparent",
                    })}
                  >
                    <Icon
                      name="Copy"
                      size={16}
                      color={colors.foregroundMuted}
                    />
                  </PressScale>
                ) : (
                  <View style={{ paddingTop: 3 }}>
                    <Icon
                      name="ExternalLink"
                      size={16}
                      color={colors.foregroundMuted}
                    />
                  </View>
                )}
              </PressableRow>
            </View>
          );
        },
      )}
      <ShowMoreRow colors={colors} total={deliverables.length} paged={paged} />
      <PreviewDialog
        colors={colors}
        conductorId={conductorId}
        attachment={previewing}
        onClose={() => setPreviewing(null)}
        onOpenOnHost={(attachment) => void opener.openOutside(attachment)}
        gallery={{
          items: attachments.filter(canPreview),
          onSelect: setPreviewing,
        }}
      />
    </View>
  );
}

/** Run history: off by default; when on, each run is mirrored into a folder of the workspace. */
function HistoryRow({
  colors,
  conductorId,
}: {
  colors: Colors;
  conductorId: string;
}) {
  const history = useRpc(runHistoryRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const key = ["conductor", "history", conductorId];
  const current = useQuery({
    queryKey: key,
    queryFn: () => history({ conductorId }),
  });
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState("");
  const save = useMutation({
    mutationFn: (folder: string | null) => history({ conductorId, folder }),
    onSuccess: (result) => {
      queryClient.setQueryData(key, result);
      setPicking(false);
      toast.show(
        result.folder
          ? `Each run will be saved to ${result.folder}/history.`
          : "Runs stay with the conductor. Files already saved stay in the repo.",
        { variant: "success" },
      );
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const folder = current.data?.folder ?? null;
  const actions = folder
    ? [
        { label: "Change…", onPress: () => setPicking(true) },
        { label: "Stop saving", onPress: () => save.mutate(null) },
      ]
    : [{ label: "Save to repo…", onPress: () => setPicking(true) }];
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        columnGap: 8,
        rowGap: 6,
        marginHorizontal: 14,
        marginTop: 18,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 8,
          flex: 1,
          minWidth: 180,
        }}
      >
        <View style={{ paddingTop: 3 }}>
          <Icon name="History" size={14} color={colors.foregroundMuted} />
        </View>
        <Text style={[text(colors).muted, { flex: 1 }]}>
          {folder ? (
            <>
              Each run is saved to{" "}
              <Text style={{ color: colors.foreground }}>{folder}/history</Text>{" "}
              in this workspace.
            </>
          ) : (
            "Run history stays with the conductor."
          )}
        </Text>
      </View>
      <FooterActions colors={colors} actions={actions} busy={save.isPending} />
      <Modal
        title="Save run history to a folder"
        icon={
          <Icon name="FolderOpen" size={18} color={colors.foregroundMuted} />
        }
        open={picking}
        onOpenChange={(next) => {
          if (!next) setPicking(false);
        }}
      >
        <Modal.Content>
          <Text style={text(colors).muted}>
            Each run becomes its own file in a history folder inside this folder
            of the conductor's workspace. Commit them like any other file.
          </Text>
          <TextInput
            accessibilityLabel="Folder in the workspace"
            defaultValue={folder ?? ""}
            onChangeText={setDraft}
            placeholder="docs/progress"
            placeholderTextColor={colors.foregroundMuted}
            autoFocus
            style={{
              color: colors.foreground,
              fontSize: FONT.body,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 8,
            }}
          />
          <View
            style={{
              flexDirection: "row",
              justifyContent: "flex-end",
              gap: 10,
            }}
          >
            <DialogButton
              colors={colors}
              icon="X"
              label="Cancel"
              onPress={() => setPicking(false)}
            />
            <DialogButton
              colors={colors}
              icon="Check"
              label={save.isPending ? "Saving…" : "Save"}
              onPress={() => {
                const next = (draft || folder || "").trim();
                if (next) save.mutate(next);
              }}
            />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

function FooterActions({
  colors,
  actions,
  busy,
}: {
  colors: Colors;
  actions: { label: string; onPress(): void }[];
  busy: boolean;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 4 }}>
      {actions.map((action) => (
        <PressScale
          key={action.label}
          accessibilityRole="button"
          disabled={busy}
          onPress={action.onPress}
          style={({ pressed, hovered }) => ({
            paddingHorizontal: 10,
            paddingVertical: 5,
            borderRadius: 6,
            opacity: busy ? 0.7 : 1,
            backgroundColor: pressed
              ? colors.border
              : hovered
                ? colors.surface2
                : "transparent",
          })}
        >
          <Text
            style={[
              text(colors).muted,
              { color: colors.foreground, fontWeight: "600" },
            ]}
          >
            {action.label}
          </Text>
        </PressScale>
      ))}
    </View>
  );
}

function TicketPrefixRow({
  colors,
  conductorId,
}: {
  colors: Colors;
  conductorId: string;
}) {
  const setPrefix = useRpc(setTicketPrefixRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const prefix = useProgressQuery(conductorId, selectPrefix).data;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const parsed = ticketPrefixSchema.safeParse(draft || prefix || "");
  const save = useMutation({
    mutationFn: (ticketPrefix: string) =>
      setPrefix({ conductorId, ticketPrefix }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: ["conductor", "progress", conductorId],
      });
      setEditing(false);
      toast.show(
        `Tickets now read ${displayTicketId("T01", result.ticketPrefix)}. The conductor was told.`,
        { variant: "success" },
      );
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  if (!prefix) return null;
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        columnGap: 8,
        rowGap: 6,
        marginHorizontal: 14,
        marginTop: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 8,
          flex: 1,
          minWidth: 180,
        }}
      >
        <View style={{ paddingTop: 3 }}>
          <Icon name="Hash" size={14} color={colors.foregroundMuted} />
        </View>
        <Text style={[text(colors).muted, { flex: 1 }]}>
          Ticket ids read{" "}
          <Text style={{ color: colors.foreground }}>
            {displayTicketId("T01", prefix)}
          </Text>
          .
        </Text>
      </View>
      <FooterActions
        colors={colors}
        actions={[
          {
            label: "Change prefix…",
            onPress: () => {
              setDraft("");
              setEditing(true);
            },
          },
        ]}
        busy={save.isPending}
      />
      <Modal
        title="Ticket prefix"
        icon={<Icon name="Hash" size={18} color={colors.foregroundMuted} />}
        open={editing}
        onOpenChange={(next) => {
          if (!next) setEditing(false);
        }}
      >
        <Modal.Content>
          <Text style={text(colors).muted}>
            1-3 letters or digits. Tickets show as{" "}
            {parsed.success
              ? displayTicketId("T01", parsed.data)
              : displayTicketId("T01", prefix)}
            ; agents can still write bare numbers.
          </Text>
          <TextInput
            accessibilityLabel="Ticket prefix"
            defaultValue={prefix}
            onChangeText={setDraft}
            placeholder="T"
            placeholderTextColor={colors.foregroundMuted}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={3}
            autoFocus
            style={{
              color: colors.foreground,
              fontSize: FONT.body,
              borderWidth: 1,
              borderColor: parsed.success ? colors.border : colors.statusDanger,
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 8,
            }}
          />
          {parsed.success ? null : (
            <Text style={[text(colors).small, { color: colors.statusDanger }]}>
              {parsed.error.issues[0]?.message}
            </Text>
          )}
          <View
            style={{
              flexDirection: "row",
              justifyContent: "flex-end",
              gap: 10,
            }}
          >
            <DialogButton
              colors={colors}
              icon="X"
              label="Cancel"
              onPress={() => setEditing(false)}
            />
            <DialogButton
              colors={colors}
              icon="Check"
              label={save.isPending ? "Saving…" : "Save"}
              onPress={() => {
                if (parsed.success) save.mutate(parsed.data);
              }}
            />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
