import { describe, expect, it } from "vitest";

import {
  checkLinks,
  linkIndex,
  mentionRefs,
  readiness,
  splitMentions,
  waitingOn,
} from "./links.js";
import {
  displayState,
  displayTicketId,
  overallProgress,
  type ProgressEvent,
  reduceProgress,
  ticketFraction,
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
const show = (id: string) => displayTicketId(id, "AI");

const run = (extra: ProgressEvent[] = []) =>
  reduceProgress([
    ev(0, { op: "start", title: "Run" }),
    ev(1, { id: "T01", title: "Parent", estimate: 60 }),
    ev(1, { id: "T02", title: "Child A", estimate: 30, parent: "T01" }),
    ev(1, { id: "T03", title: "Child B", estimate: 10, parent: "T01" }),
    ev(1, { id: "T04", title: "After", waitsFor: ["T02", "T03"] }),
    ev(1, { id: "T05", title: "Side", related: ["T04"] }),
    ...extra,
  ])!;

describe("mentions", () => {
  it("reads #AI-03, #ai3, #T03, and #3 as ticket 3, skipping look-alikes", () => {
    expect(mentionRefs("see #AI-03, #ai3 and #T03 or #3; also #12")).toEqual([
      "T03",
      "T12",
    ]);
    expect(mentionRefs("a#3 &#39; https://x.y/#3 color #fff")).toEqual([]);
  });

  it("splits text around mentions for chips", () => {
    expect(splitMentions("Fix #AI-03 before #4.")).toEqual([
      { text: "Fix " },
      { mention: "T03", raw: "#AI-03" },
      { text: " before " },
      { mention: "T04", raw: "#4" },
      { text: "." },
    ]);
  });

  it("links back from the ticket or question that mentions it", () => {
    const state = run([
      ev(2, { id: "T05", note: "Unblocks #AI-04 later" }),
      ev(3, { op: "ticker", ticket: "T02", text: "Shares code with #5" }),
      ev(4, {
        op: "ask",
        id: "Q1",
        title: "Order?",
        text: "Do #2 first?",
        options: [],
      }),
    ]);
    const links = linkIndex(state);
    expect(links.get("T04")?.mentionedIn).toEqual(["T05"]);
    expect(links.get("T05")?.mentionedIn).toEqual(["T02"]);
    expect(links.get("T02")?.mentionedIn).toEqual(["Q1"]);
    // The app's relabeled run (AI-01…) finds the same backlinks.
    expect(
      linkIndex(displayState(state, "AI")).get("AI-04")?.mentionedIn,
    ).toEqual(["AI-05"]);
  });
});

describe("links", () => {
  it("derives blocks, sub-tasks, and two-way related", () => {
    const links = linkIndex(run());
    expect(links.get("T02")?.blocks).toEqual(["T04"]);
    expect(links.get("T01")?.children).toEqual(["T02", "T03"]);
    expect(links.get("T04")?.related).toEqual(["T05"]);
    expect(links.get("T05")?.related).toEqual(["T04"]);
  });

  it("is waiting until everything it waits for finishes, then ready", () => {
    const byId = (state: ReturnType<typeof run>) =>
      new Map(state.tickets.map((ticket) => [ticket.id, ticket]));
    const before = run([ev(2, { id: "T02", status: "done" })]);
    const t4 = before.tickets.find((ticket) => ticket.id === "T04")!;
    expect(readiness(t4, byId(before))).toBe("waiting");
    expect(waitingOn(t4, byId(before)).map((ticket) => ticket.id)).toEqual([
      "T03",
    ]);
    const after = run([
      ev(2, { id: "T02", status: "done" }),
      ev(3, { id: "T03", status: "skipped" }),
    ]);
    expect(
      readiness(
        after.tickets.find((ticket) => ticket.id === "T04")!,
        byId(after),
      ),
    ).toBe("ready");
  });

  it("rejects self links, unknown ids, and loops with readable ids", () => {
    const state = run();
    expect(checkLinks(state, "T02", { waitsFor: ["T02"] }, show)).toBe(
      "waitsFor can't point AI-02 at itself",
    );
    expect(checkLinks(state, "T02", { related: ["T09"] }, show)).toMatch(
      /^related: no ticket AI-09 in this run\. Tickets: AI-01, AI-02/,
    );
    expect(checkLinks(state, "T02", { waitsFor: ["T04"] }, show)).toBe(
      "waitsFor AI-04 would loop: AI-04 already waits for AI-02",
    );
    expect(checkLinks(state, "T01", { parent: "T03" }, show)).toBe(
      "parent AI-03 would loop: it is a sub-task of AI-01",
    );
    expect(
      checkLinks(state, "T05", { waitsFor: ["T04"], parent: "T01" }, show),
    ).toBeUndefined();
  });
});

describe("parents", () => {
  it("roll up sub-tasks by estimate and count once in the run", () => {
    const state = run([
      ev(2, { id: "T02", status: "working", percent: 50 }, "w1"),
      ev(2, { id: "T03", status: "done" }, "w1"),
    ]);
    const parent = state.tickets[0]!;
    // (30 × 0.5 + 10 × 1) / 40
    expect(
      ticketFraction(parent, Date.parse(at(3)), state.tickets),
    ).toBeCloseTo(0.625);
    const overall = overallProgress(state.tickets, Date.parse(at(3)));
    // Leaves only: T02 30m at 50%, T03 10m done, T04 and T05 without estimates count 1 each.
    expect(overall.totalMin).toBe(40);
  });

  it("is done once every sub-task is, and says so", () => {
    const state = run([
      ev(2, { id: "T02", status: "done" }, "w1"),
      ev(3, { id: "T03", status: "skipped" }, "w1"),
    ]);
    expect(state.tickets[0]?.status).toBe("done");
    expect(state.tickets[0]?.note).toBe("Done: all 2 sub-tasks finished");
    expect(state.activity.at(-1)?.title).toBe("Done: all 2 sub-tasks finished");
  });

  it("reopen when a new open sub-task joins after they closed themselves", () => {
    const state = run([
      ev(2, { id: "T02", status: "done" }, "w1"),
      ev(3, { id: "T03", status: "skipped" }, "w1"),
      ev(4, { id: "T06", title: "Late part", parent: "T01" }),
    ]);
    expect(state.tickets[0]?.status).toBe("not_started");
    expect(state.tickets[0]?.note).toBe("Reopened: T06 is open");
  });
});
