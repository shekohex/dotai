/**
 * What the progress UI shows, derived from a conductor's run at a moment in time.
 * Ported from the Progress plugin by Steve Castaneda (MIT,
 * https://github.com/stevecastaneda/paseo-plugins/tree/main/progress) and adapted to
 * this plugin's state.
 */
import { waitingOn } from "./links.js";
import {
  type ActivityItem,
  type Deliverable,
  overallProgress,
  type ProgressState,
  type Question,
  STALE_AFTER_MS,
  type Ticket,
  ticketFraction,
  type TicketStatus,
} from "./progress.js";

export interface HeadlinePart {
  text: string;
  tone: "normal" | "danger";
}

export type StuckItem =
  | {
      kind: "blocked";
      key: string;
      ticketId: string;
      title: string;
      since: string;
      note?: string;
      /** An open question on the ticket: it waits on the user, so the conductor isn't told. */
      waitingOn?: string;
    }
  /** A working ticket with no update for longer than its estimate. `since` is its last update. */
  | {
      kind: "overdue";
      key: string;
      ticketId: string;
      title: string;
      since: string;
      estimate: number;
    }
  | {
      kind: "manual";
      key: string;
      id: string;
      ticketId?: string;
      title: string;
      reason: string;
      since: string;
      waitingOn?: string;
    };

export interface ProgressSegment {
  id: string;
  /** Flex weight: the estimate in minutes, or 1 when the ticket has none. */
  weight: number;
  status: TicketStatus;
  waiting: boolean;
  /** How much of the segment is filled, 0-1. */
  fraction: number;
}

export interface DashboardTicket extends Ticket {
  /** Tickets this one waits for that are still open; none once it is ready. */
  waitingFor?: { id: string; title: string }[];
  /** Sub-tasks: how many, and how many are finished. */
  subtasks?: { done: number; total: number };
  deliverables: number;
}

export interface Dashboard {
  state: ProgressState;
  finished: boolean;
  stale: boolean;
  headline: HeadlinePart[];
  stuck: StuckItem[];
  /** Open questions in ask order; answered ones, most recently answered first. */
  questions: { open: Question[]; answered: Question[] };
  /** Newest first. */
  deliverables: Deliverable[];
  /** Newest first. */
  activity: ProgressState["activity"];
  progress: {
    percent: number;
    doneMin: number;
    totalMin: number;
    /** Once every counted ticket is done: minutes from the run's start to the last one settling. */
    tookMin?: number;
    segments: ProgressSegment[];
  };
  tickets: DashboardTicket[];
}

export function isSettled(ticket: Pick<Ticket, "status">): boolean {
  return ticket.status === "done" || ticket.status === "skipped";
}

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function lastTicketUpdate(
  ticket: Ticket,
  activity: ProgressState["activity"],
): number {
  return Math.max(
    ...ticket.history.map((change) => Date.parse(change.ts)),
    ...activity
      .filter((entry) => entry.ticket === ticket.id)
      .map((entry) => Date.parse(entry.ts)),
  );
}

function stuckItems(
  state: ProgressState,
  tickets: DashboardTicket[],
  now: number,
): StuckItem[] {
  const items: StuckItem[] = [];
  const openQuestion = (ticketId: string | undefined) =>
    ticketId
      ? state.questions.find(
          (question) => question.ticket === ticketId && !question.answer,
        )?.id
      : undefined;
  const waiting = (ticketId: string | undefined) => {
    const id = openQuestion(ticketId);
    return id ? { waitingOn: id } : {};
  };
  for (const ticket of tickets) {
    // Blocked only on another ticket in the run is waiting, not stuck.
    if (ticket.status === "blocked" && !ticket.waitingFor) {
      items.push({
        kind: "blocked",
        key: `blocked:${ticket.id}`,
        ticketId: ticket.id,
        title: ticket.title,
        since: ticket.statusSince,
        ...(ticket.note ? { note: ticket.note } : {}),
        ...waiting(ticket.id),
      });
    } else if (ticket.status === "working" && ticket.estimate) {
      // Any sign of work resets the clock: a status, stage or note change, or tagged activity.
      const last = lastTicketUpdate(ticket, state.activity);
      if (now > last + ticket.estimate * 60_000) {
        items.push({
          kind: "overdue",
          key: `overdue:${ticket.id}`,
          ticketId: ticket.id,
          title: ticket.title,
          since: new Date(last).toISOString(),
          estimate: ticket.estimate,
        });
      }
    }
  }
  for (const flag of state.stuck) {
    if (flag.resolved) continue;
    const ticket = flag.ticket
      ? tickets.find((candidate) => candidate.id === flag.ticket)
      : undefined;
    items.push({
      kind: "manual",
      key: `manual:${flag.id}`,
      id: flag.id,
      ...(flag.ticket ? { ticketId: flag.ticket } : {}),
      title: ticket?.title ?? flag.text,
      reason: flag.text,
      since: flag.ts,
      ...waiting(flag.ticket),
    });
  }
  return items;
}

