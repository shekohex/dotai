import { waitingOn as openWaits } from "../shared/links.js";
import {
  DEFAULT_TICKET_PREFIX,
  displayTicketId,
  type ProgressState,
} from "../shared/progress.js";

export interface EscalationSettings {
  enabled: boolean;
  /** Minutes blocked or stuck before the conductor hears about it. */
  minutes: number;
  /** Minutes between repeats while it stays blocked. */
  repeatMinutes: number;
  /** Notes per blocker per blocked spell. */
  max: number;
}

export const DEFAULT_ESCALATION: EscalationSettings = {
  enabled: true,
  minutes: 10,
  repeatMinutes: 30,
  max: 3,
};

/** A blocked ticket or an open stuck flag, as the monitor sees it. */
export interface Blocker {
  /** Ticket id for a blocked ticket, flag id (S1) for a stuck flag. */
  key: string;
  kind: "blocked" | "stuck";
  ticket?: string;
  since: number;
  reason: string;
  /** The agent working it, who would unblock it. */
  owner?: string;
  /** An open question on the ticket: then it waits on the user, which is expected. */
  waitingOn?: string;
}

export function blockers(state: ProgressState): Blocker[] {
  const openQuestion = (ticketId: string | undefined) =>
    ticketId
      ? state.questions.find(
          (question) => question.ticket === ticketId && !question.answer,
        )?.id
      : undefined;
  const items: Blocker[] = [];
  const byId = new Map(state.tickets.map((ticket) => [ticket.id, ticket]));
  for (const ticket of state.tickets) {
    // Waiting on other open tickets of the run is ordering, not a blocker.
    if (ticket.status !== "blocked" || openWaits(ticket, byId).length) continue;
    const waitingOn = openQuestion(ticket.id);
    items.push({
      key: ticket.id,
      kind: "blocked",
      ticket: ticket.id,
      since: Date.parse(ticket.statusSince),
      reason: ticket.note ?? "no reason given",
      owner: ticket.agents.at(-1) ?? ticket.by,
      ...(waitingOn ? { waitingOn } : {}),
    });
  }
  for (const flag of state.stuck) {
    if (flag.resolved) continue;
    const waitingOn = openQuestion(flag.ticket);
    items.push({
      key: flag.id,
      kind: "stuck",
      ...(flag.ticket ? { ticket: flag.ticket } : {}),
      since: Date.parse(flag.ts),
      reason: flag.text,
      ...(flag.by ? { owner: flag.by } : {}),
      ...(waitingOn ? { waitingOn } : {}),
    });
  }
  return items;
}

/** Per blocker: the blocked spell it was escalated in, how often, and when last. */
export type EscalationLog = Record<
  string,
  { since: number; count: number; last: number }
>;

/**
 * Blockers to tell the conductor about now: blocked `minutes` or longer, then again every
 * `repeatMinutes`, at most `max` times per spell. Ones waiting on the user's answer are expected
 * and skipped. Returns the updated log.
 */
export function dueEscalations(
  state: ProgressState,
  now: number,
  log: EscalationLog,
  settings: EscalationSettings,
): { due: Blocker[]; log: EscalationLog } {
  const due: Blocker[] = [];
  const next: EscalationLog = {};
  if (!settings.enabled || state.finished) return { due, log: next };
  for (const blocker of blockers(state)) {
    const entry =
      log[blocker.key]?.since === blocker.since
        ? log[blocker.key]!
        : { since: blocker.since, count: 0, last: 0 };
    next[blocker.key] = entry;
    if (blocker.waitingOn) continue;
    if (
      entry.count < settings.max &&
      now - blocker.since >= settings.minutes * 60_000 &&
      (entry.count === 0 || now - entry.last >= settings.repeatMinutes * 60_000)
    ) {
      next[blocker.key] = {
        since: blocker.since,
        count: entry.count + 1,
        last: now,
      };
      due.push(blocker);
    }
  }
  return { due, log: next };
}

function label(blocker: Blocker, prefix: string): string {
  const ticket = blocker.ticket
    ? displayTicketId(blocker.ticket, prefix)
    : undefined;
  return blocker.kind === "blocked"
    ? `${ticket} blocked`
    : `${blocker.key} stuck${ticket ? ` on ${ticket}` : ""}`;
}

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))}m`;

export function escalationNote(
  items: readonly Blocker[],
  now: number,
  prefix = DEFAULT_TICKET_PREFIX,
): string {
  const lines = items.map(
    (blocker) =>
      `${label(blocker, prefix)} ${minutes(now - blocker.since)}: ${blocker.reason.replace(/\.$/, "")}.`,
  );
  return `${lines.join(" ")} Decide: answer, unblock, or reassign; or leave it for the user.`;
}

/** Blockers already flagged to their agent on resume, by the spell they were in. */
export type ResumeLog = Record<string, number>;

/**
 * Agents seen running again (not running at the last look, running now) while something of theirs
 * is still blocked or stuck: one note per agent, once per blocked spell.
 */
export function dueResumeChecks(
  items: readonly Blocker[],
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
  log: ResumeLog,
): { due: Map<string, Blocker[]>; log: ResumeLog } {
  const due = new Map<string, Blocker[]>();
  const next: ResumeLog = {};
  for (const blocker of items) {
    if (log[blocker.key] === blocker.since) next[blocker.key] = blocker.since;
    const owner = blocker.owner;
    if (!owner || next[blocker.key] !== undefined) continue;
    const before = previous.get(owner);
    if (before === undefined || before === "running") continue;
    if (current.get(owner) !== "running") continue;
    next[blocker.key] = blocker.since;
    due.set(owner, [...(due.get(owner) ?? []), blocker]);
  }
  return { due, log: next };
}

export function resumeNote(
  items: readonly Blocker[],
  prefix = DEFAULT_TICKET_PREFIX,
): string {
  const what = items
    .map((blocker) =>
      blocker.kind === "blocked"
        ? `ticket ${displayTicketId(blocker.key, prefix)} is marked blocked`
        : `stuck flag ${blocker.key} is still open`,
    )
    .join(" and your ");
  return `Your ${what} but you are running again. If resolved, update its status with the progress tool.`;
}
