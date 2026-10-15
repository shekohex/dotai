import { describe, expect, it } from "vitest";

import { type ProgressEvent, reduceProgress } from "./progress.js";
import {
  applySuggestion,
  feedFacets,
  fuzzyScore,
  hasToken,
  matchFeed,
  matchTicket,
  parseQuery,
  removeToken,
  sortTickets,
  suggest,
  TICKET_PAGE,
  TICKET_SORTS,
  ticketFacets,
  ticketPage,
  toggleToken,
} from "./search.js";

const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 16, 10, 0) + minute * 60_000).toISOString();
const ev = (minute: number, fields: Partial<ProgressEvent>, by?: string) =>
  ({
    v: 1,
    ts: at(minute),
    op: "ticket",
    ...fields,
    ...(by ? { by } : {}),
  }) as ProgressEvent;
const id = (n: number) => `T${String(n).padStart(2, "0")}`;

/** A throwaway run with 30 tickets: 6 working, 3 blocked, 12 done, 2 skipped, 7 queued. */
function fixture() {
  const events: ProgressEvent[] = [ev(0, { op: "start", title: "Big run" })];
  for (let n = 1; n <= 30; n += 1)
    events.push(
      ev(n, {
        id: id(n),
        title: `Ticket ${n}: ${n % 3 ? "Wire the API" : "Polish the UI"}`,
        estimate: 30,
        labels: n % 3 ? ["api"] : ["ui", "needs review"],
      }),
    );
  const agent = (n: number) => `agent-${n % 4}`;
  for (let n = 1; n <= 23; n += 1)
    events.push(
      ev(40 + n, { id: id(n), status: "working", stage: "Build" }, agent(n)),
    );
  for (let n = 1; n <= 12; n += 1)
    events.push(ev(70 + n, { id: id(n), status: "done" }, agent(n)));
  for (const n of [13, 14])
    events.push(ev(85, { id: id(n), status: "skipped" }, agent(n)));
  for (const n of [15, 16, 17])
    events.push(
      ev(86, { id: id(n), status: "blocked", note: "Waits on keys" }, agent(n)),
    );
  events.push(ev(90, { id: id(18), stage: "Review" }, agent(18)));
  events.push(
    ev(91, { op: "ticker", ticket: id(20), text: "Testing", kind: "test" }),
  );
  return reduceProgress(events)!;
}

const now = Date.parse(at(120));
const context = {
  now,
  byId: new Map(fixture().tickets.map((ticket) => [ticket.id, ticket])),
  agentNames: new Map([
    ["agent-1", "Ada"],
    ["agent-2", "Grace"],
  ]),
};

describe("parseQuery", () => {
  it("splits tokens, quoted values, negation, and words", () => {
    expect(
      parseQuery(
        'status:working label:"needs review" -agent:ada wire "the api"',
      ),
    ).toEqual({
      tokens: [
        { key: "status", value: "working", negate: false },
        { key: "label", value: "needs review", negate: false },
        { key: "agent", value: "ada", negate: true },
      ],
      words: ["wire", "the api"],
    });
    expect(parseQuery("http://x foo:bar").words).toEqual([
      "http://x",
      "foo:bar",
    ]);
  });

  it("toggles chip tokens in and out of the query", () => {
    const added = toggleToken("wire", "label", "needs review");
    expect(added).toBe('wire label:"needs review"');
    expect(hasToken(added, "label", "Needs Review")).toBe(true);
    expect(toggleToken(added, "label", "needs review")).toBe("wire");
  });
});

