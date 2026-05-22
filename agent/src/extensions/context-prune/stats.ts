import type { SummarizerStats } from "./types.js";
import { CUSTOM_TYPE_STATS } from "./types.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isCustomEntry, isRecord } from "./guards.js";

interface SummarizerStatsData {
  totalInputTokens?: unknown;
  totalOutputTokens?: unknown;
  totalCost?: unknown;
  callCount?: unknown;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

function isSummarizerStatsData(value: unknown): value is SummarizerStatsData {
  return isRecord(value);
}

export class StatsAccumulator {
  private stats: SummarizerStats = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    callCount: 0,
  };

  add(usage: Usage): void {
    this.stats.totalInputTokens += usage.input ?? 0;
    this.stats.totalOutputTokens += usage.output ?? 0;
    this.stats.totalCost += usage.cost?.total ?? 0;
    this.stats.callCount += 1;
  }

  getStats(): SummarizerStats {
    return { ...this.stats };
  }

  reset(): void {
    this.stats = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      callCount: 0,
    };
  }

  toJSON(): SummarizerStats {
    return { ...this.stats };
  }

  fromJSON(data: SummarizerStatsData): void {
    this.stats = {
      totalInputTokens: typeof data.totalInputTokens === "number" ? data.totalInputTokens : 0,
      totalOutputTokens: typeof data.totalOutputTokens === "number" ? data.totalOutputTokens : 0,
      totalCost: typeof data.totalCost === "number" ? data.totalCost : 0,
      callCount: typeof data.callCount === "number" ? data.callCount : 0,
    };
  }

  reconstructFromSession(ctx: ExtensionContext): void {
    this.reset();
    const branch = ctx.sessionManager.getBranch();
    for (const entry of branch) {
      if (isCustomEntry(entry, CUSTOM_TYPE_STATS, isSummarizerStatsData)) {
        this.fromJSON(entry.data);
      }
    }
  }

  persist(pi: ExtensionAPI): void {
    pi.appendEntry(CUSTOM_TYPE_STATS, this.toJSON());
  }
}

export function formatCompactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatTokens(n: number): string {
  return formatCompactCount(n);
}

export function formatCharProgress(receivedChars: number, rawChars?: number): string {
  const receivedLabel = `${formatCompactCount(receivedChars)} summary char${receivedChars === 1 ? "" : "s"}`;
  if (rawChars === null || rawChars === undefined) return receivedLabel;
  return `${receivedLabel} / ${formatCompactCount(rawChars)} raw char${rawChars === 1 ? "" : "s"}`;
}

export function formatCost(n: number): string {
  if (n < 0.001 && n > 0) return `<$0.001`;
  return `$${n.toFixed(3)}`;
}

export function statsSuffix(stats: SummarizerStats): string {
  if (stats.callCount === 0) return "";
  return ` │ ↑${formatTokens(stats.totalInputTokens)} ↓${formatTokens(stats.totalOutputTokens)} ${formatCost(stats.totalCost)}`;
}
