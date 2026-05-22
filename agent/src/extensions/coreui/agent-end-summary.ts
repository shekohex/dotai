import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getContextPruneLastResult } from "../context-prune/public-api.js";
import { formatDurationHuman } from "../fetch/render.js";
import { formatCompactCount } from "./tps-metrics.js";
import type { CoreUITPSStats } from "./types.js";

const TPS_ICON = "\u{F04C5}";
const INPUT_ICON = "";
const OUTPUT_ICON = "";
const TOTAL_ICON = "\u{F125F}";
const MEMORY_ICON = "\u{F035B}";
const PRUNE_ICON = "\u{F0A6B}";

interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export function notifyAgentEndSummary(
  ctx: ExtensionContext,
  usage: UsageSummary,
  elapsedMs: number,
  stats: CoreUITPSStats | undefined,
  openUsageStatus: string | undefined,
): void {
  const parts = [formatTPSSummary(usage, stats)];
  if (openUsageStatus !== undefined && openUsageStatus.length > 0) {
    parts.push(openUsageStatus);
  }
  const pruneSummary = formatPruneSummary();
  if (pruneSummary !== undefined) {
    parts.push(pruneSummary);
  }
  parts.push(formatDurationHuman(elapsedMs));
  ctx.ui.notify(parts.join(" · "), "info");
}

function formatTPSSummary(usage: UsageSummary, stats: CoreUITPSStats | undefined): string {
  const tpsText =
    stats === undefined
      ? "0.0/0.0/0.0"
      : `${stats.max.toFixed(1)}/${stats.median.toFixed(1)}/${stats.min.toFixed(1)}`;
  return `${TPS_ICON} ${tpsText} . ${INPUT_ICON} ${formatCompactCount(usage.input)} ${OUTPUT_ICON} ${formatCompactCount(usage.output)} ${TOTAL_ICON} ${formatCompactCount(usage.totalTokens)}, ${MEMORY_ICON} ${formatCacheUsage(usage)}`;
}

function formatCacheUsage(usage: UsageSummary): string {
  const read = `r ${formatCompactCount(usage.cacheRead)}`;
  const write = usage.cacheWrite > 0 ? ` w ${formatCompactCount(usage.cacheWrite)}` : "";
  return `${read}${write}`;
}

function formatPruneSummary(): string | undefined {
  const result = getContextPruneLastResult();
  if (result === undefined || !result.ok) {
    return undefined;
  }
  if (result.reason === "skipped-oversized") {
    return `${PRUNE_ICON} skipped ${result.toolCallCount}t`;
  }
  return `${PRUNE_ICON} ${result.toolCallCount}t/${result.batchCount}b, ${formatCompactCount(result.rawCharCount)}→${formatCompactCount(result.summaryCharCount)}`;
}
