import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getContextPruneLastResult } from "../context-prune/public-api.js";
import { formatDurationHuman } from "../fetch/render.js";
import { formatCompactCount } from "./tps-metrics.js";

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
): void {
  const parts = [formatTPSSummary(usage, elapsedMs)];
  const pruneSummary = formatPruneSummary();
  if (pruneSummary !== undefined) {
    parts.push(pruneSummary);
  }
  ctx.ui.notify(parts.join(" · "), "info");
}

function formatTPSSummary(usage: UsageSummary, elapsedMs: number): string {
  const elapsedSeconds = elapsedMs / 1000;
  const tokensPerSecond = usage.output / elapsedSeconds;
  return `TPS ${tokensPerSecond.toFixed(1)} tok/s. out ${formatCompactCount(usage.output)}, in ${formatCompactCount(usage.input)}, cache r/w ${formatCompactCount(usage.cacheRead)}/${formatCompactCount(usage.cacheWrite)}, total ${formatCompactCount(usage.totalTokens)}, ${formatDurationHuman(elapsedMs)}`;
}

function formatPruneSummary(): string | undefined {
  const result = getContextPruneLastResult();
  if (result === undefined || !result.ok) {
    return undefined;
  }
  if (result.reason === "skipped-oversized") {
    return `prune skipped ${result.toolCallCount} tools`;
  }
  return `pruned ${result.toolCallCount} tools/${result.batchCount} batches, ${formatCompactCount(result.rawCharCount)}→${formatCompactCount(result.summaryCharCount)} chars`;
}
