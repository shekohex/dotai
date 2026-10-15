import { describe, expect, it } from "vitest";

import { buildDashboard, ticketTimeline } from "./dashboard.js";
import {
  displayState,
  displayTicketId,
  overallProgress,
  parseTicketId,
  type ProgressEvent,
  reduceProgress,
  ticketFraction,
  ticketPrefixSchema,
} from "./progress.js";

const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 16, 10, minute)).toISOString();
const ev = (minute: number, fields: Partial<ProgressEvent>, by?: string) =>
  ({
    v: 1,
    ts: at(minute),
    op: "ticket",
    ...fields,
    ...(by ? { by } : {}),
  }) as ProgressEvent;

describe("activity entries", () => {
  it("keep a title, body, and kind, falling back to the body's first line", () => {
    const state = reduceProgress([
      ev(0, { op: "start", title: "Run" }),
      ev(1, {
        id: "T01",
        title: "Table",
        note: "Sorting works",
        body: "Added a comparator.\nCovers dates.",
        kind: "feat",
      }),
      ev(2, { op: "ticker", text: "", body: "Reading the spec\nmore" }),
    ])!;
    expect(state.activity[0]).toMatchObject({
      title: "Sorting works",
      body: "Added a comparator.\nCovers dates.",
      kind: "feat",
      ticket: "T01",
    });
    expect(state.activity[1]?.title).toBe("Reading the spec");
    expect(state.ticker?.text).toBe("Reading the spec");
  });
});

describe("tickets", () => {
  it("take labels, and [] clears them", () => {
    const labels = (events: ProgressEvent[]) =>
      reduceProgress(events)!.tickets[0]?.labels;
    const base = [
      ev(0, { op: "start", title: "Run" }),
      ev(1, { id: "T01", title: "A", labels: ["ui", " ui ", "api"] }),
    ];
    expect(labels(base)).toEqual(["ui", "api"]);
    expect(labels([...base, ev(2, { id: "T01", labels: [] })])).toBeUndefined();
  });

  it("let one agent work several tickets and several agents one ticket", () => {
    const state = reduceProgress([
      ev(0, { op: "start", title: "Run" }),
      ev(1, { id: "T01", title: "A" }),
      ev(1, { id: "T02", title: "B" }),
      ev(2, { id: "T01", status: "working" }, "w1"),
      ev(2, { id: "T02", status: "working" }, "w1"),
      ev(3, { id: "T01", agent: "w2" }, "conductor"),
      ev(4, { id: "T02", status: "working" }, "user"),
    ])!;
    expect(state.tickets.map((ticket) => ticket.agents)).toEqual([
      ["w1", "w2"],
      ["w1"],
    ]);
  });

  it("record revised estimates and percent, also from a ticker line", () => {
    const state = reduceProgress([
      ev(0, { op: "start", title: "Run" }),
      ev(1, { id: "T01", title: "A", estimate: 30 }),
      ev(2, { id: "T01", status: "working", percent: 10 }, "w1"),
      ev(5, { id: "T01", estimate: 60, note: "Bigger than it looked" }, "w1"),
      ev(6, { op: "ticker", text: "Halfway", ticket: "T01", percent: 50 }),
    ])!;
    const ticket = state.tickets[0]!;
    expect(ticket).toMatchObject({ estimate: 60, percent: 50 });
    const events = ticketTimeline(ticket, Date.parse(at(7)), state.activity)
      .flatMap((step) => step.events)
      .map((event) =>
        event.type === "estimate"
          ? `eta ${event.from}->${event.to}`
          : event.type === "percent"
            ? `${event.percent}%`
            : event.item.title,
      );
    expect(events).toEqual([
      "10%",
      "eta 30->60",
      "Bigger than it looked",
      "50%",
      "Halfway",
    ]);
  });
});

describe("progress", () => {
  const run = (extra: ProgressEvent[]) =>
    reduceProgress([
      ev(0, { op: "start", title: "Run" }),
      ev(0, { id: "T01", title: "Long one", estimate: 100 }),
      ev(0, { id: "T02", title: "Short", estimate: 20 }),
      ...extra,
    ])!;

  it("moves with working time while nothing is done, capped below done", () => {
    const state = run([ev(0, { id: "T01", status: "working" })]);
    const ticket = state.tickets[0]!;
    expect(ticketFraction(ticket, Date.parse(at(50)))).toBeCloseTo(0.5);
    expect(ticketFraction(ticket, Date.parse(at(0)) + 200 * 60_000)).toBe(0.9);
    expect(overallProgress(state.tickets, Date.parse(at(50))).percent).toBe(42);
    expect(
      buildDashboard(state, Date.parse(at(50))).progress.segments[0]?.fraction,
    ).toBeCloseTo(0.5);
  });

  it("prefers the agent's percent and counts only working spells", () => {
    const state = run([
      ev(0, { id: "T01", status: "working" }),
      ev(10, { id: "T01", status: "blocked" }),
    ]);
    expect(ticketFraction(state.tickets[0]!, Date.parse(at(50)))).toBeCloseTo(
      0.1,
    );
    const reported = run([
      ev(0, { id: "T01", status: "working", percent: 70 }),
    ]);
    expect(overallProgress(reported.tickets, Date.parse(at(1))).percent).toBe(
      58,
    );
  });

  it("shows 100% only when every ticket is done", () => {
    const state = run([
      ev(0, { id: "T01", status: "done" }),
      ev(0, { id: "T02", status: "working", percent: 100 }),
    ]);
    expect(overallProgress(state.tickets, Date.parse(at(1))).percent).toBe(99);
  });
});

