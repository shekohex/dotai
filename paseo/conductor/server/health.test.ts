import { describe, expect, it } from "vitest";

import {
  evaluateWorkers,
  type WorkerObservation,
  type WorkerRecord,
} from "./health.js";

const MINUTE = 60_000;
const start = Date.parse("2026-10-07T10:00:00.000Z");

function observation(
  overrides: Partial<WorkerObservation> = {},
): WorkerObservation {
  return {
    id: "w1",
    conductorId: "c1",
    title: "Fix auth",
    status: "running",
    updatedAt: new Date(start).toISOString(),
    pendingPermissionIds: [],
    ...overrides,
  };
}

function record(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    conductorId: "c1",
    title: "Fix auth",
    running: true,
    runningSince: new Date(start).toISOString(),
    stallReportedAt: null,
    permissions: {},
    ...overrides,
  };
}

describe("evaluateWorkers", () => {
  it("reports a stalled worker once per restall window", () => {
    const first = evaluateWorkers({
      records: { w1: record() },
      observations: [observation()],
      now: start + 11 * MINUTE,
      startup: false,
    });
    expect(first.notices.map((notice) => notice.reason)).toEqual([
      "is stalled",
    ]);

    const again = evaluateWorkers({
      records: first.records,
      observations: [observation()],
      now: start + 20 * MINUTE,
      startup: false,
    });
    expect(again.notices).toEqual([]);

    const later = evaluateWorkers({
      records: again.records,
      observations: [observation()],
      now: start + 42 * MINUTE,
      startup: false,
    });
    expect(later.notices.map((notice) => notice.reason)).toEqual([
      "is stalled",
    ]);
  });

  it("does not treat a worker waiting on permission as stalled", () => {
    const result = evaluateWorkers({
      records: {
        w1: record({
          permissions: {
            p1: { firstSeenAt: new Date(start).toISOString(), reminded: true },
          },
        }),
      },
      observations: [observation({ pendingPermissionIds: ["p1"] })],
      now: start + 30 * MINUTE,
      startup: false,
    });
    expect(result.notices).toEqual([]);
  });

  it("reminds about a pending permission once", () => {
    const seen = evaluateWorkers({
      records: {},
      observations: [
        observation({ status: "idle", pendingPermissionIds: ["p1"] }),
      ],
      now: start,
      startup: false,
    });
    expect(seen.notices).toEqual([]);

    const due = evaluateWorkers({
      records: seen.records,
      observations: [
        observation({ status: "idle", pendingPermissionIds: ["p1"] }),
      ],
      now: start + 6 * MINUTE,
      startup: false,
    });
    expect(due.notices.map((notice) => notice.messageId)).toEqual([
      "conductor:permission:w1:p1",
    ]);

    const after = evaluateWorkers({
      records: due.records,
      observations: [
        observation({ status: "idle", pendingPermissionIds: ["p1"] }),
      ],
      now: start + 12 * MINUTE,
      startup: false,
    });
    expect(after.notices).toEqual([]);
  });

  it("reports workers whose turn ended while the plugin was offline", () => {
    const result = evaluateWorkers({
      records: { w1: record() },
      observations: [observation({ status: "closed" })],
      now: start + MINUTE,
      startup: true,
    });
    expect(result.notices.map((notice) => notice.reason)).toEqual([
      "was interrupted",
    ]);
    expect(result.records.w1?.running).toBe(false);
  });

  it("stays quiet on ordinary ticks when a turn ends", () => {
    const result = evaluateWorkers({
      records: { w1: record() },
      observations: [observation({ status: "idle" })],
      now: start + MINUTE,
      startup: false,
    });
    expect(result.notices).toEqual([]);
  });

  it("drops records for workers no longer observed", () => {
    const result = evaluateWorkers({
      records: { gone: record() },
      observations: [],
      now: start,
      startup: false,
    });
    expect(result.records).toEqual({});
  });
});
