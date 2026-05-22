import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { addToTotals, computeCacheHitPercent, emptyTotals } from "./cache-math.js";
import type { AssistantUsageMetric, CacheSessionMetrics } from "./types.js";

function isAssistantMessageEntry(entry: SessionEntry): entry is Extract<
  SessionEntry,
  { type: "message" }
> & {
  message: AssistantMessage;
} {
  return entry.type === "message" && entry.message.role === "assistant";
}

type SessionReader = Pick<SessionManager, "getEntries" | "getBranch">;

export function collectCacheSessionMetrics(sessionManager: SessionReader): CacheSessionMetrics {
  const allEntries = sessionManager.getEntries();
  const activeBranchIds = new Set(sessionManager.getBranch().map((entry) => entry.id));

  const treeTotals = emptyTotals();
  const activeBranchTotals = emptyTotals();
  const allMessages: AssistantUsageMetric[] = [];
  const activeBranchMessages: AssistantUsageMetric[] = [];

  let sequence = 0;
  let activeBranchSequence = 0;

  for (const entry of allEntries) {
    if (!isAssistantMessageEntry(entry)) continue;

    sequence += 1;

    const metric: AssistantUsageMetric = {
      sequence,
      activeBranchSequence: undefined,
      entryId: entry.id,
      timestamp: entry.timestamp,
      provider: entry.message.provider,
      model: entry.message.model,
      input: entry.message.usage.input,
      output: entry.message.usage.output,
      cacheRead: entry.message.usage.cacheRead,
      cacheWrite: entry.message.usage.cacheWrite,
      totalTokens: entry.message.usage.totalTokens,
      cacheHitPercent: computeCacheHitPercent(
        entry.message.usage.input,
        entry.message.usage.cacheRead,
        entry.message.usage.cacheWrite,
      ),
      isOnActiveBranch: activeBranchIds.has(entry.id),
    };

    addToTotals(treeTotals, metric);
    allMessages.push(metric);

    if (metric.isOnActiveBranch) {
      activeBranchSequence += 1;
      metric.activeBranchSequence = activeBranchSequence;
      addToTotals(activeBranchTotals, metric);
      activeBranchMessages.push(metric);
    }
  }

  return {
    allMessages,
    activeBranchMessages,
    treeTotals,
    activeBranchTotals,
  };
}