describe("ticket prefix", () => {
  it("validates 1-3 letters or digits and keeps Q, S, and D free", () => {
    expect(ticketPrefixSchema.parse(" ai ")).toBe("AI");
    expect(ticketPrefixSchema.safeParse("ABCD").success).toBe(false);
    expect(ticketPrefixSchema.safeParse("A-1").success).toBe(false);
    expect(ticketPrefixSchema.safeParse("q").success).toBe(false);
  });

  it("shows stored ids with the prefix and reads them back", () => {
    expect(displayTicketId("T03", "AI")).toBe("AI-03");
    expect(displayTicketId("T03", "T")).toBe("T03");
    expect(displayTicketId("Q3", "AI")).toBe("Q3");
    for (const ref of ["AI-03", "ai3", "3", "T03", " AI-3 "])
      expect(parseTicketId(ref, "AI")).toBe("T03");
    expect(parseTicketId("Q3", "AI")).toBeUndefined();
    expect(parseTicketId("BX-3", "AI")).toBeUndefined();
  });

  it("relabels a run's tickets and references for the app", () => {
    const state = reduceProgress([
      ev(0, { op: "start", title: "Run" }),
      ev(1, { id: "T01", title: "A" }),
      ev(1, { id: "T02", title: "B", waitsFor: ["T01"] }),
      ev(2, { op: "deliver", id: "D1", target: "/tmp/a.png", ticket: "T02" }),
    ])!;
    const shown = displayState(state, "AI");
    expect(shown.tickets.map((ticket) => ticket.id)).toEqual([
      "AI-01",
      "AI-02",
    ]);
    expect(shown.tickets[1]?.waitsFor).toEqual(["AI-01"]);
    expect(shown.deliverables[0]?.ticket).toBe("AI-02");
    expect(displayState(state, "T")).toBe(state);
  });

  it("needs the dash after a prefix ending in a digit", () => {
    expect(parseTicketId("V2-3", "V2")).toBe("T03");
    expect(parseTicketId("23", "V2")).toBe("T23");
  });
});

describe("blocked and stuck lifecycle", () => {
  const base = [
    ev(0, { op: "start", title: "Run" }),
    ev(1, { id: "T01", title: "A" }),
    ev(2, { id: "T01", status: "working" }, "w1"),
    ev(3, { id: "T01", status: "blocked", note: "Needs keys" }, "w1"),
  ];
  const ticket = (events: ProgressEvent[]) =>
    reduceProgress(events)!.tickets[0]!;

  it("unblocks a ticket when its question is answered, by anyone", () => {
    const state = reduceProgress([
      ...base,
      ev(
        4,
        {
          op: "ask",
          id: "Q1",
          title: "Keys?",
          text: "Which?",
          options: [],
          ticket: "T01",
        },
        "w1",
      ),
      ev(9, { op: "answer", id: "Q1", choice: "A" }, "c1"),
    ])!;
    expect(state.tickets[0]?.status).toBe("working");
    expect(state.tickets[0]?.history.at(-1)).toMatchObject({
      status: "working",
      note: "Unblocked by answer Q1",
    });
    expect(state.activity.at(-1)?.title).toBe("Unblocked by answer Q1");
  });

  it("goes back to working when the owner posts an update without status", () => {
    expect(
      ticket([...base, ev(5, { id: "T01", stage: "Review" }, "w1")]).status,
    ).toBe("working");
    expect(
      ticket([
        ...base,
        ev(5, { op: "ticker", ticket: "T01", text: "On it" }, "w1"),
      ]).status,
    ).toBe("working");
    expect(
      ticket([
        ...base,
        ev(5, { id: "T01", percent: 50, status: "blocked" }, "w1"),
      ]).status,
    ).toBe("blocked");
    // Someone else's update, or a relabel, leaves it blocked.
    expect(
      ticket([...base, ev(5, { id: "T01", stage: "Review" }, "w2")]).status,
    ).toBe("blocked");
    expect(
      ticket([...base, ev(5, { id: "T01", labels: ["ui"] }, "w1")]).status,
    ).toBe("blocked");
  });

  it("clears a stuck flag on unstuck or the raiser's next normal update", () => {
    const flagged = [
      ...base.slice(0, 3),
      ev(4, { op: "stuck", id: "S1", text: "CI down", ticket: "T01" }, "w1"),
    ];
    const open = (events: ProgressEvent[]) =>
      reduceProgress(events)!.stuck.filter((flag) => !flag.resolved).length;
    expect(open(flagged)).toBe(1);
    expect(open([...flagged, ev(5, { op: "unstuck", id: "S1" }, "w1")])).toBe(
      0,
    );
    expect(
      open([
        ...flagged,
        ev(5, { op: "ticker", ticket: "T01", text: "Retrying" }, "w1"),
      ]),
    ).toBe(0);
    expect(
      open([
        ...flagged,
        ev(5, { op: "ticker", ticket: "T01", text: "Hi" }, "w2"),
      ]),
    ).toBe(1);
  });
});
