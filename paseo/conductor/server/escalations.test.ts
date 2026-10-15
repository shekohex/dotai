import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PaseoApi } from "@getpaseo/client";
import { describe, expect, it } from "vitest";

import { type ProgressEvent, reduceProgress } from "../shared/progress.js";
import { noteChip } from "../shared/timeline.js";
import {
  blockers,
  DEFAULT_ESCALATION,
  dueEscalations,
  dueResumeChecks,
  escalationNote,
  resumeNote,
} from "./escalations.js";
import { resolveConductorPaths } from "./paths.js";
import { ProgressStore } from "./progress-store.js";
import {
  DEFAULT_REMINDERS,
  ProgressReminders,
  reminderNote,
} from "./reminders.js";

const T0 = Date.UTC(2026, 9, 16, 10, 0);
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const min = (minute: number) => T0 + minute * 60_000;
const ev = (minute: number, fields: Partial<ProgressEvent>, by?: string) =>
  ({
    v: 1,
    ts: at(minute),
    op: "ticket",
    ...fields,
    ...(by ? { by } : {}),
  }) as ProgressEvent;

const base: ProgressEvent[] = [
  ev(0, { op: "start", title: "Run" }),
  ev(0, { id: "T01", title: "A" }),
  ev(0, { id: "T02", title: "B" }),
  ev(1, { id: "T01", status: "working" }, "w1"),
  ev(2, { id: "T01", status: "blocked", note: "Needs keys" }, "w1"),
  ev(2, { id: "T02", status: "working" }, "w2"),
  ev(3, { op: "stuck", id: "S1", text: "CI down", ticket: "T02" }, "w2"),
];

describe("dueEscalations", () => {
  const state = reduceProgress(base)!;

  it("tells the conductor after the wait, repeats every 30m, three times at most", () => {
    let log = {};
    const sent: [number, string[]][] = [];
    for (let minute = 3; minute <= 200; minute += 1) {
      const result = dueEscalations(
        state,
        min(minute),
        log,
        DEFAULT_ESCALATION,
      );
      if (result.due.length)
        sent.push([minute, result.due.map((item) => item.key)]);
      log = result.log;
    }
    expect(sent).toEqual([
      [12, ["T01"]],
      [13, ["S1"]],
      [42, ["T01"]],
      [43, ["S1"]],
      [72, ["T01"]],
      [73, ["S1"]],
    ]);
  });

  it("skips blockers waiting on the user's answer, and settings can turn it off", () => {
    const asked = reduceProgress([
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
    ])!;
    expect(blockers(asked).find((item) => item.key === "T01")?.waitingOn).toBe(
      "Q1",
    );
    expect(
      dueEscalations(asked, min(30), {}, DEFAULT_ESCALATION).due.map(
        (item) => item.key,
      ),
    ).toEqual(["S1"]);
    expect(
      dueEscalations(
        state,
        min(30),
        {},
        { ...DEFAULT_ESCALATION, enabled: false },
      ).due,
    ).toEqual([]);
  });

  it("starts over when the ticket is blocked again later", () => {
    const first = dueEscalations(state, min(12), {}, DEFAULT_ESCALATION);
    const again = reduceProgress([
      ...base,
      ev(20, { id: "T01", status: "working" }, "w1"),
      ev(25, { id: "T01", status: "blocked", note: "Still keys" }, "w1"),
    ])!;
    expect(
      dueEscalations(again, min(35), first.log, DEFAULT_ESCALATION).due.map(
        (item) => item.key,
      ),
    ).toEqual(["T01", "S1"]);
  });

  it("writes one short note with the prefix, shown as a chip in chat", () => {
    const note = escalationNote(blockers(state), min(12), "AI");
    expect(note).toBe(
      "AI-01 blocked 10m: Needs keys. S1 stuck on AI-02 9m: CI down. Decide: answer, unblock, or reassign; or leave it for the user.",
    );
    expect(noteChip(note).label).toBe("Blocked: AI-01, S1");
  });
});

describe("dueResumeChecks", () => {
  const items = blockers(reduceProgress(base)!);

  it("nudges an owner seen running again, once per blocked spell", () => {
    const first = dueResumeChecks(
      items,
      new Map([["w1", "idle"]]),
      new Map([["w1", "running"]]),
      {},
    );
    expect([...first.due.keys()]).toEqual(["w1"]);
    expect(resumeNote(first.due.get("w1")!, "AI")).toBe(
      "Your ticket AI-01 is marked blocked but you are running again. If resolved, update its status with the progress tool.",
    );
    expect(noteChip(resumeNote(first.due.get("w1")!, "AI")).label).toBe(
      "Still blocked? AI-01",
    );
    expect(noteChip(reminderNote(["T01"], "AI")).label).toBe(
      "Progress check-in on AI-01",
    );
    const second = dueResumeChecks(
      items,
      new Map([["w1", "idle"]]),
      new Map([["w1", "running"]]),
      first.log,
    );
    expect(second.due.size).toBe(0);
    // Unknown before, or running all along: no nudge.
    expect(
      dueResumeChecks(items, new Map(), new Map([["w1", "running"]]), {}).due
        .size,
    ).toBe(0);
  });
});

describe("ProgressReminders escalation", () => {
  it("tells the conductor and nudges a resumed agent on a fake clock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "escalate-"));
    const paths = resolveConductorPaths(root);
    let now = min(0);
    const store = new ProgressStore(paths, () => new Date(now));
    await store.record("c1", { op: "start", title: "Run" });
    await store.record(
      "c1",
      { op: "ticket", title: "A", status: "working" },
      "w1",
    );
    now = min(1);
    await store.record(
      "c1",
      { op: "ticket", id: "1", status: "blocked", note: "Needs keys" },
      "w1",
    );
    const statuses = new Map([
      ["c1", "idle"],
      ["w1", "idle"],
    ]);
    const sent: string[] = [];
    const paseo = {
      agents: {
        ref: (id: string) => ({
          refresh: async () => ({
            agent: { status: statuses.get(id) ?? "idle", archivedAt: null },
          }),
          send: async (text: string) => {
            sent.push(`${id}: ${text}`);
          },
        }),
      },
    } as unknown as PaseoApi;
    const monitor = new ProgressReminders(paths, store, async () => ({
      reminders: { ...DEFAULT_REMINDERS, enabled: false },
      escalation: DEFAULT_ESCALATION,
    }));
    await monitor.tick(paseo, min(5));
    expect(sent).toEqual([]);
    statuses.set("w1", "running");
    await monitor.tick(paseo, min(11));
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/^c1: <paseo-system>\nT01 blocked 10m: Needs keys/);
    expect(sent[1]).toMatch(/^w1: .*Your ticket T01 is marked blocked/s);
    expect(await monitor.escalations("c1")).toEqual({ T01: 1 });
    await monitor.tick(paseo, min(12));
    expect(sent).toHaveLength(2);
  });
});
