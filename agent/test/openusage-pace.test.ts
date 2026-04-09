import test from "node:test";
import assert from "node:assert/strict";
import {
  calculatePaceStatus,
  formatProjectedResetText,
  formatRunsOutText,
  getMetricPaceDetails,
  getPaceStatusText,
  type PaceResult,
} from "../src/extensions/openusage/status.ts";
import type { UsageMetric } from "../src/extensions/openusage/types.ts";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const RESETS_AT_MS = Date.parse("2026-04-09T10:00:00.000Z");
const MID_PERIOD_NOW_MS = RESETS_AT_MS - FIVE_HOURS_MS / 2;

function createMetric(used: number): UsageMetric {
  return {
    used,
    limit: 100,
    resetsAt: new Date(RESETS_AT_MS).toISOString(),
    periodDurationMs: FIVE_HOURS_MS,
  };
}

test("pace classification covers ahead, on-track, and behind", () => {
  assert.deepEqual(calculatePaceStatus(30, 100, RESETS_AT_MS, FIVE_HOURS_MS, MID_PERIOD_NOW_MS), {
    status: "ahead",
    projectedUsage: 60,
  });
  assert.deepEqual(calculatePaceStatus(45, 100, RESETS_AT_MS, FIVE_HOURS_MS, MID_PERIOD_NOW_MS), {
    status: "on-track",
    projectedUsage: 90,
  });
  assert.deepEqual(calculatePaceStatus(60, 100, RESETS_AT_MS, FIVE_HOURS_MS, MID_PERIOD_NOW_MS), {
    status: "behind",
    projectedUsage: 120,
  });
});

test("pace status labels match upstream copy", () => {
  assert.equal(getPaceStatusText("ahead"), "Plenty of room");
  assert.equal(getPaceStatusText("on-track"), "Right on target");
  assert.equal(getPaceStatusText("behind"), "Will run out");
});

test("projected reset text respects display mode", () => {
  const paceResult: PaceResult = { status: "on-track", projectedUsage: 90 };
  assert.equal(formatProjectedResetText(paceResult, 100, "used"), "90% used at reset");
  assert.equal(formatProjectedResetText(paceResult, 100, "left"), "10% left at reset");
});

test("behind pace ETA uses runs-out wording", () => {
  const paceResult: PaceResult = { status: "behind", projectedUsage: 120 };
  assert.equal(formatRunsOutText(paceResult, createMetric(60), MID_PERIOD_NOW_MS), "Runs out in 1h 40m");
});

test("metric pace details expose projection, eta, and elapsed marker position", () => {
  const details = getMetricPaceDetails(createMetric(60), "used", MID_PERIOD_NOW_MS);
  assert.equal(details.statusText, "Will run out");
  assert.equal(details.projectedText, "100% used at reset");
  assert.equal(details.runsOutText, "Runs out in 1h 40m");
  assert.equal(details.elapsedPercent, 50);
});

test("early period pace details suppress classification until enough time elapsed", () => {
  const earlyNowMs = RESETS_AT_MS - FIVE_HOURS_MS + Math.floor(FIVE_HOURS_MS * 0.04);
  const details = getMetricPaceDetails(createMetric(10), "left", earlyNowMs);
  assert.equal(details.statusText, null);
  assert.equal(details.projectedText, null);
  assert.equal(details.runsOutText, null);
  assert.ok(details.elapsedPercent !== null && details.elapsedPercent < 5);
});