describe("ticket search on 30 tickets", () => {
  const state = fixture();
  const find = (query: string) =>
    state.tickets
      .filter((ticket) => matchTicket(ticket, parseQuery(query), context))
      .map((ticket) => ticket.id);

  it("filters by status, is:, label, agent name, stage, and words", () => {
    expect(find("status:working")).toHaveLength(6);
    expect(find("is:blocked")).toEqual([id(15), id(16), id(17)]);
    expect(find("is:open")).toHaveLength(9);
    expect(find('label:"needs review" is:open')).toEqual([
      id(15),
      id(18),
      id(21),
    ]);
    expect(find("agent:ada is:open")).toEqual([id(17), id(21)]);
    expect(find("stage:review")).toEqual([id(18)]);
    expect(find("polish -is:finished")).toHaveLength(6);
    expect(find("status:blocked status:skipped")).toHaveLength(5);
    expect(find("ticket:7")).toEqual([id(7)]);
  });

  it("flags overdue tickets past their estimate", () => {
    // Working ones all ran past 30m; of the blocked ones only T15 worked over 30m before blocking.
    expect(find("is:overdue")).toEqual([
      id(15),
      ...[18, 19, 20, 21, 22, 23].map(id),
    ]);
  });

  it("sorts and pages with open tickets first and finished folded", () => {
    const sorted = sortTickets(state.tickets, "recent", now, state.activity);
    const page = ticketPage(sorted, TICKET_PAGE);
    expect(page.finished).toHaveLength(14);
    expect(page.shown).toHaveLength(TICKET_PAGE);
    expect(page.more).toBe(16 - TICKET_PAGE);
    expect(
      page.shown
        .slice(0, 9 > TICKET_PAGE ? TICKET_PAGE : 9)
        .every(
          (ticket) =>
            ticket.status === "working" || ticket.status === "blocked",
        ),
    ).toBe(true);
    expect(page.shown[0]?.id).toBe(id(20));
    expect(
      sortTickets(state.tickets, "status", now, []).map((t) => t.status)[0],
    ).toBe("blocked");
    expect(sortTickets(state.tickets, "created", now, [])[0]?.id).toBe(id(1));
    const eta = sortTickets(state.tickets, "eta", now, []);
    expect(eta[0]?.id).toBe(id(18));
    expect(eta.at(-1)?.status).toMatch(/done|skipped/);
  });

  it("folds finished tickets only beside open ones, and only 2+", () => {
    const [open, done, skipped] = [
      state.tickets[20]!,
      state.tickets[0]!,
      state.tickets[12]!,
    ];
    expect(ticketPage([done, open], 8).finished).toEqual([]);
    expect(ticketPage([done, skipped, open], 8).finished).toHaveLength(2);
    expect(ticketPage([done, skipped], 8).finished).toEqual([]);
  });

  it("finds feed entries by ticket, kind, agent, and ticket fields", () => {
    const tickets = new Map(state.tickets.map((ticket) => [ticket.id, ticket]));
    const feed = (query: string) =>
      state.activity.filter((item) =>
        matchFeed(
          { type: "activity", item },
          parseQuery(query),
          tickets,
          context,
        ),
      );
    expect(feed("kind:test")).toHaveLength(1);
    expect(feed("ticket:20")).toHaveLength(1);
    expect(feed("is:blocked")).toHaveLength(3);
    expect(feed("label:ui waits")).toHaveLength(1);
  });
});

