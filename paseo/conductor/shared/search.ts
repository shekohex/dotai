/**
 * GitHub-style search for the dashboard: `status:working label:ui agent:ada is:blocked
 * stage:review ticket:AI-03 kind:fix` plus free words. Tokens with the same key are ORed, different
 * keys are ANDed, and a leading `-` negates a token. Free words must all appear somewhere.
 */
import { readiness } from "./links.js";
import {
  type ActivityItem,
  type DashboardView,
  type Deliverable,
  type Question,
  type Ticket,
  type TicketStatus,
  ticketFraction,
  workedMs,
} from "./progress.js";

export const SEARCH_KEYS = [
  "status",
  "is",
  "label",
  "agent",
  "stage",
  "ticket",
  "kind",
  "parent",
  "waits",
  "blocks",
  "has",
] as const;
export type SearchKey = (typeof SEARCH_KEYS)[number];

export interface SearchToken {
  key: SearchKey;
  value: string;
  negate: boolean;
}

export interface SearchQuery {
  tokens: SearchToken[];
  words: string[];
}

const TOKEN = /(-?)([a-z]+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/gi;

export function parseQuery(query: string): SearchQuery {
  const tokens: SearchToken[] = [];
  const words: string[] = [];
  for (const match of query.matchAll(TOKEN)) {
    const [, negate, key, quoted, bare, phrase, word] = match;
    const lower = key?.toLowerCase();
    if (lower && (SEARCH_KEYS as readonly string[]).includes(lower)) {
      const value = (quoted ?? bare ?? "").trim();
      if (value)
        tokens.push({
          key: lower as SearchKey,
          value: value.toLowerCase(),
          negate: negate === "-",
        });
    } else {
      const text = (phrase ?? word ?? match[0]).trim().toLowerCase();
      if (text) words.push(text);
    }
  }
  return { tokens, words };
}

function quote(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/** Whether the query has `key:value` (not negated). */
export function hasToken(
  query: string,
  key: SearchKey,
  value: string,
): boolean {
  return parseQuery(query).tokens.some(
    (token) =>
      token.key === key && !token.negate && token.value === value.toLowerCase(),
  );
}

/** Adds `key:value`, or removes it when present; for filter chips. */
export function toggleToken(
  query: string,
  key: SearchKey,
  value: string,
): string {
  if (hasToken(query, key, value)) {
    const pattern = new RegExp(
      `(^|\\s)${key}:(?:"${escape(value)}"|${escape(value)})(?=\\s|$)`,
      "gi",
    );
    return query.replace(pattern, " ").replace(/\s+/g, " ").trim();
  }
  return `${query.trim()} ${key}:${quote(value)}`.trim();
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SearchContext {
  /** Agent ids to names people see, for agent:name. */
  agentNames: ReadonlyMap<string, string>;
  now: number;
  /** The run's tickets by id, for links (is:ready, blocks:…). */
  byId: ReadonlyMap<string, Ticket>;
}

function agentMatches(
  agentIds: readonly (string | undefined)[],
  value: string,
  context: SearchContext,
): boolean {
  return agentIds.some((agentId) => {
    if (!agentId) return false;
    const name = context.agentNames.get(agentId)?.toLowerCase() ?? "";
    return agentId.toLowerCase().startsWith(value) || name.includes(value);
  });
}

/** ticket:AI-03, ticket:ai-3, and ticket:3 all name AI-03. */
function sameTicket(id: string, value: string): boolean {
  const number = (ref: string) => /(\d+)$/.exec(ref)?.[1];
  const lower = id.toLowerCase();
  if (lower === value) return true;
  const wanted = number(value);
  return (
    wanted !== undefined &&
    Number(wanted) === Number(number(lower)) &&
    (/^\d+$/.test(value) ||
      value.replace(/-?0*\d+$/, "") === lower.replace(/-?0*\d+$/, ""))
  );
}

const OPEN: readonly TicketStatus[] = ["working", "blocked"];

/** Whether a ticket is past its estimate and still open. */
export function isOverdue(ticket: Ticket, now: number): boolean {
  return (
    OPEN.includes(ticket.status) &&
    Boolean(ticket.estimate) &&
    workedMs(ticket, now) / 60_000 > (ticket.estimate ?? 0)
  );
}

function statusName(status: TicketStatus): string[] {
  return status === "not_started"
    ? ["not_started", "todo", "queued", "not-started"]
    : [status];
}

function ticketToken(
  ticket: Ticket,
  token: SearchToken,
  context: SearchContext,
): boolean {
  const { value } = token;
  switch (token.key) {
    case "status":
      return statusName(ticket.status).includes(value);
    case "is":
      if (value === "open" || value === "active")
        return OPEN.includes(ticket.status);
      if (value === "finished" || value === "closed")
        return ticket.status === "done" || ticket.status === "skipped";
      if (value === "overdue") return isOverdue(ticket, context.now);
      if (value === "waiting" || value === "ready")
        return readiness(ticket, context.byId) === value;
      return statusName(ticket.status).includes(value);
    case "parent":
      return ticket.parent ? sameTicket(ticket.parent, value) : false;
    case "waits":
      return (ticket.waitsFor ?? []).some((id) => sameTicket(id, value));
    case "blocks":
      // Tickets the named one waits for.
      return [...context.byId.values()].some(
        (other) =>
          sameTicket(other.id, value) &&
          (other.waitsFor ?? []).includes(ticket.id),
      );
    case "has":
      if (value === "children" || value === "subtasks")
        return [...context.byId.values()].some(
          (other) => other.parent === ticket.id,
        );
      if (value === "parent") return Boolean(ticket.parent);
      if (value === "waits") return Boolean(ticket.waitsFor?.length);
      if (value === "related") return Boolean(ticket.related?.length);
      return false;
    case "label":
      return (ticket.labels ?? []).some(
        (label) => label.toLowerCase() === value,
      );
    case "agent":
      return agentMatches(ticket.agents, value, context);
    case "stage":
      return (ticket.stage ?? "").toLowerCase().includes(value);
    case "ticket":
      return sameTicket(ticket.id, value);
    case "kind":
      return true;
  }
}

/** Tokens with the same key are ORed; different keys are ANDed; negated ones must all miss. */
function matchTokens(
  tokens: readonly SearchToken[],
  test: (token: SearchToken) => boolean,
): boolean {
  const groups = new Map<string, SearchToken[]>();
  for (const token of tokens) {
    if (token.negate) {
      if (test(token)) return false;
      continue;
    }
    groups.set(token.key, [...(groups.get(token.key) ?? []), token]);
  }
  return [...groups.values()].every((group) => group.some(test));
}

function hasWords(words: readonly string[], haystack: string): boolean {
  const text = haystack.toLowerCase();
  return words.every((word) => text.includes(word));
}

export function matchTicket(
  ticket: Ticket,
  query: SearchQuery,
  context: SearchContext,
): boolean {
  return (
    matchTokens(query.tokens, (token) => ticketToken(ticket, token, context)) &&
    hasWords(
      query.words,
      [
        ticket.id,
        ticket.title,
        ticket.stage,
        ticket.note,
        ...(ticket.labels ?? []),
      ].join(" "),
    )
  );
}

/** Ticket-scoped tokens on a feed entry go through its ticket; one without a ticket only passes kind, agent, and text. */
function feedToken(
  entry: { ticket?: string; by?: string[]; kind?: string },
  ticket: Ticket | undefined,
  token: SearchToken,
  context: SearchContext,
): boolean {
  switch (token.key) {
    case "ticket":
      return entry.ticket ? sameTicket(entry.ticket, token.value) : false;
    case "kind":
      return (entry.kind ?? "").toLowerCase() === token.value;
    case "agent":
      return agentMatches(entry.by ?? [], token.value, context);
    default:
      return ticket ? ticketToken(ticket, token, context) : false;
  }
}

export type FeedEntry =
  | { type: "activity"; item: ActivityItem }
  | { type: "question"; item: Question }
  | { type: "deliverable"; item: Deliverable };

function entryFields(entry: FeedEntry): {
  ticket?: string;
  by: string[];
  kind?: string;
  text: string;
} {
  switch (entry.type) {
    case "activity":
      return {
        ticket: entry.item.ticket,
        by: entry.item.by ? [entry.item.by] : [],
        kind: entry.item.kind,
        text: [entry.item.title, entry.item.body].join(" "),
      };
    case "question": {
      const question = entry.item;
      return {
        ticket: question.ticket,
        by: [question.by, question.answer?.by].filter((by): by is string =>
          Boolean(by),
        ),
        text: [
          question.id,
          question.title,
          question.text,
          question.answer?.words,
          ...question.options.map((option) => option.label),
        ].join(" "),
      };
    }
    case "deliverable":
      return {
        ticket: entry.item.ticket,
        by: [],
        text: [entry.item.id, entry.item.label, entry.item.target].join(" "),
      };
  }
}

export function matchFeed(
  entry: FeedEntry,
  query: SearchQuery,
  tickets: ReadonlyMap<string, Ticket>,
  context: SearchContext,
): boolean {
  const fields = entryFields(entry);
  const ticket = fields.ticket ? tickets.get(fields.ticket) : undefined;
  return (
    matchTokens(query.tokens, (token) =>
      feedToken(fields, ticket, token, context),
    ) &&
    hasWords(query.words, [fields.text, fields.ticket, ticket?.title].join(" "))
  );
}

export type TicketSort = DashboardView["ticketSort"];

export const TICKET_SORTS: readonly { id: TicketSort; label: string }[] = [
  { id: "recent", label: "Recent activity" },
  { id: "status", label: "Status" },
  { id: "eta", label: "Most overdue" },
  { id: "created", label: "Created" },
  { id: "percent", label: "Percent" },
];

const STATUS_ORDER: Record<TicketStatus, number> = {
  blocked: 0,
  working: 1,
  not_started: 2,
  done: 3,
  skipped: 4,
};

/** When anything last happened on a ticket: a change or a feed entry tagged to it. */
export function lastTouched(
  ticket: Ticket,
  activity: readonly ActivityItem[],
): number {
  return Math.max(
    Date.parse(ticket.updatedAt),
    ...ticket.history.map((change) => Date.parse(change.ts)),
    ...activity
      .filter((item) => item.ticket === ticket.id)
      .map((item) => Date.parse(item.ts)),
  );
}

/** Minutes left before the estimate (negative once over); open tickets without one sort last. */
function minutesLeft(ticket: Ticket, now: number): number {
  if (!OPEN.includes(ticket.status) && ticket.status !== "not_started")
    return Number.POSITIVE_INFINITY;
  if (!ticket.estimate) return Number.MAX_SAFE_INTEGER;
  return ticket.estimate - workedMs(ticket, now) / 60_000;
}

export function sortTickets<T extends Ticket>(
  tickets: readonly T[],
  sort: TicketSort,
  now: number,
  activity: readonly ActivityItem[],
): T[] {
  const created = (ticket: Ticket) =>
    Date.parse(ticket.history[0]?.ts ?? ticket.updatedAt);
  const byCreated = (a: Ticket, b: Ticket) =>
    created(a) - created(b) || a.id.localeCompare(b.id);
  const touched = new Map(
    tickets.map((ticket) => [ticket.id, lastTouched(ticket, activity)]),
  );
  const compare: Record<TicketSort, (a: T, b: T) => number> = {
    recent: (a, b) =>
      (touched.get(b.id) ?? 0) - (touched.get(a.id) ?? 0) || byCreated(a, b),
    status: (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byCreated(a, b),
    eta: (a, b) => minutesLeft(a, now) - minutesLeft(b, now) || byCreated(a, b),
    created: byCreated,
    percent: (a, b) =>
      ticketFraction(b, now, tickets) - ticketFraction(a, now, tickets) ||
      byCreated(a, b),
  };
  return [...tickets].sort(compare[sort]);
}

export const TICKET_PAGE = 8;

/**
 * What the Tickets card lists: open tickets (working, blocked) first, then the rest, each in the
 * chosen order. Finished tickets fold into one group once there are 2+ of them beside others.
 * The first `limit` unfinished tickets show; `more` counts the rest.
 */
export function ticketPage<T extends Ticket>(
  sorted: readonly T[],
  limit: number,
): { shown: T[]; more: number; finished: T[] } {
  const settled = sorted.filter(
    (ticket) => ticket.status === "done" || ticket.status === "skipped",
  );
  const fold = settled.length >= 2 && settled.length < sorted.length;
  const rest = fold
    ? sorted.filter((ticket) => !settled.includes(ticket))
    : [...sorted];
  const ordered = [
    ...rest.filter((ticket) => OPEN.includes(ticket.status)),
    ...rest.filter((ticket) => !OPEN.includes(ticket.status)),
  ];
  return {
    shown: ordered.slice(0, limit),
    more: Math.max(0, ordered.length - limit),
    finished: fold ? settled : [],
  };
}

/** One value a filter can take, with how many items have it. */
export interface FacetValue {
  value: string;
  label?: string;
  count: number;
  /** For agent values: the id, so the UI can show its chip. */
  agentId?: string;
}

/** A filter key with the values present in the data, for menus and suggestions. */
export interface Facet {
  key: SearchKey;
  label: string;
  hint: string;
  values: FacetValue[];
}

function countValues(
  values: Iterable<string>,
  extra: (value: string) => Partial<FacetValue> = () => ({}),
): FacetValue[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, count, ...extra(value) }));
}

const STATUS_LABELS: Record<TicketStatus, string> = {
  working: "Working",
  blocked: "Blocked",
  not_started: "Not started",
  done: "Done",
  skipped: "Skipped",
};

/** Filters for the Tickets search, from the run's tickets. */
export function ticketFacets(
  tickets: readonly Ticket[],
  agentName: (agentId: string) => string,
  now: number,
): Facet[] {
  const ids = new Map<string, string>();
  for (const ticket of tickets)
    for (const agentId of ticket.agents) ids.set(agentName(agentId), agentId);
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const titled = (value: string) => ({ label: byId.get(value)?.title });
  const has = [
    ["children", (t: Ticket) => tickets.some((other) => other.parent === t.id)],
    ["parent", (t: Ticket) => Boolean(t.parent)],
    ["waits", (t: Ticket) => Boolean(t.waitsFor?.length)],
    ["related", (t: Ticket) => Boolean(t.related?.length)],
  ] as const;
  const is = [
    ["open", (t: Ticket) => OPEN.includes(t.status)],
    ["blocked", (t: Ticket) => t.status === "blocked"],
    ["overdue", (t: Ticket) => isOverdue(t, now)],
    ["ready", (t: Ticket) => readiness(t, byId) === "ready"],
    ["waiting", (t: Ticket) => readiness(t, byId) === "waiting"],
    ["finished", (t: Ticket) => t.status === "done" || t.status === "skipped"],
  ] as const;
  return [
    {
      key: "status",
      label: "Status",
      hint: "working, blocked, done…",
      values: countValues(
        tickets.map((ticket) => ticket.status),
        (value) => ({ label: STATUS_LABELS[value as TicketStatus] }),
      ),
    },
    {
      key: "label",
      label: "Label",
      hint: "a ticket label",
      values: countValues(tickets.flatMap((ticket) => ticket.labels ?? [])),
    },
    {
      key: "agent",
      label: "Agent",
      hint: "who works it",
      values: countValues(
        tickets.flatMap((ticket) => ticket.agents.map(agentName)),
        (value) => ({ agentId: ids.get(value) }),
      ),
    },
    {
      key: "is",
      label: "Is",
      hint: "open, overdue, waiting…",
      values: is
        .map(([value, test]) => ({
          value,
          count: tickets.filter(test).length,
        }))
        .filter((entry) => entry.count > 0),
    },
    {
      key: "stage",
      label: "Stage",
      hint: "Build, Review…",
      values: countValues(
        tickets.flatMap((ticket) => (ticket.stage ? [ticket.stage] : [])),
      ),
    },
    {
      key: "parent",
      label: "Parent",
      hint: "sub-tasks of a ticket",
      values: countValues(
        tickets.flatMap((ticket) => (ticket.parent ? [ticket.parent] : [])),
        titled,
      ),
    },
    {
      key: "waits",
      label: "Waits for",
      hint: "tickets waiting on one",
      values: countValues(
        tickets.flatMap((ticket) => ticket.waitsFor ?? []),
        titled,
      ),
    },
    {
      key: "blocks",
      label: "Blocks",
      hint: "what a ticket waits for",
      values: tickets
        .filter((ticket) => ticket.waitsFor?.length)
        .map((ticket) => ({
          value: ticket.id,
          label: ticket.title,
          count: ticket.waitsFor?.length ?? 0,
        })),
    },
    {
      key: "has",
      label: "Has",
      hint: "children, parent, waits…",
      values: has
        .map(([value, test]) => ({
          value,
          count: tickets.filter(test).length,
        }))
        .filter((entry) => entry.count > 0),
    },
    {
      key: "ticket",
      label: "Ticket",
      hint: "one ticket",
      values: tickets.map((ticket) => ({
        value: ticket.id,
        label: ticket.title,
        count: 1,
      })),
    },
  ];
}

/** Filters for the feed, from its entries and their tickets. */
export function feedFacets(
  entries: readonly FeedEntry[],
  tickets: ReadonlyMap<string, Ticket>,
  agentName: (agentId: string) => string,
): Facet[] {
  const fields = entries.map(entryFields);
  const ids = new Map<string, string>();
  for (const field of fields)
    for (const agentId of field.by) ids.set(agentName(agentId), agentId);
  return [
    {
      key: "kind",
      label: "Kind",
      hint: "feat, fix, test…",
      values: countValues(
        fields.flatMap((field) => (field.kind ? [field.kind] : [])),
      ),
    },
    {
      key: "label",
      label: "Label",
      hint: "its ticket's label",
      values: countValues(
        fields.flatMap((field) =>
          field.ticket ? (tickets.get(field.ticket)?.labels ?? []) : [],
        ),
      ),
    },
    {
      key: "agent",
      label: "Agent",
      hint: "who wrote it",
      values: countValues(
        fields.flatMap((field) => field.by.map(agentName)),
        (value) => ({ agentId: ids.get(value) }),
      ),
    },
    {
      key: "ticket",
      label: "Ticket",
      hint: "one ticket",
      values: countValues(
        fields.flatMap((field) => (field.ticket ? [field.ticket] : [])),
        (value) => ({ label: tickets.get(value)?.title }),
      ),
    },
  ];
}

/**
 * How well `needle` matches `hay`: prefix beats word start beats substring beats an in-order
 * subsequence (so "nr" finds "needs review"). null when it doesn't match at all.
 */
export function fuzzyScore(needle: string, hay: string): number | null {
  const query = needle.toLowerCase();
  const text = hay.toLowerCase();
  if (!query) return 0;
  if (text.startsWith(query)) return 0;
  const index = text.indexOf(query);
  if (index > 0 && /[\s_:-]/.test(text[index - 1] ?? "")) return 1;
  if (index > 0) return 2;
  let at = 0;
  let gaps = 0;
  for (const char of query) {
    const found = text.indexOf(char, at);
    if (found < 0) return null;
    gaps += found - at;
    at = found + 1;
  }
  return 3 + gaps / 100;
}

/** Where each whitespace-separated token sits, quotes kept together. */
export function querySpans(query: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let start = -1;
  let quoted = false;
  for (let index = 0; index <= query.length; index += 1) {
    const char = query[index];
    if (char === '"') quoted = !quoted;
    const space = char === undefined || (/\s/.test(char) && !quoted);
    if (space) {
      if (start >= 0) spans.push({ start, end: index });
      start = -1;
    } else if (start < 0) start = index;
  }
  return spans;
}

/** The token around the caret, or an empty one at the caret. */
export function tokenAt(
  query: string,
  caret: number,
): { start: number; end: number; text: string } {
  const span = querySpans(query).find(
    (candidate) => caret >= candidate.start && caret <= candidate.end,
  ) ?? { start: caret, end: caret };
  return { ...span, text: query.slice(span.start, span.end) };
}

/** The query without one filter token, for the ✕ on an active filter chip. */
export function removeToken(query: string, target: SearchToken): string {
  return querySpans(query)
    .map((span) => query.slice(span.start, span.end))
    .filter((text) => {
      const token = parseQuery(text).tokens[0];
      return !(
        token &&
        token.key === target.key &&
        token.value === target.value &&
        token.negate === target.negate
      );
    })
    .join(" ");
}

export type Suggestion =
  | { type: "key"; key: SearchKey | "sort"; label: string; hint: string }
  | {
      type: "value";
      key: SearchKey;
      value: string;
      label?: string;
      count: number;
      agentId?: string;
    }
  | { type: "sort"; sort: TicketSort; label: string };

const MAX_SUGGESTIONS = 8;

/**
 * What to offer while typing: filter keys for a bare word (keys first, then matching values of any
 * key), and the values of a key once `key:` is typed. `sorts` adds `sort:` to ticket search.
 */
export function suggest(
  query: string,
  caret: number,
  facets: readonly Facet[],
  sorts: readonly { id: TicketSort; label: string }[] = [],
): { token: { start: number; end: number }; items: Suggestion[] } {
  const token = tokenAt(query, caret);
  const text = token.text.replace(/^-/, "");
  const colon = text.indexOf(":");
  const rank = <T>(items: T[], score: (item: T) => number | null): T[] =>
    items
      .map((item) => ({ item, score: score(item) }))
      .filter(
        (entry): entry is { item: T; score: number } => entry.score !== null,
      )
      .sort((a, b) => a.score - b.score)
      .map((entry) => entry.item);
  if (colon >= 0) {
    const key = text.slice(0, colon).toLowerCase();
    const partial = text.slice(colon + 1).replace(/^"|"$/g, "");
    if (key === "sort" && sorts.length)
      return {
        token,
        items: rank([...sorts], (sort) =>
          minScore(partial, [sort.id, sort.label]),
        ).map((sort) => ({ type: "sort", sort: sort.id, label: sort.label })),
      };
    const facet = facets.find((candidate) => candidate.key === key);
    if (!facet) return { token, items: [] };
    const taken = parseQuery(
      query.slice(0, token.start) + query.slice(token.end),
    ).tokens;
    return {
      token,
      items: rank(
        facet.values.filter(
          (value) =>
            !taken.some(
              (used) =>
                used.key === facet.key &&
                used.value === value.value.toLowerCase(),
            ),
        ),
        (value) => minScore(partial, [value.value, value.label ?? ""]),
      )
        .slice(0, MAX_SUGGESTIONS)
        .map((value) => ({ type: "value", key: facet.key, ...value })),
    };
  }
  const keys: Suggestion[] = [
    ...facets
      .filter((facet) => facet.values.length)
      .map((facet) => ({
        type: "key" as const,
        key: facet.key,
        label: `${facet.key}:`,
        hint: facet.hint,
      })),
    ...(sorts.length
      ? [
          {
            type: "key" as const,
            key: "sort" as const,
            label: "sort:",
            hint: "order the list",
          },
        ]
      : []),
  ];
  const keyHits = rank(keys, (item) =>
    item.type === "key" ? fuzzyScore(text, item.key) : null,
  );
  if (!text) return { token, items: keyHits };
  // A bare word may also be a value: "ui" offers label:ui.
  const values = rank(
    facets
      .filter((facet) => facet.key !== "ticket" && facet.key !== "stage")
      .flatMap((facet) =>
        facet.values.map((value) => ({
          type: "value" as const,
          key: facet.key,
          ...value,
        })),
      ),
    (value) => {
      const score = minScore(text, [value.value, value.label ?? ""]);
      return score !== null && score < 3 ? score : null;
    },
  );
  return { token, items: [...keyHits, ...values].slice(0, MAX_SUGGESTIONS) };
}

function minScore(needle: string, hays: readonly string[]): number | null {
  const scores = hays
    .filter(Boolean)
    .map((hay) => fuzzyScore(needle, hay))
    .filter((score): score is number => score !== null);
  return scores.length ? Math.min(...scores) : null;
}

/** The query with the token replaced by the picked suggestion, and where the caret goes next. */
export function applySuggestion(
  query: string,
  token: { start: number; end: number },
  pick: Suggestion,
): { query: string; caret: number } {
  const negate = query.slice(token.start, token.end).startsWith("-") ? "-" : "";
  if (pick.type === "sort") {
    const rest = `${query.slice(0, token.start)}${query.slice(token.end)}`
      .replace(/\s+/g, " ")
      .trim();
    return { query: rest, caret: rest.length };
  }
  const insert =
    pick.type === "key"
      ? `${negate}${pick.key}:`
      : `${negate}${pick.key}:${quote(pick.value)} `;
  const before = query.slice(0, token.start);
  const after = query.slice(token.end).replace(/^\s+/, "");
  const next = `${before}${insert}${after}`;
  return { query: next, caret: before.length + insert.length };
}
