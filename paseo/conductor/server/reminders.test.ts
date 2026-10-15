import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PaseoApi } from "@getpaseo/client";
import { describe, expect, it } from "vitest";

import { type ProgressEvent, reduceProgress } from "../shared/progress.js";
import { noteChip } from "../shared/timeline.js";
import { DEFAULT_ESCALATION } from "./escalations.js";
import { resolveConductorPaths } from "./paths.js";
import { ProgressStore } from "./progress-store.js";
import {
  DEFAULT_REMINDERS,
  dueReminders,
  ProgressReminders,
  reminderNote,
} from "./reminders.js";

const T0 = Date.UTC(2026, 9, 16, 10, 0);
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const ev = (minute: number, fields: Partial<ProgressEvent>, by?: string) =>
  ({
    v: 1,
    ts: at(minute),
    op: "ticket",
    ...fields,
    ...(by ? { by } : {}),
  }) as ProgressEvent;
const min = (minute: number) => T0 + minute * 60_000;

const state = reduceProgress([
  ev(0, { op: "start", title: "Run" }),
  ev(0, { id: "T01", title: "A" }),
  ev(0, { id: "T02", title: "B" }),
  ev(0, { id: "T03", title: "C" }),
  ev(1, { id: "T01", status: "working" }, "w1"),
  ev(1, { id: "T02", status: "working" }, "w1"),
  ev(1, { id: "T03", status: "done" }, "w2"),
])!;

describe("dueReminders", () => {
  it("waits for the quiet time, then groups an agent's tickets in one nudge", () => {
    expect(dueReminders(state, min(10), {}, DEFAULT_REMINDERS).due.size).toBe(
      0,
    );
    const { due } = dueReminders(state, min(16), {}, DEFAULT_REMINDERS);
    expect([...due]).toEqual([["w1", ["T01", "T02"]]]);
  });

  it("repeats every interval, at most three times per quiet spell", () => {
    let log = {};
    const sent: number[] = [];
    for (let minute = 16; minute <= 120; minute += 1) {
      const result = dueReminders(state, min(minute), log, DEFAULT_REMINDERS);
      if (result.due.size) sent.push(minute);
      log = result.log;
    }
    expect(sent).toEqual([16, 31, 46]);
  });

  it("starts over after an update, and stays quiet when turned off", () => {
    const first = dueReminders(state, min(16), {}, DEFAULT_REMINDERS);
    const updated = reduceProgress([
      ev(0, { op: "start", title: "Run" }),
      ev(0, { id: "T01", title: "A" }),
      ev(1, { id: "T01", status: "working" }, "w1"),
      ev(20, { op: "ticker", text: "Still on it", ticket: "T01" }, "w1"),
    ])!;
    expect(
      dueReminders(updated, min(30), first.log, DEFAULT_REMINDERS).due.size,
    ).toBe(0);
    expect(
      dueReminders(updated, min(36), first.log, DEFAULT_REMINDERS).due.size,
    ).toBe(1);
    expect(
      dueReminders(state, min(60), {}, { ...DEFAULT_REMINDERS, enabled: false })
        .due.size,
    ).toBe(0);
  });

  it("reads as a check-in chip in the chat", () => {
    expect(noteChip(reminderNote(["T01", "T02"])).label).toBe(
      "Progress check-in on T01",
    );
  });
});

describe("ProgressReminders", () => {
  it("nudges live agents only, once per interval", async () => {
    const paths = resolveConductorPaths(
      await mkdtemp(path.join(os.tmpdir(), "remind-")),
    );
    const store = new ProgressStore(paths, () => new Date(at(1)));
    await store.record("c1", { op: "start", title: "Run" });
    await store.record(
      "c1",
      { op: "ticket", title: "A", status: "working" },
      "w1",
    );
    await store.record(
      "c1",
      { op: "ticket", title: "B", status: "working" },
      "gone",
    );
    const sent: string[] = [];
    const paseo = {
      agents: {
        ref: (id: string) => ({
          refresh: async () => ({
            agent:
              id === "gone"
                ? { status: "idle", archivedAt: "2026-10-16T10:00:00Z" }
                : { status: "running", archivedAt: null },
          }),
          send: async (text: string) => {
            sent.push(`${id}: ${text}`);
          },
        }),
      },
    } as unknown as PaseoApi;
    const reminders = new ProgressReminders(paths, store, async () => ({
      reminders: DEFAULT_REMINDERS,
      escalation: DEFAULT_ESCALATION,
    }));
    await reminders.tick(paseo, min(20));
    await reminders.tick(paseo, min(21));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("w1: <paseo-system>");
    expect(sent[0]).toContain("Quick check-in");
  });
});