function progress(
  tickets: DashboardTicket[],
  startedAt: string,
  now: number,
): Dashboard["progress"] {
  const counted = tickets.filter((ticket) => ticket.status !== "skipped");
  // The bar has one segment per leaf ticket; parents show through their sub-tasks.
  const leaves = counted.filter((ticket) => !ticket.subtasks);
  const estimated = leaves.every((ticket) => ticket.estimate);
  const overall = overallProgress(tickets, now);
  const allDone =
    counted.length > 0 &&
    counted.every((ticket) => ticket.status === "done") &&
    tickets.every(isSettled);
  const endedAt = Math.max(
    ...tickets.map((ticket) => Date.parse(ticket.statusSince)),
  );
  return {
    ...overall,
    ...(allDone
      ? {
          tookMin: Math.max(0, (endedAt - Date.parse(startedAt)) / 60_000),
        }
      : {}),
    // Without estimates on every ticket, each counts the same.
    segments: leaves.map((ticket) => ({
      id: ticket.id,
      weight: estimated ? (ticket.estimate ?? 1) : 1,
      status: ticket.status,
      waiting: Boolean(ticket.waitingFor),
      fraction: ticketFraction(ticket, now, tickets),
    })),
  };
}

function headline(
  tickets: Ticket[],
  waiting: number,
  stuck: number,
): HeadlinePart[] {
  const counted = tickets.filter((ticket) => ticket.status !== "skipped");
  const done = counted.filter((ticket) => ticket.status === "done").length;
  const parts: HeadlinePart[] = [
    {
      text: `${done} of ${plural(counted.length, "ticket")} done`,
      tone: "normal",
    },
  ];
  if (waiting)
    parts.push({
      text: `${plural(waiting, "question")} waiting for you`,
      tone: "normal",
    });
  if (stuck) parts.push({ text: `${stuck} stuck`, tone: "danger" });
  return parts;
}

/** Folds the run into what the dashboard shows at `now`. */
export function buildDashboard(state: ProgressState, now: number): Dashboard {
  const byId = new Map(state.tickets.map((ticket) => [ticket.id, ticket]));
  const tickets: DashboardTicket[] = state.tickets.map((ticket) => {
    const waits = waitingOn(ticket, byId);
    const children = state.tickets.filter(
      (child) => child.parent === ticket.id,
    );
    return {
      ...ticket,
      ...(waits.length
        ? {
            waitingFor: waits.map((other) => ({
              id: other.id,
              title: other.title,
            })),
          }
        : {}),
      ...(children.length
        ? {
            subtasks: {
              done: children.filter(isSettled).length,
              total: children.length,
            },
          }
        : {}),
      deliverables: state.deliverables.filter(
        (deliverable) => deliverable.ticket === ticket.id,
      ).length,
    };
  });
  const stuck = stuckItems(state, tickets, now);
  const open = state.questions.filter((question) => !question.answer);
  const answered = state.questions
    .filter((question) => question.answer)
    .sort(
      (a, b) => Date.parse(b.answer?.ts ?? "") - Date.parse(a.answer?.ts ?? ""),
    );
  // A finished run has nothing left to stall, so it never goes stale.
  const finished =
    Boolean(state.finished) || (tickets.length > 0 && tickets.every(isSettled));
  return {
    state,
    finished,
    stale: !finished && now - Date.parse(state.updatedAt) > STALE_AFTER_MS,
    headline: headline(tickets, open.length, stuck.length),
    stuck,
    questions: { open, answered },
    deliverables: [...state.deliverables].reverse(),
    activity: [...state.activity].reverse(),
    progress: progress(tickets, state.startedAt, now),
    tickets,
  };
}

/**
 * What a ticket is doing now: the run's ticker when one of the ticket's agents set it (or it is
 * the only working ticket), else its last note.
 */
export function ticketLine(
  ticket: DashboardTicket,
  dashboard: Pick<Dashboard, "state" | "tickets">,
): string | undefined {
  const ticker = dashboard.state.ticker;
  const ours =
    ticker &&
    ticket.status === "working" &&
    (ticker.by
      ? ticker.by === ticket.by || ticket.agents.includes(ticker.by)
      : dashboard.tickets.filter((candidate) => candidate.status === "working")
          .length === 1);
  return ours ? ticker.text : ticket.note;
}

export type RowChip =
  { type: "label"; label: string } | { type: "agent"; agentId: string };