describe("suggestions", () => {
  const state = fixture();
  const names = (agentId: string) => context.agentNames.get(agentId) ?? agentId;
  const facets = ticketFacets(state.tickets, names, now);
  const labels = (query: string, caret = query.length) =>
    suggest(query, caret, facets, TICKET_SORTS).items.map((item) =>
      item.type === "key"
        ? item.label
        : item.type === "sort"
          ? `sort:${item.sort}`
          : `${item.key}:${item.value}(${item.count})`,
    );

  it("ranks fuzzy matches: prefix, word start, substring, subsequence", () => {
    expect(fuzzyScore("ne", "needs review")).toBe(0);
    expect(fuzzyScore("rev", "needs review")).toBe(1);
    expect(fuzzyScore("eed", "needs review")).toBe(2);
    expect(fuzzyScore("nr", "needs review")).toBeGreaterThan(3);
    expect(fuzzyScore("zz", "needs review")).toBeNull();
  });

  it("offers keys first, then values of the typed key with counts", () => {
    expect(labels("")).toEqual([
      "status:",
      "label:",
      "agent:",
      "is:",
      "stage:",
      "ticket:",
      "sort:",
    ]);
    expect(labels("lab")).toEqual(["label:"]);
    expect(labels("label:")).toEqual([
      "label:api(20)",
      "label:needs review(10)",
      "label:ui(10)",
    ]);
    expect(labels("label:nr")).toEqual(["label:needs review(10)"]);
    expect(labels("agent:ad")).toEqual(["agent:Ada(6)"]);
    expect(labels("sort:over")).toEqual(["sort:eta"]);
    // A bare word that names a value offers it too.
    expect(labels("ui")).toContain("label:ui(10)");
  });

  it("skips values already in the query and works mid-query", () => {
    expect(labels("label:ui label:")).not.toContain("label:ui(10)");
    const query = "is:open lab wire";
    expect(labels(query, 10)).toEqual(["label:"]);
  });

  it("replaces the token at the caret and keeps negation", () => {
    const query = "is:open -lab wire";
    const { token, items } = suggest(query, 12, facets);
    const key = applySuggestion(query, token, items[0]!);
    expect(key).toEqual({ query: "is:open -label:wire", caret: 15 });
    const typed = "is:open -label:need wire";
    const pick = suggest(typed, 19, facets);
    expect(applySuggestion(typed, pick.token, pick.items[0]!)).toEqual({
      query: 'is:open -label:"needs review" wire',
      caret: 30,
    });
    const sort = suggest("x sort:eta", 10, facets, TICKET_SORTS);
    expect(
      applySuggestion("x sort:eta", sort.token, sort.items[0]!).query,
    ).toBe("x");
  });

  it("builds feed facets from entries and their tickets", () => {
    const tickets = new Map(state.tickets.map((ticket) => [ticket.id, ticket]));
    const facets = feedFacets(
      state.activity.map((item) => ({ type: "activity" as const, item })),
      tickets,
      names,
    );
    expect(facets.find((facet) => facet.key === "kind")?.values).toEqual([
      { value: "test", count: 1 },
    ]);
  });
});

describe("removeToken", () => {
  it("drops one filter and keeps the rest of the query", () => {
    expect(
      removeToken('wire label:"needs review" -is:done', {
        key: "label",
        value: "needs review",
        negate: false,
      }),
    ).toBe("wire -is:done");
  });
});

describe("link search", () => {
  const state = reduceProgress([
    ev(0, { op: "start", title: "Run" }),
    ev(1, { id: "T01", title: "Epic" }),
    ev(1, { id: "T02", title: "Part A", parent: "T01" }),
    ev(1, { id: "T03", title: "Part B", parent: "T01", waitsFor: ["T02"] }),
    ev(1, { id: "T04", title: "Done first" }),
    ev(2, { id: "T04", status: "done" }),
    ev(2, { id: "T05", title: "Next", waitsFor: ["T04"] }),
  ])!;
  const links = {
    ...context,
    byId: new Map(state.tickets.map((ticket) => [ticket.id, ticket])),
  };
  const find = (query: string) =>
    state.tickets
      .filter((ticket) => matchTicket(ticket, parseQuery(query), links))
      .map((ticket) => ticket.id);

  it("filters by parent, waits, blocks, has, and readiness", () => {
    expect(find("parent:1")).toEqual(["T02", "T03"]);
    expect(find("waits:T02")).toEqual(["T03"]);
    expect(find("blocks:3")).toEqual(["T02"]);
    expect(find("has:children")).toEqual(["T01"]);
    expect(find("is:waiting")).toEqual(["T03"]);
    expect(find("is:ready")).toEqual(["T05"]);
  });

  it("suggests link keys once the run has links", () => {
    const keys = suggest(
      "",
      0,
      ticketFacets(state.tickets, (id) => id, now),
    ).items.map((item) => (item.type === "key" ? item.key : ""));
    expect(keys).toEqual(
      expect.arrayContaining(["parent", "waits", "blocks", "has"]),
    );
  });
});
