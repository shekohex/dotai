import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantUsageMetric, CacheSessionMetrics } from "./types.js";
import {
  formatInt,
  formatPercent,
  formatTotalsLine,
  shortModelName,
  summarizeHitPercent,
} from "./format-utils.js";

function pad(value: string, width: number, direction: "left" | "right" = "right"): string {
  if (value.length >= width) return value;
  const padding = " ".repeat(width - value.length);
  return direction === "left" ? padding + value : value + padding;
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return width <= 1 ? value.slice(0, width) : `${value.slice(0, Math.max(0, width - 1))}…`;
}

function buildRow(
  metric: AssistantUsageMetric,
  includeEntryId: boolean,
  includeTimestamp: boolean,
): string {
  const cols = [
    pad(String(metric.sequence), 4, "left"),
    pad(metric.isOnActiveBranch ? "*" : " ", 1),
    pad(truncate(shortModelName(metric.provider, metric.model), 24), 24),
    pad(formatInt(metric.input + metric.cacheRead + metric.cacheWrite), 9, "left"),
    pad(formatInt(metric.output), 9, "left"),
    pad(formatInt(metric.cacheRead), 9, "left"),
    pad(formatInt(metric.cacheWrite), 9, "left"),
    pad(formatPercent(metric.cacheHitPercent), 7, "left"),
  ];

  if (includeEntryId) cols.splice(2, 0, pad(metric.entryId, 8));
  if (includeTimestamp)
    cols.splice(includeEntryId ? 3 : 2, 0, pad(metric.timestamp.slice(11, 19), 8));

  return cols.join(" ");
}

function buildHeader(includeEntryId: boolean, includeTimestamp: boolean): string {
  const cols = [
    pad("#", 4, "left"),
    pad("B", 1),
    pad("model", 24),
    pad("prompt", 9, "left"),
    pad("recv", 9, "left"),
    pad("hit", 9, "left"),
    pad("write", 9, "left"),
    pad("hit%", 7, "left"),
  ];

  if (includeEntryId) cols.splice(2, 0, pad("entry", 8));
  if (includeTimestamp) cols.splice(includeEntryId ? 3 : 2, 0, pad("time", 8));

  return cols.join(" ");
}

function buildCumulativeSummary(theme: Theme, metrics: CacheSessionMetrics): string[] {
  const treeHitRate = summarizeHitPercent(metrics.treeTotals);
  const branchHitRate = summarizeHitPercent(metrics.activeBranchTotals);

  return [
    theme.fg("accent", theme.bold("Cumulative totals")),
    formatTotalsLine("Active branch", metrics.activeBranchTotals),
    formatTotalsLine("Whole tree", metrics.treeTotals),
    `Delta (tree - branch): prompt ${formatInt(metrics.treeTotals.input + metrics.treeTotals.cacheRead + metrics.treeTotals.cacheWrite - (metrics.activeBranchTotals.input + metrics.activeBranchTotals.cacheRead + metrics.activeBranchTotals.cacheWrite))} • ` +
      `received ${formatInt(metrics.treeTotals.output - metrics.activeBranchTotals.output)} • ` +
      `cache hit ${formatInt(metrics.treeTotals.cacheRead - metrics.activeBranchTotals.cacheRead)} • ` +
      `cache write ${formatInt(metrics.treeTotals.cacheWrite - metrics.activeBranchTotals.cacheWrite)} • ` +
      `hit-rate spread ${formatPercent(treeHitRate - branchHitRate)}`,
  ];
}

export function renderStatsBody(
  theme: Theme,
  metrics: CacheSessionMetrics,
  width: number,
): string[] {
  const lines: string[] = [
    theme.fg("accent", theme.bold("Token/cache stats by assistant message")),
    theme.fg("dim", "B = message is on the current active branch"),
    "",
    ...buildCumulativeSummary(theme, metrics),
    "",
  ];

  if (metrics.allMessages.length === 0) {
    lines.push(
      theme.fg(
        "warning",
        "No assistant messages with usage data are available yet in this session.",
      ),
    );
    return lines;
  }

  const includeEntryId = width >= 92;
  const includeTimestamp = width >= 104;
  const header = buildHeader(includeEntryId, includeTimestamp);

  lines.push(theme.fg("accent", theme.bold("Per-message breakdown")));
  lines.push(theme.fg("muted", header));
  lines.push(theme.fg("dim", "-".repeat(Math.min(header.length, Math.max(20, width - 2)))));

  for (const metric of metrics.allMessages) {
    lines.push(buildRow(metric, includeEntryId, includeTimestamp));
  }

  return lines;
}
