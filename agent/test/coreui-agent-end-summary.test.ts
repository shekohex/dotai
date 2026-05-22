import { describe, expect, test } from "vitest";
import { notifyAgentEndSummary } from "../src/extensions/coreui/agent-end-summary.js";
import {
  clearContextPruneLastResult,
  setContextPruneLastResult,
} from "../src/extensions/context-prune/public-api.js";

function createNotifyContext(): { messages: string[]; ctx: never } {
  const messages: string[] = [];
  return {
    messages,
    ctx: {
      ui: {
        notify(message: string) {
          messages.push(message);
        },
      },
    } as never,
  };
}

describe("agent end summary", () => {
  test("includes TPS without stale prune stats", () => {
    clearContextPruneLastResult();
    const { messages, ctx } = createNotifyContext();
    notifyAgentEndSummary(
      ctx,
      { input: 10, output: 20, cacheRead: 5, cacheWrite: 2, totalTokens: 37 },
      2_000,
    );
    expect(messages[0]).toContain("TPS 10.0 tok/s");
    expect(messages[0]).not.toContain("pruned");
  });

  test("includes latest prune result next to TPS", () => {
    setContextPruneLastResult({
      ok: true,
      reason: "flushed",
      batchCount: 2,
      toolCallCount: 4,
      rawCharCount: 1_500,
      summaryCharCount: 300,
    });
    const { messages, ctx } = createNotifyContext();
    notifyAgentEndSummary(
      ctx,
      { input: 10, output: 20, cacheRead: 5, cacheWrite: 2, totalTokens: 37 },
      2_000,
    );
    expect(messages[0]).toContain("TPS 10.0 tok/s");
    expect(messages[0]).toContain("pruned 4 tools/2 batches");
    clearContextPruneLastResult();
  });
});
