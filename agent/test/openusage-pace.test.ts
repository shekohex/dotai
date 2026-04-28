import { expect, test } from "vitest";
import {
  calculatePaceStatus,
  formatProjectedResetText,
  formatRunsOutText,
  getMetricPaceDetails,
  getPaceStatusText,
  type PaceResult,
} from "../src/extensions/openusage/status.ts";
import { publishUsageUpdateIfChanged } from "../src/extensions/openusage/controller-utils.ts";
import { applyUpdatedEventToState, createRuntimeState } from "../src/extensions/openusage/state.ts";
import { parseUpdatedEvent } from "../src/extensions/openusage/events.ts";
import type { UsageMetric } from "../src/extensions/openusage/types.ts";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const RESETS_AT_MS = Date.parse("2026-04-09T10:00:00.000Z");
const MID_PERIOD_NOW_MS = RESETS_AT_MS - FIVE_HOURS_MS / 2;
const TEST_TIMEOUT_MS = 15_000;

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

function createMetric(used: number): UsageMetric {
  return {
    used,
    limit: 100,
    resetsAt: new Date(RESETS_AT_MS).toISOString(),
    periodDurationMs: FIVE_HOURS_MS,
  };
}

timedTest("pace classification covers ahead, on-track, and behind", () => {
  expect(calculatePaceStatus(30, 100, RESETS_AT_MS, FIVE_HOURS_MS, MID_PERIOD_NOW_MS)).toEqual({
    status: "ahead",
    projectedUsage: 60,
  });
  expect(calculatePaceStatus(45, 100, RESETS_AT_MS, FIVE_HOURS_MS, MID_PERIOD_NOW_MS)).toEqual({
    status: "on-track",
    projectedUsage: 90,
  });
  expect(calculatePaceStatus(60, 100, RESETS_AT_MS, FIVE_HOURS_MS, MID_PERIOD_NOW_MS)).toEqual({
    status: "behind",
    projectedUsage: 120,
  });
});

timedTest("pace status labels match upstream copy", () => {
  expect(getPaceStatusText("ahead")).toBe("Plenty of room");
  expect(getPaceStatusText("on-track")).toBe("Right on target");
  expect(getPaceStatusText("behind")).toBe("Will run out");
});

timedTest("projected reset text respects display mode", () => {
  const paceResult: PaceResult = { status: "on-track", projectedUsage: 90 };
  expect(formatProjectedResetText(paceResult, 100, "used")).toBe("90% used at reset");
  expect(formatProjectedResetText(paceResult, 100, "left")).toBe("10% left at reset");
});

timedTest("behind pace ETA uses runs-out wording", () => {
  const paceResult: PaceResult = { status: "behind", projectedUsage: 120 };
  expect(formatRunsOutText(paceResult, createMetric(60), MID_PERIOD_NOW_MS)).toBe(
    "Runs out in 1h 40m",
  );
});

timedTest("metric pace details expose projection, eta, and elapsed marker position", () => {
  const details = getMetricPaceDetails(createMetric(60), "used", MID_PERIOD_NOW_MS);
  expect(details.statusText).toBe("Will run out");
  expect(details.projectedText).toBe("100% used at reset");
  expect(details.runsOutText).toBe("Runs out in 1h 40m");
  expect(details.elapsedPercent).toBe(50);
});

timedTest("early period pace details suppress classification until enough time elapsed", () => {
  const earlyNowMs = RESETS_AT_MS - FIVE_HOURS_MS + Math.floor(FIVE_HOURS_MS * 0.04);
  const details = getMetricPaceDetails(createMetric(10), "left", earlyNowMs);
  expect(details.statusText).toBe(null);
  expect(details.projectedText).toBe(null);
  expect(details.runsOutText).toBe(null);
  expect(details.elapsedPercent !== null && details.elapsedPercent < 5).toBeTruthy();
});

timedTest("openusage publishUsageUpdateIfChanged skips identical active status writes", () => {
  const state = createRuntimeState();
  const statuses: Array<string | undefined> = [];
  const emitted: Array<unknown> = [];
  const snapshot = {
    providerId: "codex",
    displayName: "Codex",
    source: "host",
    session5h: createMetric(5),
    weekly: createMetric(16),
    fetchedAt: RESETS_AT_MS,
  } as const;
  const ctx = {
    ui: {
      setStatus: (_key: string, text: string | undefined) => {
        statuses.push(text);
      },
      theme: {
        fg: (_color: string, text: string) => text,
      },
    },
  } as const;
  const pi = {
    events: {
      emit: (_event: string, payload: unknown) => {
        emitted.push(payload);
      },
    },
  } as const;

  publishUsageUpdateIfChanged(pi as never, state, ctx as never, snapshot, true);
  publishUsageUpdateIfChanged(pi as never, state, ctx as never, snapshot, true);

  expect(statuses.length).toBe(1);
  expect(emitted.length).toBe(1);
});

timedTest("openusage updated event hydrates and clears local snapshots", () => {
  const state = createRuntimeState();
  const updated = parseUpdatedEvent({
    providerId: "codex",
    active: true,
    snapshot: {
      providerId: "codex",
      displayName: "Codex",
      source: "cliproxy",
      fetchedAt: RESETS_AT_MS,
      summary: "cliproxy account",
    },
  });

  expect(updated).toBeTruthy();
  applyUpdatedEventToState(state, updated!);
  expect(state.snapshots.get("codex")?.summary).toBe("cliproxy account");

  const cleared = parseUpdatedEvent({
    providerId: "codex",
    active: true,
  });

  expect(cleared).toBeTruthy();
  applyUpdatedEventToState(state, cleared!);
  expect(state.snapshots.has("codex")).toBe(false);
});
