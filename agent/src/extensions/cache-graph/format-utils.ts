import { computeCacheHitPercent } from "./cache-math.js";
import type { CacheUsageTotals } from "./types.js";

export function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(value));
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function shortModelName(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export function summarizeHitPercent(totals: CacheUsageTotals): number {
  return computeCacheHitPercent(totals.input, totals.cacheRead, totals.cacheWrite);
}

export function formatTotalsLine(label: string, totals: CacheUsageTotals): string {
  return [
    `${label}:`,
    `${formatInt(totals.assistantMessages)} turns`,
    `prompt ${formatInt(totals.input + totals.cacheRead + totals.cacheWrite)}`,
    `received ${formatInt(totals.output)}`,
    `cache hit ${formatInt(totals.cacheRead)}`,
    `cache write ${formatInt(totals.cacheWrite)}`,
    `hit rate ${formatPercent(summarizeHitPercent(totals))}`,
  ].join(" • ");
}
