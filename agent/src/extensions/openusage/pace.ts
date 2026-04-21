import type { UsageMetric } from "./types.js";

export type OpenUsageDisplayMode = "left" | "used";

export type PaceStatus = "ahead" | "on-track" | "behind";

export type PaceResult = {
  status: PaceStatus;
  projectedUsage: number;
};

export type MetricPaceDetails = {
  paceResult: PaceResult | null;
  statusText: string | null;
  projectedText: string | null;
  runsOutText: string | null;
  elapsedPercent: number | null;
};

function hasText(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value.length > 0;
}

function hasPaceLimitInputs(
  used: number,
  limit: number,
  resetsAtMs: number,
  periodDurationMs: number,
  nowMs: number,
): boolean {
  return (
    Number.isFinite(used) &&
    Number.isFinite(limit) &&
    Number.isFinite(resetsAtMs) &&
    Number.isFinite(periodDurationMs) &&
    Number.isFinite(nowMs)
  );
}

export function calculatePaceStatus(
  used: number,
  limit: number,
  resetsAtMs: number,
  periodDurationMs: number,
  nowMs: number,
): PaceResult | null {
  if (!hasPaceLimitInputs(used, limit, resetsAtMs, periodDurationMs, nowMs)) {
    return null;
  }
  if (limit <= 0 || periodDurationMs <= 0) {
    return null;
  }
  const periodStartMs = resetsAtMs - periodDurationMs;
  const elapsedMs = nowMs - periodStartMs;
  if (elapsedMs <= 0 || nowMs >= resetsAtMs) {
    return null;
  }
  if (used === 0) {
    return { status: "ahead", projectedUsage: 0 };
  }
  const usageRate = used / elapsedMs;
  const projectedUsage = roundUsageValue(usageRate * periodDurationMs);
  if (used >= limit) {
    return { status: "behind", projectedUsage };
  }
  const elapsedFraction = elapsedMs / periodDurationMs;
  if (elapsedFraction < 0.05) {
    return null;
  }
  if (projectedUsage <= limit * 0.8) {
    return { status: "ahead", projectedUsage };
  }
  if (projectedUsage <= limit) {
    return { status: "on-track", projectedUsage };
  }
  return { status: "behind", projectedUsage };
}

export function getPaceStatusText(status: PaceStatus): string {
  if (status === "ahead") {
    return "Plenty of room";
  }
  if (status === "on-track") {
    return "Right on target";
  }
  return "Will run out";
}

export function formatProjectedResetText(
  paceResult: PaceResult | null,
  limit: number,
  displayMode: OpenUsageDisplayMode,
): string | null {
  if (!paceResult || !Number.isFinite(limit) || limit <= 0) {
    return null;
  }
  const projectedPercent = Math.max(
    0,
    Math.min(100, Math.round((paceResult.projectedUsage / limit) * 100)),
  );
  const shownPercent = displayMode === "left" ? 100 - projectedPercent : projectedPercent;
  return `${shownPercent}% ${displayMode === "left" ? "left at reset" : "used at reset"}`;
}

export function formatRunsOutText(
  paceResult: PaceResult | null,
  metric: UsageMetric,
  now: number,
): string | null {
  if (!paceResult || paceResult.status !== "behind") {
    return null;
  }
  const context = resolveMetricPaceContext(metric);
  if (!context) {
    return null;
  }
  const rate = paceResult.projectedUsage / context.periodDurationMs;
  if (!Number.isFinite(rate) || rate <= 0) {
    return null;
  }
  const etaMs = (metric.limit - metric.used) / rate;
  const remainingMs = context.resetsAtMs - now;
  if (!Number.isFinite(etaMs) || etaMs <= 0 || etaMs >= remainingMs) {
    return null;
  }
  const duration = formatCompactDuration(etaMs);
  return hasText(duration) ? `Runs out in ${duration}` : null;
}

export function getMetricPaceDetails(
  metric: UsageMetric,
  displayMode: OpenUsageDisplayMode,
  now: number = Date.now(),
): MetricPaceDetails {
  const context = resolveMetricPaceContext(metric);
  if (!context) {
    return {
      paceResult: null,
      statusText: null,
      projectedText: null,
      runsOutText: null,
      elapsedPercent: null,
    };
  }
  const paceResult = calculatePaceStatus(
    metric.used,
    metric.limit,
    context.resetsAtMs,
    context.periodDurationMs,
    now,
  );
  return {
    paceResult,
    statusText: paceResult === null ? null : getPaceStatusText(paceResult.status),
    projectedText: formatProjectedResetText(paceResult, metric.limit, displayMode),
    runsOutText: formatRunsOutText(paceResult, metric, now),
    elapsedPercent:
      context.periodDurationMs > 0
        ? Math.max(
            0,
            Math.min(
              100,
              ((now - (context.resetsAtMs - context.periodDurationMs)) / context.periodDurationMs) *
                100,
            ),
          )
        : null,
  };
}

function formatCompactDuration(milliseconds: number): string | null {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return null;
  }
  const totalSeconds = Math.floor(milliseconds / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (totalHours > 0) {
    return `${totalHours}h ${minutes}m`;
  }
  if (totalMinutes > 0) {
    return `${totalMinutes}m`;
  }
  return "<1m";
}

function resolveMetricPaceContext(
  metric: UsageMetric,
): { resetsAtMs: number; periodDurationMs: number } | null {
  if (
    !hasText(metric.resetsAt) ||
    !Number.isFinite(metric.periodDurationMs) ||
    metric.periodDurationMs === undefined ||
    metric.periodDurationMs <= 0
  ) {
    return null;
  }
  const resetsAtMs = Date.parse(metric.resetsAt);
  if (!Number.isFinite(resetsAtMs)) {
    return null;
  }
  return { resetsAtMs, periodDurationMs: metric.periodDurationMs };
}

function roundUsageValue(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
