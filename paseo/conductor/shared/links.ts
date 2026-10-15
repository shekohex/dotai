/**
 * How tickets relate, GitHub-issue style: waits for (and the reverse, blocks), parent and
 * sub-tasks, related, and #mentions in text with their backlinks. Stored links are waitsFor,
 * parent, and related; everything else is derived here.
 */
import type { ProgressState, Ticket } from "./progress.js";

export interface TicketLinks {
  waitsFor: string[];
  blocks: string[];
  parent?: string;
  children: string[];
  related: string[];
  /** Tickets or questions whose text mentions this ticket. */
  mentionedIn: string[];
}

const settled = (ticket: Pick<Ticket, "status"> | undefined) =>
  ticket?.status === "done" || ticket?.status === "skipped";

const MENTION =
  /(?<![\w&/])#(?:[A-Za-z][A-Za-z0-9]{0,2}-?|\d{1,3}-)?(\d{1,4})\b/g;

/** The number at the end of a ticket id: 3 for T03 and AI-03. */
export const ticketNumber = (id: string): number =>
  Number(/(\d+)$/.exec(id)?.[1] ?? Number.NaN);

const storedId = (number: string) =>
  `T${String(Number(number)).padStart(2, "0")}`;

/**
 * `#AI-03`, `#ai3`, `#T03`, and `#3` all mention ticket 3; the prefix doesn't matter since ids are
 * numbered once per run. Returns stored ids (T03), in order, without repeats.
 */
export function mentionRefs(text: string | undefined): string[] {
  if (!text) return [];
  return [
    ...new Set([...text.matchAll(MENTION)].map((match) => storedId(match[1]!))),
  ];
}

/** Text cut around its mentions, so a renderer can draw each one as a ticket chip. */
export function splitMentions(
  text: string,
): ({ text: string } | { mention: string; raw: string })[] {
  const parts: ({ text: string } | { mention: string; raw: string })[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ mention: storedId(match[1]!), raw: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** Where each piece of text in the run came from, for backlinks. */
function texts(state: ProgressState): { from: string; text: string }[] {
  return [
    ...state.activity.flatMap((item) =>
      item.ticket
        ? [{ from: item.ticket, text: `${item.title}\n${item.body ?? ""}` }]
        : [],
    ),
    ...state.tickets.flatMap((ticket) =>
      ticket.history.flatMap((change) =>
        change.note ? [{ from: ticket.id, text: change.note }] : [],
      ),
    ),
    ...state.questions.map((question) => ({
      from: question.ticket ?? question.id,
      text: `${question.title}\n${question.text}`,
    })),
  ];
}

export function linkIndex(state: ProgressState): Map<string, TicketLinks> {
  const index = new Map<string, TicketLinks>(
    state.tickets.map((ticket) => [
      ticket.id,
      {
        waitsFor: ticket.waitsFor ?? [],
        blocks: [],
        ...(ticket.parent ? { parent: ticket.parent } : {}),
        children: [],
        related: [...(ticket.related ?? [])],
        mentionedIn: [],
      },
    ]),
  );
  for (const ticket of state.tickets) {
    for (const id of ticket.waitsFor ?? [])
      index.get(id)?.blocks.push(ticket.id);
    if (ticket.parent) index.get(ticket.parent)?.children.push(ticket.id);
    // Related goes both ways.
    for (const id of ticket.related ?? []) {
      const other = index.get(id);
      if (other && !other.related.includes(ticket.id))
        other.related.push(ticket.id);
    }
  }
  // Mentions name a ticket by number, so they find it whether ids read T03 or AI-03.
  const byNumber = new Map(
    state.tickets.map((ticket) => [ticketNumber(ticket.id), ticket.id]),
  );
  for (const { from, text } of texts(state))
    for (const ref of mentionRefs(text)) {
      const id = byNumber.get(ticketNumber(ref));
      const links = id ? index.get(id) : undefined;
      if (links && id !== from && !links.mentionedIn.includes(from))
        links.mentionedIn.push(from);
    }
  return index;
}

/**
 * "waiting" while any ticket it waits for is unfinished; "ready" once they all are and it hasn't
 * started. Waiting isn't stuck.
 */
export function readiness(
  ticket: Ticket,
  byId: ReadonlyMap<string, Ticket>,
): "ready" | "waiting" | undefined {
  if (settled(ticket) || !ticket.waitsFor?.length) return undefined;
  if (ticket.waitsFor.some((id) => !settled(byId.get(id)))) return "waiting";
  return ticket.status === "not_started" ? "ready" : undefined;
}

/** The unfinished tickets a ticket still waits for. */
export function waitingOn(
  ticket: Ticket,
  byId: ReadonlyMap<string, Ticket>,
): Ticket[] {
  if (settled(ticket)) return [];
  return (ticket.waitsFor ?? []).flatMap((id) => {
    const other = byId.get(id);
    return other && !settled(other) ? [other] : [];
  });
}

/** Whether following `next` from `start` comes back to `target`. */
function reaches(
  start: readonly string[],
  target: string,
  next: (id: string) => readonly string[],
): boolean {
  const seen = new Set<string>();
  const stack = [...start];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...next(id));
  }
  return false;
}

/**
 * Why a link change on ticket `id` is wrong, or undefined when it is fine: unknown tickets, links
 * to itself, or a loop in waits-for or parents. `show` prints ids the way the agent reads them.
 */
export function checkLinks(
  state: ProgressState | null,
  id: string,
  change: { waitsFor?: string[]; parent?: string; related?: string[] },
  show: (id: string) => string,
): string | undefined {
  const tickets = state?.tickets ?? [];
  const known = new Set(tickets.map((ticket) => ticket.id));
  const all = [
    ...(change.waitsFor ?? []).map((ref) => ["waitsFor", ref] as const),
    ...(change.related ?? []).map((ref) => ["related", ref] as const),
    ...(change.parent ? [["parent", change.parent] as const] : []),
  ];
  for (const [field, ref] of all) {
    if (ref === id) return `${field} can't point ${show(id)} at itself`;
    if (!known.has(ref)) {
      const ids = tickets.map((ticket) => show(ticket.id));
      const hint = ids.length
        ? ` Tickets: ${ids.length > 12 ? `${ids.slice(0, 12).join(", ")}…` : ids.join(", ")}.`
        : "";
      return `${field}: no ticket ${show(ref)} in this run.${hint}`;
    }
  }
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  if (change.waitsFor) {
    const waits = (other: string) =>
      other === id
        ? (change.waitsFor ?? [])
        : (byId.get(other)?.waitsFor ?? []);
    const loop = change.waitsFor.find((ref) => reaches([ref], id, waits));
    if (loop)
      return `waitsFor ${show(loop)} would loop: ${show(loop)} already waits for ${show(id)}`;
  }
  if (change.parent) {
    const up = (other: string) => {
      const parent = byId.get(other)?.parent;
      return parent ? [parent] : [];
    };
    if (reaches([change.parent], id, up))
      return `parent ${show(change.parent)} would loop: it is a sub-task of ${show(id)}`;
  }
  return undefined;
}
