import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  OPENUSAGE_STATUS_KEY,
  type ResetTimeFormat,
  type UsageMetric,
  type UsageSnapshot,
} from "./types.js";

export function renderStatus(snapshot: UsageSnapshot): string {
  const parts: string[] = [];

  if (snapshot.session5h) {
    parts.push(`5h ${formatRemainingPercent(snapshot.session5h)}`);
  }

  if (snapshot.weekly) {
    parts.push(`wk ${formatRemainingPercent(snapshot.weekly)}`);
  }

  if (parts.length === 0) {
    parts.push("5h n/a", "wk n/a");
  }

  return parts.join(" ");
}

export function formatRemainingPercent(metric: UsageMetric): string {
  const remaining = getRemainingPercent(metric);
  return remaining === undefined ? "n/a" : formatPercent(remaining);
}

export function formatUsedPercent(metric: UsageMetric): string {
  return formatPercent(getUsedPercent(metric));
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

  let text = theme.fg("dim", "5h ");
  text += sessionMetric
    ? colorForMetric(
        theme,
        sessionMetric,
        formatRemainingPercent(sessionMetric),
      )
    : theme.fg("muted", "n/a");

  text += theme.fg("dim", " wk ");
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
    lines.push(formatMetricLine("5h", snapshot.session5h, options));
  }

  if (snapshot.weekly) {
    lines.push(formatMetricLine("Weekly", snapshot.weekly, options));
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
  return `${label}: ${formatRemainingPercent(metric)} left (${formatUsedPercent(metric)} used)${reset ? `, resets ${reset}` : ""}`;
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
