import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  OPENUSAGE_STATUS_KEY,
  type ResetTimeFormat,
  type UsageMetric,
  type UsageSnapshot,
} from "./types.js";

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

export function renderStatus(snapshot: UsageSnapshot): string {
  const parts: string[] = [];
  const sessionLabel = getMetricShortLabel(snapshot, "session5h");
  const weeklyLabel = getMetricShortLabel(snapshot, "weekly");

  if (snapshot.session5h) {
    parts.push(`${sessionLabel} ${formatRemainingPercent(snapshot.session5h)}`);
  }

  if (snapshot.weekly) {
    parts.push(`${weeklyLabel} ${formatRemainingPercent(snapshot.weekly)}`);
  }

  if (parts.length === 0) {
    parts.push(`${sessionLabel} n/a`, `${weeklyLabel} n/a`);
  }

  return parts.join(" ");
}

export function getMetricLabel(snapshot: UsageSnapshot, kind: "session5h" | "weekly"): string {
  return snapshot.metricLabels?.[kind] ?? (kind === "weekly" ? "Weekly" : "5h");
}

export function getMetricShortLabel(snapshot: UsageSnapshot, kind: "session5h" | "weekly"): string {
  return snapshot.metricShortLabels?.[kind] ?? (kind === "weekly" ? "wk" : "5h");
}

export function formatRemainingPercent(metric: UsageMetric): string {
  const remaining = getRemainingPercent(metric);
  return remaining === undefined ? "n/a" : formatPercent(remaining);
}

export function formatUsedPercent(metric: UsageMetric): string {
  return formatPercent(getUsedPercent(metric));
}

export function calculatePaceStatus(
  used: number,
  limit: number,
  resetsAtMs: number,
  periodDurationMs: number,
  nowMs: number,
): PaceResult | null {
  if (
    !Number.isFinite(used) ||
    !Number.isFinite(limit) ||
    !Number.isFinite(resetsAtMs) ||
    !Number.isFinite(periodDurationMs) ||
    !Number.isFinite(nowMs)
  ) {
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
  return status === "ahead" ? "Plenty of room" : status === "on-track" ? "Right on target" : "Will run out";
}

export function formatProjectedResetText(
  paceResult: PaceResult | null,
  limit: number,
  displayMode: OpenUsageDisplayMode,
): string | null {
  if (!paceResult || !Number.isFinite(limit) || limit <= 0) {
    return null;
  }

  const projectedPercent = Math.max(0, Math.min(100, Math.round((paceResult.projectedUsage / limit) * 100)));
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
  return duration ? `Runs out in ${duration}` : null;
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
    statusText: paceResult ? getPaceStatusText(paceResult.status) : null,
    projectedText: formatProjectedResetText(paceResult, metric.limit, displayMode),
    runsOutText: formatRunsOutText(paceResult, metric, now),
    elapsedPercent: context.periodDurationMs > 0
      ? Math.max(0, Math.min(100, ((now - (context.resetsAtMs - context.periodDurationMs)) / context.periodDurationMs) * 100))
      : null,
  };
}

export function setStatus(
  ctx: ExtensionContext,
  snapshot: UsageSnapshot | undefined,
): void {
  if (!snapshot) {
    ctx.ui.setStatus(OPENUSAGE_STATUS_KEY, undefined);
    return;
  }

  const theme = ctx.ui.theme;
  const sessionMetric = snapshot.session5h;
  const weeklyMetric = snapshot.weekly;
  const sessionLabel = getMetricShortLabel(snapshot, "session5h");
  const weeklyLabel = getMetricShortLabel(snapshot, "weekly");

  let text = theme.fg("dim", `${sessionLabel} `);
  text += sessionMetric
    ? colorForMetric(
        theme,
        sessionMetric,
        formatRemainingPercent(sessionMetric),
      )
    : theme.fg("muted", "n/a");

  text += theme.fg("dim", ` ${weeklyLabel} `);
  text += weeklyMetric
    ? colorForMetric(theme, weeklyMetric, formatRemainingPercent(weeklyMetric))
    : theme.fg("muted", "n/a");

  ctx.ui.setStatus(OPENUSAGE_STATUS_KEY, text);
}

