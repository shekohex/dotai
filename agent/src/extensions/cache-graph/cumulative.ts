import { computeCacheHitPercent } from "./cache-math.js";
import type { AssistantUsageMetric } from "./types.js";

export interface CumulativeSeries {
  cumInput: number[];
  cumCacheRead: number[];
  cumCacheWrite: number[];
  cumHitPercent: number[];
}

/**
 * Computes running cumulative totals across all messages in session append order. Pure function —
 * no UI/theme dependency. Safe to reuse in future CSV export.
 *
 * @param {AssistantUsageMetric[]} messages - Assistant usage metrics in session append order.
 * @returns {CumulativeSeries} Running cumulative cache usage series.
 */
export function computeCumulativeSeries(messages: AssistantUsageMetric[]): CumulativeSeries {
  const cumInput: number[] = [];
  const cumCacheRead: number[] = [];
  const cumCacheWrite: number[] = [];
  const cumHitPercent: number[] = [];

  let sumInput = 0;
  let sumCacheRead = 0;
  let sumCacheWrite = 0;

  for (const msg of messages) {
    sumInput += msg.input;
    sumCacheRead += msg.cacheRead;
    sumCacheWrite += msg.cacheWrite;
    cumInput.push(sumInput);
    cumCacheRead.push(sumCacheRead);
    cumCacheWrite.push(sumCacheWrite);
    cumHitPercent.push(computeCacheHitPercent(sumInput, sumCacheRead, sumCacheWrite));
  }

  return { cumInput, cumCacheRead, cumCacheWrite, cumHitPercent };
}
