import { describe, expect, it } from "vitest";

import {
  buildDashboard,
  pillLabel,
  rowChips,
  ticketLine,
  ticketTimeline,
  workedMinutes,
} from "./dashboard.js";
import { type ProgressEvent, reduceProgress } from "./progress.js";

const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 16, 10, minute)).toISOString();
const event = (minute: number, fields: Partial<ProgressEvent>) =>
  ({ v: 1, ts: at(minute), op: "ticket", ...fields }) as ProgressEvent;

const events: ProgressEvent[] = [
  event(0, { op: "start", title: "Run" }),
  event(1, { id: "T01", title: "Ticket 01: First", estimate: 10 }),
  event(1, {
    id: "T02",
    title: "Ticket 02: Second",
    estimate: 30,
    waitsFor: ["T01"],
  }),
  event(1, { id: "T03", title: "Ticket 03: Third", estimate: 20 }),
  event(2, { id: "T01", status: "working", stage: "Build" }),
  event(5, { id: "T01", stage: "Review", note: "Looks fine" }),
  event(8, { id: "T01", status: "done" }),
  event(9, { id: "T03", status: "blocked", note: "Needs access" }),
  event(9, { op: "stuck", id: "S1", text: "CI is down" }),
  event(9, {
    op: "ask",
    id: "Q1",
    title: "Pick",
    text: "Which?",
    options: [],
    recommend: "A",
  }),
  event(9, { op: "deliver", id: "D1", target: "/tmp/a.png", ticket: "T01" }),
];

describe("buildDashboard", () => {
  const state = reduceProgress(events)!;

  it("weights progress by estimate and marks waiting and stuck work", () => {
    const dashboard = buildDashboard(state, Date.parse(at(10)));
    expect(dashboard.progress).toMatchObject({
      percent: 17,
      doneMin: 10,
      totalMin: 60,
    });
    expect(dashboard.tickets[1]?.waitingFor).toBeUndefined();
    expect(dashboard.tickets[0]?.deliverables).toBe(1);
    expect(dashboard.stuck.map((item) => item.kind)).toEqual([
      "blocked",
      "manual",
    ]);
    expect(dashboard.headline.map((part) => part.text)).toEqual([
      "1 of 3 tickets done",
      "1 question waiting for you",
      "2 stuck",
    ]);
    expect(dashboard.stale).toBe(false);
    expect(buildDashboard(state, Date.parse(at(40))).stale).toBe(true);
  });

  it("flags a working ticket that runs past its estimate without updates", () => {
    const working = reduceProgress([
      ...events,
      event(10, { id: "T02", status: "working" }),
    ])!;
    expect(
      buildDashboard(working, Date.parse(at(39))).stuck.some(
        (item) => item.kind === "overdue",
      ),
    ).toBe(false);
    expect(
      buildDashboard(working, Date.parse(at(41))).stuck.some(
        (item) => item.kind === "overdue",
      ),
    ).toBe(true);
  });
});

describe("ticketTimeline", () => {
  it("splits a ticket into steps with durations and notes", () => {
    const state = reduceProgress(events)!;
    const ticket = state.tickets[0]!;
    const steps = ticketTimeline(ticket, Date.parse(at(20)), state.activity);
    expect(steps.map((step) => [step.label, step.minutes])).toEqual([
      ["Added", 1],
      ["Build stage", 3],
      ["Review stage", 3],
      ["Done", null],
    ]);
    expect(
      steps[2]?.events.map((event) =>
        event.type === "activity" ? event.item.title : event.type,
      ),
    ).toEqual(["Looks fine"]);
    expect(workedMinutes(steps)).toBe(6);
  });
});

describe("pillLabel", () => {
  it("counts what needs the user and fits Paseo's pill width", () => {
    expect(pillLabel(0, 0)).toBe("Progress");
    expect(pillLabel(1, 0)).toBe("1 question");
    expect(pillLabel(2, 1)).toBe("2Q · 1 stuck");
    expect(pillLabel(0, 3)).toBe("3 stuck");
  });
});

describe("ticket rows", () => {
  const state = reduceProgress([
    event(0, { op: "start", title: "Run" }),
    event(1, { id: "T01", title: "A", labels: ["ui", "api", "docs"] }),
    event(1, { id: "T02", title: "B", note: "old note" }),
    { ...event(2, { id: "T01", status: "working" }), by: "w1" },
    { ...event(2, { id: "T02", status: "working" }), by: "w2" },
    { ...event(3, { op: "ticker", text: "wiring the API" }), by: "w1" },
  ])!;
  const dashboard = buildDashboard(state, Date.parse(at(4)));
  const ticket = (id: string) => dashboard.tickets.find((t) => t.id === id)!;

  it("show the ticker on its agent's ticket and the note elsewhere", () => {
    expect(ticketLine(ticket("T01"), dashboard)).toBe("wiring the API");
    expect(ticketLine(ticket("T02"), dashboard)).toBe("old note");
  });

  it("show labels first, agents next, and count the rest", () => {
    const { shown, hidden } = rowChips(ticket("T01"));
    expect(shown.map((chip) => chip.type)).toEqual(["label", "label", "label"]);
    expect(hidden).toEqual([{ type: "agent", agentId: "w1" }]);
    expect(rowChips({ ...ticket("T01"), status: "done" }).hidden).toEqual([]);
  });
});