export function formatSnapshotSummary(
  snapshot: UsageSnapshot,
  options: { resetTimeFormat?: ResetTimeFormat; now?: number } = {},
): string {
  const lines = [
    `Provider: ${snapshot.displayName}`,
    `Source: ${snapshot.source}`,
  ];

  if (snapshot.plan) {
    lines.push(`Plan: ${snapshot.plan}`);
  }

  const maskedAccount = maskAccountLabel(snapshot.accountLabel);
  if (maskedAccount) {
    lines.push(`Account: ${maskedAccount}`);
  }

  if (snapshot.session5h) {
    lines.push(formatMetricLine(getMetricLabel(snapshot, "session5h"), snapshot.session5h, options));
  }

  if (snapshot.weekly) {
    lines.push(formatMetricLine(getMetricLabel(snapshot, "weekly"), snapshot.weekly, options));
  }

  if (snapshot.summary) {
    lines.push(`Summary: ${snapshot.summary}`);
  }

  return lines.join("\n");
}

function formatMetricLine(
  label: string,
  metric: UsageMetric,
  options: { resetTimeFormat?: ResetTimeFormat; now?: number },
): string {
  const reset = formatReset(
    metric.resetsAt,
    options.resetTimeFormat ?? "relative",
    options.now ?? Date.now(),
  );
  const pace = getMetricPaceDetails(metric, "left", options.now ?? Date.now());
  const paceText = [pace.statusText, pace.projectedText, pace.runsOutText].filter(Boolean).join(", ");
  return `${label}: ${formatRemainingPercent(metric)} left (${formatUsedPercent(metric)} used)${reset ? `, resets ${reset}` : ""}${paceText ? `, ${paceText}` : ""}`;
}

function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "n/a";
  }

  const normalized = Math.max(0, Math.min(100, value));
  const rounded = Math.round(normalized * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function getUsedPercent(metric: UsageMetric): number | undefined {
  if (
    !Number.isFinite(metric.used) ||
    !Number.isFinite(metric.limit) ||
    metric.limit <= 0
  ) {
    return undefined;
  }

  return (metric.used / metric.limit) * 100;
}

export function getRemainingPercent(metric: UsageMetric): number | undefined {
  const used = getUsedPercent(metric);
  if (used === undefined) {
    return undefined;
  }

  return 100 - used;
}

function colorForMetric(
  theme: ExtensionContext["ui"]["theme"],
  metric: UsageMetric,
  text: string,
): string {
  const remaining = getRemainingPercent(metric);
  if (remaining === undefined) {
    return theme.fg("muted", text);
  }

  if (remaining <= 15) {
    return theme.fg("error", text);
  }

  if (remaining <= 35) {
    return theme.fg("warning", text);
  }

  return theme.fg("success", text);
}

export function maskAccountLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const primary = trimmed.split(" (")[0]?.trim() ?? trimmed;
  if (primary.includes("@")) {
    return maskEmail(primary);
  }

  if (primary.length <= 10) {
    return primary;
  }

  return `${primary.slice(0, 3)}***${primary.slice(-3)}`;
}

export function formatReset(
  value: string | undefined,
  mode: ResetTimeFormat,
  now: number,
): string | undefined {
  if (!value) {
    return undefined;
  }

  if (mode === "absolute") {
    return value;
  }

  const target = Date.parse(value);
  if (!Number.isFinite(target)) {
    return value;
  }

  const diff = target - now;
  if (diff <= 0) {
    return "now";
  }

  return `in ${formatDuration(diff)}`;
}

function formatDuration(milliseconds: number): string {
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  const days = Math.floor(milliseconds / dayMs);
  const hours = Math.floor((milliseconds % dayMs) / hourMs);
  const minutes = Math.max(1, Math.floor((milliseconds % hourMs) / minuteMs));

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
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

function resolveMetricPaceContext(metric: UsageMetric): { resetsAtMs: number; periodDurationMs: number } | null {
  if (!metric.resetsAt || !Number.isFinite(metric.periodDurationMs) || !metric.periodDurationMs || metric.periodDurationMs <= 0) {
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

function maskEmail(value: string): string {
  const [local, domain] = value.split("@");
  if (!local || !domain) {
    return value;
  }

  const domainParts = domain.split(".");
  const tld =
    domainParts.length > 1 ? `.${domainParts[domainParts.length - 1]}` : "";
  const localMasked = `${local.slice(0, 2)}***`;
  return `${localMasked}@***${tld}`;
}
