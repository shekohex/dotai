import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const TICKET_STATUSES = [
  "not_started",
  "working",
  "blocked",
  "done",
  "skipped",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const STALE_AFTER_MS = 15 * 60_000;

/** What a piece of activity was, like a conventional commit type; the feed shows an icon per kind. */
export const ACTIVITY_KINDS = [
  "feat",
  "fix",
  "refactor",
  "test",
  "build",
  "docs",
  "research",
  "review",
  "plan",
  "deploy",
  "chore",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** A working ticket without a reported percent never shows more than this from time alone. */
export const SOFT_PERCENT_CAP = 90;
/** Minutes assumed for time-based progress on a ticket with no estimate. */
export const DEFAULT_ESTIMATE_MIN = 60;

const optionSchema = z
  .object({
    key: z.string().min(1).max(4),
    label: z.string().min(1),
    detail: z.string().optional(),
  })
  .strict();

/** The MCP server key agents see, and its one tool: `mcp__conductor__progress` in Claude. */
export const PROGRESS_MCP_SERVER = "conductor";
export const PROGRESS_TOOL = "progress";

/** Whether a timeline tool name is our tool: Claude says mcp__conductor__progress, Codex conductor.progress. */
export function isProgressToolName(name: string): boolean {
  const server = PROGRESS_MCP_SERVER;
  return (
    name === `mcp__${server}__${PROGRESS_TOOL}` ||
    name === `${server}.${PROGRESS_TOOL}`
  );
}

/**
 * One flat tool input keeps the schema the agent pays for in every session small.
 * `op` selects which of the other fields apply; unused ones are ignored.
 */
export const progressInputSchema = z
  .object({
    op: z.enum([
      "start",
      "ticket",
      "ask",
      "answer",
      "deliver",
      "stuck",
      "unstuck",
      "ticker",
      "finish",
      "withdraw",
      "show",
      "help",
    ]),
    /** start/ask/ticket(new)/deliver: short title. finish: the outcome. */
    title: z.string().optional(),
    /** start: subtitle. ask: question text. stuck: what is wrong. ticker: the line. */
    text: z.string().optional(),
    /** Existing ticket (T01), question (Q1), or stuck flag (S1) the op refers to. */
    id: z.string().optional(),
    status: z.enum(TICKET_STATUSES).optional(),
    stage: z.string().optional(),
    /** Minutes of work expected in total; revise it as you learn. */
    estimate: z.number().int().positive().optional(),
    /** ticket: tickets that must finish first (replaces the set; [] clears). */
    waitsFor: z.array(z.string()).optional(),
    /** ticket: the ticket this one is a sub-task of; "" clears. */
    parent: z.string().optional(),
    /** ticket: tickets worth seeing together (replaces the set; [] clears). */
    related: z.array(z.string()).optional(),
    source: z.string().optional(),
    /** One short progress line (the activity title), shown in the feed and as the ticker. */
    note: z.string().optional(),
    /** ticket/ticker: longer details behind the line. */
    body: z.string().optional(),
    kind: z.enum(ACTIVITY_KINDS).optional(),
    /** ticket: replaces the ticket's labels; [] clears them. */
    labels: z.array(z.string()).optional(),
    /** ticket/ticker: how far along the ticket is, 0-100. */
    percent: z.number().int().min(0).max(100).optional(),
    /** ticket: an agent id now working it (defaults to the caller when status=working). */
    agent: z.string().optional(),
    /** Ticket an ask/deliver/stuck/note belongs to. */
    ticket: z.string().optional(),
    options: z.array(optionSchema).optional(),
    recommend: z.string().optional(),
    /** ask: let the user pick several options. */
    multi: z.boolean().optional(),
    /** answer: the chosen option key, or keys like "A,C" on a multi question. */
    choice: z.string().optional(),
    words: z.string().optional(),
    /** deliver: file path or URL. */
    target: z.string().optional(),
    /** ask: files or URLs the user should look at before answering. */
    files: z.array(z.string()).optional(),
  })
  .strict();

export type ProgressInput = z.infer<typeof progressInputSchema>;

/** A persisted line of progress.jsonl: the input plus resolved ids and attribution. */
export interface ProgressEvent extends Omit<ProgressInput, "op"> {
  v: 1;
  ts: string;
  by?: string;
  op: Exclude<ProgressInput["op"], "show" | "help">;
}

/** One recorded change to a ticket, oldest first; the first is when it was added. */
export interface TicketChange {
  ts: string;
  status?: TicketStatus;
  stage?: string;
  note?: string;
  /** A revised estimate, with the one it replaced. */
  estimate?: { from: number; to: number };
  percent?: number;
  by?: string;
}

export interface Ticket {
  id: string;
  title: string;
  status: TicketStatus;
  stage?: string;
  estimate?: number;
  /** Tickets that must finish before this one can. */
  waitsFor?: string[];
  /** The ticket this one is a sub-task of. */
  parent?: string;
  related?: string[];
  source?: string;
  /** The latest note recorded on the ticket. */
  note?: string;
  /** When the ticket entered its current status, stage, and last working spell. */
  statusSince: string;
  stageSince?: string;
  workingSince?: string;
  updatedAt: string;
  /** The agent behind the latest update. */
  by?: string;
  /** Agents assigned to it, in order; the ones working it while it is open. */
  agents: string[];
  labels?: string[];
  /** Agent-reported progress, 0-100. */
  percent?: number;
  history: TicketChange[];
}

export interface Question {
  id: string;
  title: string;
  text: string;
  options: { key: string; label: string; detail?: string }[];
  recommend?: string;
  ticket?: string;
  files?: string[];
  /** The user may pick several options; `answer.choice` then lists keys like "A,C". */
  multi?: boolean;
  askedAt: string;
  /** The agent that asked. */
  by?: string;
  /**
   * `choice` is absent when the answer is in words only. `by` is "user" for the app, else the
   * agent that recorded it (usually the conductor).
   */
  answer?: { choice?: string; words?: string; ts: string; by?: string };
}

export interface StuckFlag {
  id: string;
  text: string;
  ticket?: string;
  ts: string;
  resolved: boolean;
  /** The agent that raised it; its next normal update clears the flag. */
  by?: string;
}

/** A feed entry, shaped like a commit message: a short title, optional body, and a kind. */
export interface ActivityItem {
  ts: string;
  title: string;
  body?: string;
  kind?: ActivityKind;
  ticket?: string;
  by?: string;
}

export interface Deliverable {
  id: string;
  label: string;
  target: string;
  ticket?: string;
  ts: string;
}

export interface ProgressState {
  title: string;
  subtitle?: string;
  startedAt: string;
  updatedAt: string;
  finished?: { outcome: string; ts: string };
  ticker?: { text: string; ts: string; by?: string };
  tickets: Ticket[];
  questions: Question[];
  stuck: StuckFlag[];
  activity: ActivityItem[];
  deliverables: Deliverable[];
}

export function emptyState(ts: string, title = "Progress"): ProgressState {
  return {
    title,
    startedAt: ts,
    updatedAt: ts,
    tickets: [],
    questions: [],
    stuck: [],
    activity: [],
    deliverables: [],
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Next id for a prefix, never reusing ones from earlier runs in the same file. */
export function nextId(
  prefix: "T" | "Q" | "S" | "D",
  taken: readonly string[],
): string {
  const highest = taken
    .filter((id) => id.startsWith(prefix))
    .map((id) => Number(id.slice(1)))
    .filter(Number.isFinite)
    .reduce((max, value) => Math.max(max, value), 0);
  return `${prefix}${prefix === "T" ? pad(highest + 1) : highest + 1}`;
}

export function normalizeId(id: string | undefined): string | undefined {
  const match = id?.trim().match(/^([TQSD])\s*0*(\d+)$/i);
  if (!match?.[1] || !match[2]) return undefined;
  const prefix = match[1].toUpperCase();
  return prefix === "T"
    ? `T${pad(Number(match[2]))}`
    : `${prefix}${Number(match[2])}`;
}

export const DEFAULT_TICKET_PREFIX = "T";

/** 1-3 letters or digits, uppercased; Q, S, and D name questions, stuck flags, and deliverables. */
export const ticketPrefixSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(
    z
      .string()
      .regex(/^[A-Z0-9]{1,3}$/, "Use 1-3 letters or digits")
      .refine((value) => !["Q", "S", "D"].includes(value), {
        message:
          "Q, S, and D are taken by questions, stuck flags, and deliverables",
      }),
  );

/** How a ticket id reads: T01 with the default prefix, AI-01 with "AI". Ids are stored as T01. */
export function displayTicketId(id: string, prefix: string): string {
  const number = /^T(\d+)$/.exec(id)?.[1];
  if (!number || prefix === DEFAULT_TICKET_PREFIX) return id;
  return `${prefix}-${number}`;
}

/** A ticket reference as agents may write it (AI-03, #AI-03, AI3, T03, or 3) to its stored id. */
export function parseTicketId(
  ref: string | undefined,
  prefix: string,
): string | undefined {
  const value = ref?.trim().replace(/^#/, "");
  if (!value) return undefined;
  const escaped = prefix.replace(/[^A-Z0-9]/gi, "");
  // A prefix ending in a digit needs the dash, or AI2-3 and a bare 23 would blur.
  const dash = /\d$/.test(escaped) ? "-" : "-?";
  const match = new RegExp(`^(?:${escaped}${dash}|T)?\\s*0*(\\d+)$`, "i").exec(
    value,
  );
  return match?.[1] ? `T${pad(Number(match[1]))}` : undefined;
}

/** The run with every ticket id as people read it (AI-01), for the app to show as is. */
export function displayState(
  state: ProgressState,
  prefix: string,
): ProgressState {
  if (prefix === DEFAULT_TICKET_PREFIX) return state;
  const show = <T extends { ticket?: string }>(item: T): T =>
    item.ticket
      ? { ...item, ticket: displayTicketId(item.ticket, prefix) }
      : item;
  return {
    ...state,
    tickets: state.tickets.map((ticket) => ({
      ...ticket,
      id: displayTicketId(ticket.id, prefix),
      ...(ticket.waitsFor
        ? { waitsFor: ticket.waitsFor.map((id) => displayTicketId(id, prefix)) }
        : {}),
      ...(ticket.parent
        ? { parent: displayTicketId(ticket.parent, prefix) }
        : {}),
      ...(ticket.related
        ? { related: ticket.related.map((id) => displayTicketId(id, prefix)) }
        : {}),
    })),
    questions: state.questions.map(show),
    stuck: state.stuck.map(show),
    activity: state.activity.map(show),
    deliverables: state.deliverables.map(show),
  };
}

/** Folds events (oldest first) into the current run. Events before the last `start` are dropped. */
export function reduceProgress(
  events: readonly ProgressEvent[],
): ProgressState | null {
  let state: ProgressState | null = null;
  for (const event of events) {
    if (event.op === "start") {
      state = emptyState(event.ts, event.title?.trim() || "Progress");
      if (event.text) state.subtitle = event.text;
      continue;
    }
    state ??= emptyState(event.ts);
    state.updatedAt = event.ts;
    apply(state, event);
  }
  return state;
}

const firstLine = (text: string): string => {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
};

/** Adds a feed entry and makes it the ticker; the title falls back to the body's first line. */
function addActivity(
  state: ProgressState,
  event: ProgressEvent,
  title: string | undefined,
): void {
  const body = event.body?.trim();
  const line = title?.trim() || (body ? firstLine(body) : "");
  if (!line) return;
  state.ticker = {
    text: line,
    ts: event.ts,
    ...(event.by ? { by: event.by } : {}),
  };
  state.activity.push({
    ts: event.ts,
    title: line,
    ...(body && body !== line ? { body } : {}),
    ...(event.kind ? { kind: event.kind } : {}),
    ...(event.ticket ? { ticket: event.ticket } : {}),
    ...(event.by ? { by: event.by } : {}),
  });
}

const cleanLabels = (labels: readonly string[]): string[] => [
  ...new Set(labels.map((label) => label.trim()).filter(Boolean)),
];

/** Estimate and percent changes, which any ticket or ticker update may carry. */
function applyProgress(
  ticket: Ticket,
  event: ProgressEvent,
  change: TicketChange,
): void {
  if (event.estimate && event.estimate !== ticket.estimate) {
    if (ticket.estimate)
      change.estimate = { from: ticket.estimate, to: event.estimate };
    ticket.estimate = event.estimate;
  }
  if (event.percent !== undefined && event.percent !== ticket.percent) {
    change.percent = event.percent;
    ticket.percent = event.percent;
  }
}

/** Ticket ids out of a list; a lone string (older logs) counts as one. */
function ticketIds(refs: readonly string[] | string): string[] {
  return [
    ...new Set(
      [refs]
        .flat()
        .map((ref) => normalizeId(ref.replace(/^#/, "")))
        .filter((id): id is string => Boolean(id?.startsWith("T"))),
    ),
  ];
}

const AUTO_DONE = "Done: all ";

/** Once every sub-task is done or skipped, the parent is done too, and says why. */
function settleParent(
  state: ProgressState,
  child: Ticket,
  event: ProgressEvent,
): void {
  const parent = state.tickets.find((ticket) => ticket.id === child.parent);
  if (!parent || parent.status === "done" || parent.status === "skipped")
    return;
  const children = state.tickets.filter(
    (ticket) => ticket.parent === parent.id,
  );
  if (
    !children.every(
      (ticket) => ticket.status === "done" || ticket.status === "skipped",
    )
  )
    return;
  const reason = `${AUTO_DONE}${children.length} sub-tasks finished`;
  const change: TicketChange = { ts: event.ts, note: reason };
  setStatus(parent, "done", event.ts, change);
  parent.note = reason;
  parent.history.push(change);
  parent.updatedAt = event.ts;
  state.activity.push({ ts: event.ts, title: reason, ticket: parent.id });
  settleParent(state, parent, event);
}

/** An open sub-task joining (or reopening under) a parent that closed itself reopens it. */
function reopenParent(
  state: ProgressState,
  child: Ticket,
  event: ProgressEvent,
): void {
  const parent = state.tickets.find((ticket) => ticket.id === child.parent);
  if (
    !parent ||
    child.status === "done" ||
    child.status === "skipped" ||
    parent.status !== "done" ||
    !parent.note?.startsWith(AUTO_DONE)
  )
    return;
  const status = parent.workingSince ? "working" : "not_started";
  const reason = `Reopened: ${child.id} is open`;
  const change: TicketChange = { ts: event.ts, note: reason };
  setStatus(parent, status, event.ts, change);
  parent.note = reason;
  parent.history.push(change);
  parent.updatedAt = event.ts;
  reopenParent(state, parent, event);
}

/** Whether `by` is an agent working the ticket (the user never owns one). */
function isOwner(ticket: Ticket, by: string | undefined): boolean {
  if (!by || by === "user") return false;
  return ticket.agents.length ? ticket.agents.includes(by) : ticket.by === by;
}

function setStatus(
  ticket: Ticket,
  status: TicketStatus,
  ts: string,
  change: TicketChange,
): void {
  change.status = status;
  ticket.status = status;
  ticket.statusSince = ts;
  if (status === "working") ticket.workingSince = ts;
  if (status === "done" || status === "skipped") {
    delete ticket.stage;
    delete ticket.stageSince;
  }
}

/** A blocked ticket goes back to working, with the reason in its history and the feed. */
function unblock(
  state: ProgressState,
  ticket: Ticket,
  event: ProgressEvent,
  reason: string,
): void {
  if (ticket.status !== "blocked") return;
  const change: TicketChange = {
    ts: event.ts,
    note: reason,
    ...(event.by ? { by: event.by } : {}),
  };
  setStatus(ticket, "working", event.ts, change);
  ticket.history.push(change);
  ticket.updatedAt = event.ts;
  state.activity.push({
    ts: event.ts,
    title: reason,
    ticket: ticket.id,
    ...(event.by ? { by: event.by } : {}),
  });
}

/** A normal update from the agent that raised a stuck flag means it moved on: clear the flag. */
function clearOwnFlags(
  state: ProgressState,
  by: string | undefined,
  ticketId: string | undefined,
): void {
  if (!by || by === "user") return;
  for (const flag of state.stuck)
    if (
      !flag.resolved &&
      flag.by === by &&
      (!flag.ticket || !ticketId || flag.ticket === ticketId)
    )
      flag.resolved = true;
}

/** Updates that show work moving (not just a relabel or rename). */
const movesWork = (event: ProgressEvent): boolean =>
  event.stage !== undefined ||
  event.percent !== undefined ||
  event.estimate !== undefined ||
  Boolean(event.note?.trim() || event.body?.trim() || event.text?.trim()) ||
  event.kind !== undefined;

function apply(state: ProgressState, event: ProgressEvent): void {
  switch (event.op) {
    case "ticket": {
      const id = normalizeId(event.id);
      if (!id) return;
      let ticket = state.tickets.find((candidate) => candidate.id === id);
      if (!ticket) {
        ticket = {
          id,
          title: event.title?.trim() || id,
          status: "not_started",
          statusSince: event.ts,
          updatedAt: event.ts,
          agents: [],
          history: [{ ts: event.ts, status: "not_started" }],
        };
        state.tickets.push(ticket);
      }
      if (event.title?.trim()) ticket.title = event.title.trim();
      if (event.waitsFor !== undefined) {
        const waits = ticketIds(event.waitsFor);
        if (waits.length) ticket.waitsFor = waits;
        else delete ticket.waitsFor;
      }
      if (event.related !== undefined) {
        const related = ticketIds(event.related);
        if (related.length) ticket.related = related;
        else delete ticket.related;
      }
      if (event.parent !== undefined) {
        const parent = normalizeId(event.parent);
        if (parent?.startsWith("T")) ticket.parent = parent;
        else delete ticket.parent;
      }
      if (event.source !== undefined) {
        if (event.source) ticket.source = event.source;
        else delete ticket.source;
      }
      if (event.labels) {
        const labels = cleanLabels(event.labels);
        if (labels.length) ticket.labels = labels;
        else delete ticket.labels;
      }
      const owner =
        event.agent?.trim() ||
        (event.status === "working" && event.by !== "user"
          ? event.by
          : undefined);
      if (owner && !ticket.agents.includes(owner)) ticket.agents.push(owner);
      const change: TicketChange = {
        ts: event.ts,
        ...(event.by ? { by: event.by } : {}),
      };
      applyProgress(ticket, event, change);
      if (event.status && event.status !== ticket.status)
        setStatus(ticket, event.status, event.ts, change);
      else if (
        !event.status &&
        ticket.status === "blocked" &&
        isOwner(ticket, event.by) &&
        movesWork(event)
      )
        // The owner is working it again without saying so.
        setStatus(ticket, "working", event.ts, change);
      if (
        event.stage !== undefined &&
        (event.stage || undefined) !== ticket.stage
      ) {
        change.stage = event.stage;
        ticket.stage = event.stage || undefined;
        ticket.stageSince = event.stage ? event.ts : undefined;
      }
      if (event.note?.trim()) {
        change.note = event.note.trim();
        ticket.note = change.note;
      }
      if (Object.keys(change).some((key) => key !== "ts" && key !== "by"))
        ticket.history.push(change);
      if (change.status === "done" || change.status === "skipped")
        settleParent(state, ticket, event);
      else reopenParent(state, ticket, event);
      ticket.updatedAt = event.ts;
      if (event.by) ticket.by = event.by;
      if (movesWork(event) && event.status !== "blocked")
        clearOwnFlags(state, event.by, id);
      addActivity(state, { ...event, ticket: id }, event.note);
      return;
    }
    case "ask": {
      const id = normalizeId(event.id);
      if (!id) return;
      state.questions.push({
        id,
        title: event.title?.trim() || id,
        text: event.text ?? "",
        options: event.options ?? [],
        ...(event.recommend ? { recommend: event.recommend } : {}),
        ...(event.ticket ? { ticket: event.ticket } : {}),
        ...(event.files?.length ? { files: event.files } : {}),
        ...(event.multi ? { multi: true } : {}),
        askedAt: event.ts,
        ...(event.by ? { by: event.by } : {}),
      });
      return;
    }
    case "answer": {
      const question = state.questions.find(
        (candidate) => candidate.id === normalizeId(event.id),
      );
      const words = event.words?.trim();
      if (!question || (!event.choice && !words)) return;
      question.answer = {
        ...(event.choice ? { choice: event.choice } : {}),
        ...(words ? { words } : {}),
        ts: event.ts,
        ...(event.by ? { by: event.by } : {}),
      };
      const ticket = state.tickets.find(
        (candidate) => candidate.id === question.ticket,
      );
      if (ticket)
        unblock(state, ticket, event, `Unblocked by answer ${question.id}`);
      return;
    }
    case "deliver": {
      const id = normalizeId(event.id);
      if (!id || !event.target) return;
      state.deliverables.push({
        id,
        label: event.title?.trim() || event.target,
        target: event.target,
        ...(event.ticket ? { ticket: event.ticket } : {}),
        ts: event.ts,
      });
      return;
    }
    case "stuck": {
      const id = normalizeId(event.id);
      if (!id || !event.text) return;
      state.stuck.push({
        id,
        text: event.text,
        ...(event.ticket ? { ticket: event.ticket } : {}),
        ts: event.ts,
        resolved: false,
        ...(event.by ? { by: event.by } : {}),
      });
      return;
    }
    case "unstuck": {
      const flag = state.stuck.find(
        (candidate) => candidate.id === normalizeId(event.id),
      );
      if (flag) flag.resolved = true;
      return;
    }
    case "withdraw":
      state.questions = state.questions.filter(
        (question) => question.id !== normalizeId(event.id),
      );
      return;
    case "ticker": {
      const ticket = state.tickets.find(
        (candidate) => candidate.id === event.ticket,
      );
      if (ticket) {
        const change: TicketChange = {
          ts: event.ts,
          ...(event.by ? { by: event.by } : {}),
        };
        applyProgress(ticket, event, change);
        if (ticket.status === "blocked" && isOwner(ticket, event.by))
          setStatus(ticket, "working", event.ts, change);
        if (
          change.estimate ||
          change.percent !== undefined ||
          change.status !== undefined
        )
          ticket.history.push(change);
        ticket.updatedAt = event.ts;
      }
      if (movesWork(event)) clearOwnFlags(state, event.by, event.ticket);
      addActivity(state, event, event.text);
      return;
    }
    case "finish":
      state.finished = {
        outcome: event.title?.trim() || "Finished",
        ts: event.ts,
      };
      return;
    case "start":
      return;
  }
}

export interface ProgressSummary {
  total: number;
  done: number;
  working: number;
  blocked: number;
  openQuestions: number;
  openStuck: number;
  percent: number;
  estimatedMinutes: number;
  doneMinutes: number;
}

/** Milliseconds a ticket spent working, over all its working spells until `now`. */
export function workedMs(ticket: Ticket, now: number): number {
  let total = 0;
  let since: number | null = null;
  let status: TicketStatus = "not_started";
  for (const change of ticket.history) {
    if (change.status === undefined || change.status === status) continue;
    const at = Date.parse(change.ts);
    if (since !== null) total += at - since;
    status = change.status;
    since = status === "working" ? at : null;
  }
  return since === null ? total : total + Math.max(0, now - since);
}

/**
 * How much of a ticket is done, 0-1: done is 1; else the agent's percent; else working time
 * against the estimate, capped so time alone never claims it nearly finished.
 */
export function ticketFraction(
  ticket: Ticket,
  now: number,
  /** The run's tickets: a parent then rolls up its sub-tasks, weighted by estimate. */
  all: readonly Ticket[] = [],
): number {
  if (ticket.status === "done") return 1;
  const children = all.filter(
    (child) => child.parent === ticket.id && child.status !== "skipped",
  );
  if (children.length) {
    const estimated = children.every((child) => child.estimate);
    const weight = (child: Ticket) => (estimated ? (child.estimate ?? 1) : 1);
    const total = children.reduce((sum, child) => sum + weight(child), 0);
    return (
      children.reduce(
        (sum, child) => sum + weight(child) * ticketFraction(child, now, all),
        0,
      ) / total
    );
  }
  if (ticket.percent !== undefined) return Math.min(1, ticket.percent / 100);
  if (ticket.status === "not_started" || ticket.status === "skipped") return 0;
  const estimateMs = (ticket.estimate ?? DEFAULT_ESTIMATE_MIN) * 60_000;
  return Math.min(SOFT_PERCENT_CAP / 100, workedMs(ticket, now) / estimateMs);
}

/** Overall progress, each ticket weighted by its estimate (or equally when some have none). */
export function overallProgress(
  tickets: readonly Ticket[],
  now: number,
): { percent: number; doneMin: number; totalMin: number } {
  // Parents count through their sub-tasks, so nothing is counted twice.
  const counted = tickets.filter(
    (ticket) =>
      ticket.status !== "skipped" &&
      !tickets.some((child) => child.parent === ticket.id),
  );
  const estimated = counted.every((ticket) => ticket.estimate);
  const weight = (ticket: Ticket) => (estimated ? (ticket.estimate ?? 1) : 1);
  const totalWeight = counted.reduce((sum, ticket) => sum + weight(ticket), 0);
  const doneWeight = counted.reduce(
    (sum, ticket) => sum + weight(ticket) * ticketFraction(ticket, now),
    0,
  );
  // Rounded, but 100% only once every counted ticket is done.
  const rounded = totalWeight
    ? Math.round((doneWeight / totalWeight) * 100)
    : 0;
  const complete = counted.every((ticket) => ticket.status === "done");
  return {
    percent: complete ? rounded : Math.min(99, rounded),
    doneMin: counted.reduce(
      (sum, ticket) =>
        sum + (ticket.estimate ?? 0) * ticketFraction(ticket, now),
      0,
    ),
    totalMin: counted.reduce((sum, ticket) => sum + (ticket.estimate ?? 0), 0),
  };
}

export function summarize(
  state: ProgressState,
  now = Date.parse(state.updatedAt),
): ProgressSummary {
  const counted = state.tickets.filter((ticket) => ticket.status !== "skipped");
  const done = counted.filter((ticket) => ticket.status === "done");
  const {
    percent,
    doneMin: doneMinutes,
    totalMin: estimated,
  } = overallProgress(state.tickets, now);
  return {
    total: counted.length,
    done: done.length,
    working: counted.filter((ticket) => ticket.status === "working").length,
    blocked: counted.filter((ticket) => ticket.status === "blocked").length,
    openQuestions: state.questions.filter((question) => !question.answer)
      .length,
    openStuck:
      state.stuck.filter((flag) => !flag.resolved).length +
      counted.filter((ticket) => ticket.status === "blocked").length,
    percent,
    estimatedMinutes: estimated,
    doneMinutes,
  };
}

export function headline(state: ProgressState, now: number): string {
  const summary = summarize(state, now);
  const parts = [
    `${summary.percent}% · ${summary.done} of ${summary.total} tickets done`,
  ];
  if (summary.openQuestions)
    parts.push(`${summary.openQuestions} waiting for you`);
  if (summary.openStuck) parts.push(`${summary.openStuck} stuck`);
  return parts.join(", ");
}

/** Possibly stale: tickets remain, nothing finished, and no update for a while. */
export function isStale(
  state: ProgressState,
  now: number,
  agentRunning: boolean,
): boolean {
  if (state.finished || agentRunning) return false;
  const remaining = state.tickets.some(
    (ticket) => ticket.status !== "done" && ticket.status !== "skipped",
  );
  return remaining && now - Date.parse(state.updatedAt) > STALE_AFTER_MS;
}

/** Compact text for the agent: just enough to act on, nothing decorative. */
export function renderForAgent(
  state: ProgressState | null,
  now: number,
  prefix = DEFAULT_TICKET_PREFIX,
): string {
  if (!state) return "No progress run. Call op=start first.";
  const show = (id: string) => displayTicketId(id, prefix);
  const lines = [
    `${state.title}${state.finished ? ` [finished: ${state.finished.outcome}]` : ""} | ${headline(state, now)}`,
  ];
  if (prefix !== DEFAULT_TICKET_PREFIX)
    lines.push(`Ticket ids read ${show("T01")}; write them that way.`);
  for (const ticket of state.tickets) {
    const open = ticket.status === "working" || ticket.status === "blocked";
    lines.push(
      `${show(ticket.id)} ${ticket.status}${ticket.stage ? `/${ticket.stage}` : ""}${open ? ` ${Math.floor(ticketFraction(ticket, now, state.tickets) * 100)}%` : ""} ${ticket.title}${ticket.parent ? ` (sub-task of ${show(ticket.parent)})` : ""}${ticket.waitsFor ? ` (waits ${ticket.waitsFor.map(show).join(", ")})` : ""}`,
    );
  }
  for (const question of state.questions.filter(
    (candidate) => !candidate.answer,
  )) {
    lines.push(`${question.id} open: ${question.title}`);
  }
  for (const flag of state.stuck.filter((candidate) => !candidate.resolved)) {
    lines.push(`${flag.id} stuck: ${flag.text}`);
  }
  if (state.ticker) lines.push(`now: ${state.ticker.text}`);
  return lines.join("\n");
}

export const getProgressRpc = defineRpc({
  name: "conductor.progress.get",
  input: z.object({ conductorId: z.string().min(1) }).strict(),
  output: z
    .object({
      state: z.custom<ProgressState>().nullable(),
      /** How ticket ids read in this conductor; see displayTicketId. */
      ticketPrefix: z.string(),
      view: z.custom<DashboardView>(),
      /** Blocker key (ticket id or S1) to how often the conductor was told, this spell. */
      escalated: z.record(z.string(), z.number()),
    })
    .strict(),
});

/** The dashboard's saved search and sort, per conductor. */
export const dashboardViewSchema = z
  .object({
    ticketQuery: z.string().max(500).default(""),
    ticketSort: z
      .enum(["recent", "status", "eta", "created", "percent"])
      .default("recent"),
    feedQuery: z.string().max(500).default(""),
    /** Whether the feed only shows entries of tickets the ticket search matches. */
    feedScoped: z.boolean().default(false),
  })
  .strict();
export type DashboardView = z.infer<typeof dashboardViewSchema>;

export const saveViewRpc = defineRpc({
  name: "conductor.progress.view",
  input: z
    .object({ conductorId: z.string().min(1), view: dashboardViewSchema })
    .strict(),
  output: z.object({}).strict(),
});

export const setTicketPrefixRpc = defineRpc({
  name: "conductor.progress.ticket_prefix",
  input: z
    .object({
      conductorId: z.string().min(1),
      ticketPrefix: ticketPrefixSchema,
    })
    .strict(),
  output: z.object({ ticketPrefix: z.string() }).strict(),
});

export function ticketPrefixNote(prefix: string): string {
  return `The user changed ticket ids to read ${displayTicketId("T01", prefix)}, ${displayTicketId("T02", prefix)}, and so on. Use that form from now on, in the progress tool and when you brief workers; bare numbers work too. Reply with one short line.`;
}

export const answerQuestionRpc = defineRpc({
  name: "conductor.progress.answer",
  input: z
    .object({
      conductorId: z.string().min(1),
      id: z.string().min(1),
      /** An option key ("A,C" on a multi question); omit to answer in words only. */
      choice: z.string().min(1).optional(),
      words: z.string().trim().optional(),
    })
    .strict()
    .refine((input) => Boolean(input.choice || input.words), {
      message: "Pick an option or write an answer",
    }),
  output: z.object({ ok: z.literal(true) }).strict(),
});

/** Option keys in a choice: "A", or "A,C" on a multi question. */
export function choiceKeys(choice: string | undefined): string[] {
  return [
    ...new Set(
      (choice ?? "")
        .split(/[\s,]+/)
        .map((key) => key.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * A choice in the question's option order and key case, or null when a key is unknown, or several keys
 * answer a single-choice question.
 */
export function normalizeChoice(
  question: Pick<Question, "options" | "multi">,
  choice: string | undefined,
): string | null {
  const keys = choiceKeys(choice).map((key) => key.toLowerCase());
  if (!keys.length) return null;
  const known = question.options.map((option) => option.key);
  const lower = known.map((key) => key.toLowerCase());
  if (keys.some((key) => !lower.includes(key))) return null;
  const picked = known.filter((key) => keys.includes(key.toLowerCase()));
  if (picked.length > 1 && !question.multi) return null;
  return picked.join(",");
}

const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** The steer note telling the conductor a worker asked, so it can answer when it can decide. */
export function askNote(question: Question): string {
  const options = question.options
    .map((option) => `${option.key}) ${clip(option.label, 60)}`)
    .join("; ");
  const pick = question.multi ? "pick any" : "pick one";
  return (
    `Agent ${question.by ?? "?"} asked ${question.id} "${clip(question.title, 80)}": ` +
    `${clip(question.text, 240)} Options (${pick}): ${options}; recommends ${question.recommend ?? "none"}. ` +
    `If you can decide, op=answer id=${question.id} choice=<key> words="<why>"; otherwise leave it for the user.`
  );
}

/** Who answered, as the note's reader sees it. */
export function answeredByLabel(
  by: string | undefined,
  conductorId: string,
): string {
  if (!by || by === "user") return "The user";
  return by === conductorId ? "The conductor" : `Agent ${by}`;
}

/** The steer note that hands an answer to the agent that asked (and to the conductor). */
export function answerNote(
  id: string,
  choice: string | undefined,
  words: string | undefined,
  who = "The user",
): string {
  const said = words?.trim();
  const keys = choiceKeys(choice);
  const picked =
    keys.length > 1 ? `options ${keys.join(", ")}` : `option ${keys[0] ?? ""}`;
  const answer = keys.length
    ? `${picked}${said ? `, adding: "${said}"` : ""}`
    : `in their own words: "${said ?? ""}"`;
  return `${who} answered ${id} ${answer}. Record nothing for it; it is already recorded. Continue the work this question was blocking.`;
}

export const previewTargetRpc = defineRpc({
  name: "conductor.progress.preview",
  input: z
    .object({ conductorId: z.string().min(1), target: z.string().min(1) })
    .strict(),
  output: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("image"), mime: z.string(), data: z.string() }),
    z.object({
      kind: z.literal("text"),
      text: z.string(),
      truncated: z.boolean(),
    }),
    z.object({ kind: z.literal("link"), url: z.string() }),
    /** Not previewable in the app; the user can open it on the daemon host. */
    z.object({ kind: z.literal("open"), reason: z.string() }),
  ]),
});

/**
 * Opens a recorded item outside the app: links as they are, files through a temporary media page
 * (on the tailnet when Tailscale runs, else localhost), folders on the machine running Paseo.
 */
export const shareTargetRpc = defineRpc({
  name: "conductor.progress.share",
  input: z
    .object({ conductorId: z.string().min(1), target: z.string().min(1) })
    .strict(),
  output: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("url"), url: z.string() }).strict(),
    z.object({ kind: z.literal("host") }).strict(),
  ]),
});

export const runHistoryRpc = defineRpc({
  name: "conductor.progress.history",
  input: z
    .object({
      conductorId: z.string().min(1),
      /** Folder inside the conductor's workspace; null stops saving; undefined only reads. */
      folder: z.string().nullable().optional(),
    })
    .strict(),
  output: z.object({ folder: z.string().nullable() }).strict(),
});

/** Steer notes for an ask or answer, keyed by the agent that should get each. */
export function questionNotes(
  conductorId: string,
  event: Pick<ProgressEvent, "op" | "by" | "choice" | "words">,
  question: Question,
): Map<string, string> {
  const notes = new Map<string, string>();
  if (event.op === "ask") {
    if (question.by && question.by !== conductorId)
      notes.set(conductorId, askNote(question));
    return notes;
  }
  if (event.op !== "answer") return notes;
  const note = answerNote(
    question.id,
    event.choice,
    event.words,
    answeredByLabel(event.by, conductorId),
  );
  if (event.by === "user") notes.set(conductorId, note);
  if (question.by && question.by !== "user") notes.set(question.by, note);
  if (event.by) notes.delete(event.by);
  return notes;
}
