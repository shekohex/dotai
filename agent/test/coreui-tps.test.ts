import test from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
  buildTPSStats,
  calculateIntervalTPS,
  estimateAssistantOutputTokens,
  resolveAssistantOutputTokens,
  restoreTPSState,
  summarizeAssistantUsage,
} from "../src/extensions/coreui/tps.ts";

const TEST_TIMEOUT_MS = 15_000;

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) => test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

function createAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

timedTest("summarizeAssistantUsage aggregates assistant usage only", () => {
  const assistantA = createAssistantMessage({
    usage: {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const assistantB = createAssistantMessage({
    usage: {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });

  const summary = summarizeAssistantUsage([
    { role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() },
    assistantA,
    assistantB,
  ] as any);

  assert.deepEqual(summary, {
    input: 11,
    output: 22,
    cacheRead: 33,
    cacheWrite: 44,
    totalTokens: 110,
  });
});

timedTest("estimateAssistantOutputTokens falls back to streamed content size", () => {
  const message = createAssistantMessage({
    content: [
      { type: "text", text: "abcd" },
      { type: "thinking", thinking: "abcdefgh", thinkingSignature: "sig" },
      { type: "toolCall", id: "call_1", name: "read", arguments: { path: "src/index.ts" } },
    ],
  });

  const expectedCharacters = 4 + 8 + "read".length + JSON.stringify({ path: "src/index.ts" }).length;
  assert.equal(estimateAssistantOutputTokens(message), Math.max(1, Math.round(expectedCharacters / 4)));
});

timedTest("resolveAssistantOutputTokens prefers provider usage when available", () => {
  const message = createAssistantMessage({
    content: [{ type: "text", text: "this should be ignored" }],
    usage: {
      input: 0,
      output: 42,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 42,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });

  assert.equal(resolveAssistantOutputTokens(message), 42);
});

timedTest("buildTPSStats returns current max median and min", () => {
  assert.deepEqual(buildTPSStats([42.1, 55.4, 39.2, 48.6]), {
    current: 48.6,
    max: 55.4,
    median: 45.4,
    min: 39.2,
    sampleCount: 4,
    bufferSize: 50,
  });
});

timedTest("calculateIntervalTPS uses interval deltas rather than cumulative averages", () => {
  assert.equal(calculateIntervalTPS(20, 500), 40);
  assert.equal(calculateIntervalTPS(10, 1000), 10);
  assert.equal(calculateIntervalTPS(0, 1000), undefined);
});

timedTest("restoreTPSState rehydrates latest stats and visibility from custom entries", () => {
  const restored = restoreTPSState([
    {
      type: "custom",
      id: "1",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "coreui:tps",
      data: {
        stats: { current: 42.1, max: 55.4, median: 45.4, min: 39.2, sampleCount: 50, bufferSize: 50 },
        elapsedMs: 1000,
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        totalTokens: 10,
      },
    },
    {
      type: "custom",
      id: "2",
      parentId: "1",
      timestamp: new Date().toISOString(),
      customType: "coreui:tps-visibility",
      data: { visible: false },
    },
  ] as any);

  assert.deepEqual(restored, {
    tps: { current: 42.1, max: 55.4, median: 45.4, min: 39.2, sampleCount: 50, bufferSize: 50 },
    tpsVisible: false,
  });
});

timedTest("restoreTPSState accepts older persisted TPS entries without buffer metadata", () => {
  const restored = restoreTPSState([
    {
      type: "custom",
      id: "1",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "coreui:tps",
      data: {
        stats: { current: 40.5, max: 45.4, median: 33.3, min: 0.6 },
        elapsedMs: 13320,
        input: 4748,
        output: 540,
        cacheRead: 160640,
        cacheWrite: 0,
        totalTokens: 165928,
      },
    },
  ] as any);

  assert.deepEqual(restored, {
    tps: { current: 40.5, max: 45.4, median: 33.3, min: 0.6, sampleCount: 50, bufferSize: 50 },
    tpsVisible: true,
  });
});
