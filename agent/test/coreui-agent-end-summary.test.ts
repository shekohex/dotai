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

const stats = {
  current: 16.1,
  min: 11.7,
  median: 14.8,
  max: 16.1,
  sampleCount: 3,
  bufferSize: 50,
};

describe("agent end summary", () => {
  test("includes TPS without stale prune stats", () => {
    clearContextPruneLastResult();
    const { messages, ctx } = createNotifyContext();
    notifyAgentEndSummary(
      ctx,
      { input: 10, output: 20, cacheRead: 5, cacheWrite: 2, totalTokens: 37 },
      2_000,
      stats,
      "5h 94% wk 61%",
      123,
    );
    expect(messages[0]).toContain("󰓅 16.1/14.8/11.7");
    expect(messages[0]).toContain(" 10");
    expect(messages[0]).toContain(" 20");
    expect(messages[0]).toContain("󰍛 r 5 w 2");
    expect(messages[0]).toContain("5h 94% wk 61%");
    expect(messages[0]).toContain("ttft 123ms");
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
      stats,
      undefined,
      undefined,
    );
    expect(messages[0]).toContain("󰓅 16.1/14.8/11.7");
    expect(messages[0]).toContain("󰩫 4t/2b");
    clearContextPruneLastResult();
  });

  test("omits cache write when zero", () => {
    clearContextPruneLastResult();
    const { messages, ctx } = createNotifyContext();
    notifyAgentEndSummary(
      ctx,
      { input: 10, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 37 },
      2_000,
      stats,
      undefined,
      undefined,
    );
    expect(messages[0]).toContain("󰍛 r 5");
    expect(messages[0]).not.toContain(" w 0");
  });
});
