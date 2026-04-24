import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  OPENUSAGE_STATUS_KEY,
  type ResetTimeFormat,
  type UsageMetric,
  type UsageSnapshot,
} from "./types.js";
import { getMetricPaceDetails } from "./pace.js";

export type { MetricPaceDetails, OpenUsageDisplayMode, PaceResult, PaceStatus } from "./pace.js";
export {
  calculatePaceStatus,
  formatProjectedResetText,
  formatRunsOutText,
  getMetricPaceDetails,
  getPaceStatusText,
} from "./pace.js";

function hasText(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value.length > 0;
}

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

export function setStatus(ctx: ExtensionContext, snapshot: UsageSnapshot | undefined): void {
  ctx.ui.setStatus(OPENUSAGE_STATUS_KEY, renderStatusText(ctx, snapshot));
}

export function renderStatusText(
  ctx: ExtensionContext,
  snapshot: UsageSnapshot | undefined,
): string | undefined {
  if (!snapshot) {
    return undefined;
  }

  const theme = ctx.ui.theme;
  const sessionMetric = snapshot.session5h;
  const weeklyMetric = snapshot.weekly;
  const sessionLabel = getMetricShortLabel(snapshot, "session5h");
  const weeklyLabel = getMetricShortLabel(snapshot, "weekly");

  let text = theme.fg("dim", `${sessionLabel} `);
  text += sessionMetric
    ? colorForMetric(theme, sessionMetric, formatRemainingPercent(sessionMetric))
    : theme.fg("muted", "n/a");

  text += theme.fg("dim", ` ${weeklyLabel} `);
  text += weeklyMetric
    ? colorForMetric(theme, weeklyMetric, formatRemainingPercent(weeklyMetric))
    : theme.fg("muted", "n/a");

  return text;
}

export function formatSnapshotSummary(
  snapshot: UsageSnapshot,
  options: { resetTimeFormat?: ResetTimeFormat; now?: number } = {},
): string {
  const lines = [`Provider: ${snapshot.displayName}`, `Source: ${snapshot.source}`];

  if (hasText(snapshot.plan)) {
    lines.push(`Plan: ${snapshot.plan}`);
  }

  const maskedAccount = maskAccountLabel(snapshot.accountLabel);
  if (hasText(maskedAccount)) {
    lines.push(`Account: ${maskedAccount}`);
  }

  if (snapshot.session5h) {
    lines.push(
      formatMetricLine(getMetricLabel(snapshot, "session5h"), snapshot.session5h, options),
    );
  }

  if (snapshot.weekly) {
    lines.push(formatMetricLine(getMetricLabel(snapshot, "weekly"), snapshot.weekly, options));
  }

  if (hasText(snapshot.summary)) {
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
  const paceText = [pace.statusText, pace.projectedText, pace.runsOutText]
    .filter((value): value is string => hasText(value))
    .join(", ");
  return `${label}: ${formatRemainingPercent(metric)} left (${formatUsedPercent(metric)} used)${hasText(reset) ? `, resets ${reset}` : ""}${hasText(paceText) ? `, ${paceText}` : ""}`;
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
  if (!Number.isFinite(metric.used) || !Number.isFinite(metric.limit) || metric.limit <= 0) {
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
  if (!hasText(trimmed)) {
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
  if (!hasText(value)) {
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

function maskEmail(value: string): string {
  const [local, domain] = value.split("@");
  if (!hasText(local) || !hasText(domain)) {
    return value;
  }

  const domainParts = domain.split(".");
  const tld = domainParts.length > 1 ? `.${domainParts.at(-1)}` : "";
  const localMasked = `${local.slice(0, 2)}***`;
  return `${localMasked}@***${tld}`;
}