/** A ticket row's chips: labels, then agents still on it; the first `max` show, the rest count. */
export function rowChips(
  ticket: Pick<Ticket, "labels" | "agents" | "status">,
  max = 3,
): { shown: RowChip[]; hidden: RowChip[] } {
  const all: RowChip[] = [
    ...(ticket.labels ?? []).map((label) => ({
      type: "label" as const,
      label,
    })),
    ...(isSettled(ticket)
      ? []
      : ticket.agents.map((agentId) => ({ type: "agent" as const, agentId }))),
  ];
  return { shown: all.slice(0, max), hidden: all.slice(max) };
}

/**
 * Finished tickets fold into one row at the top so the work still ahead sits near the top.
 * A single one isn't worth a fold row; once every ticket is finished nothing folds.
 */
/** Something that happened inside a step: a feed entry, a revised estimate, or a new percent. */
export type TimelineEvent =
  | { type: "activity"; ts: string; item: ActivityItem }
  | { type: "estimate"; ts: string; from: number; to: number; by?: string }
  | { type: "percent"; ts: string; percent: number; by?: string };

export interface TimelineStep {
  ts: string;
  until: string | null;
  label: string;
  status: TicketStatus;
  stage?: string;
  by?: string;
  events: TimelineEvent[];
  /** Length of the step; null for a finished ticket's last step, which has no end. */
  minutes: number | null;
}

const OPEN_ENDED: TicketStatus[] = ["working", "blocked", "not_started"];

function stepLabel(
  status: TicketStatus,
  stage: string | undefined,
  first: boolean,
): string {
  if (first && status === "not_started") return "Added";
  switch (status) {
    case "working":
      return stage ? `${stage} stage` : "Working";
    case "blocked":
      return "Blocked";
    case "done":
      return "Done";
    case "skipped":
      return "Skipped";
    default:
      return "Back to not started";
  }
}

/**
 * One step per status change, or stage change while working, with its duration; the ticket's
 * feed entries and estimate or percent changes sit inside the step they happened in.
 */
export function ticketTimeline(
  ticket: Ticket,
  now: number,
  activity: readonly ActivityItem[] = [],
): TimelineStep[] {
  const steps: TimelineStep[] = [];
  let status: TicketStatus = "not_started";
  let stage: string | undefined;
  const events: TimelineEvent[] = [];
  ticket.history.forEach((change, index) => {
    const statusChanged =
      change.status !== undefined && change.status !== status;
    const stageChanged =
      change.stage !== undefined && (change.stage || undefined) !== stage;
    if (change.status !== undefined) status = change.status;
    if (change.stage !== undefined) stage = change.stage || undefined;
    if (
      index === 0 ||
      statusChanged ||
      (stageChanged && status === "working")
    ) {
      steps.push({
        ts: change.ts,
        until: null,
        label: stepLabel(status, stage, index === 0),
        status,
        ...(stage ? { stage } : {}),
        ...(change.by ? { by: change.by } : {}),
        events: [],
        minutes: null,
      });
    }
    if (change.estimate)
      events.push({
        type: "estimate",
        ts: change.ts,
        ...change.estimate,
        ...(change.by ? { by: change.by } : {}),
      });
    if (change.percent !== undefined)
      events.push({
        type: "percent",
        ts: change.ts,
        percent: change.percent,
        ...(change.by ? { by: change.by } : {}),
      });
  });
  for (const item of activity)
    if (item.ticket === ticket.id)
      events.push({ type: "activity", ts: item.ts, item });
  // Each event goes in the last step that started at or before it.
  events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  for (const event of events) {
    const at = Date.parse(event.ts);
    const step =
      steps.findLast((candidate) => Date.parse(candidate.ts) <= at) ?? steps[0];
    step?.events.push(event);
  }
  steps.forEach((step, index) => {
    const next = steps[index + 1];
    step.until = next?.ts ?? null;
    const end = next
      ? Date.parse(next.ts)
      : OPEN_ENDED.includes(step.status)
        ? now
        : null;
    step.minutes =
      end === null ? null : Math.max(0, (end - Date.parse(step.ts)) / 60_000);
  });
  return steps;
}

/** Minutes spent working on a ticket, summed over its working steps. */
export function workedMinutes(steps: TimelineStep[]): number {
  return steps
    .filter((step) => step.status === "working")
    .reduce((sum, step) => sum + (step.minutes ?? 0), 0);
}

/** Paseo cuts composer pills off at 160px, so with both counts the questions shorten to "2Q". */
export function pillLabel(questions: number, stuck: number): string {
  if (!questions && !stuck) return "Progress";
  const parts: string[] = [];
  if (questions)
    parts.push(
      stuck
        ? `${questions}Q`
        : `${questions} ${questions === 1 ? "question" : "questions"}`,
    );
  if (stuck) parts.push(`${stuck} stuck`);
  return parts.join(" · ");
}

/** What the Tickets card and the feed are narrowed to; every set field must match. */
