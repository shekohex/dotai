import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";

import type { ModeSpec } from "../src/mode-utils.js";
import {
  handleModeAssistantMessageEnd,
  restorePrimaryModelForMode,
  type ModeFailoverRuntime,
} from "../src/extensions/modes/failover.js";
import {
  classifyModelFailure,
  cooldownDelayMs,
  shouldFallbackImmediately,
} from "../src/extensions/modes/model-failure.js";
import { ModelHealthStore } from "../src/extensions/modes/model-health-store.js";
import { createTempDirSync } from "./test-utils/temp-paths.ts";

type FakeModel = Model<any>;

function createFakeModel(provider: string, id: string): FakeModel {
  return {
    provider,
    id,
    name: id,
    api: "openai-responses",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  } as FakeModel;
}

function createAssistantError(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
    provider: "primary",
    model: "main",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as AssistantMessage;
}

function createAssistantSuccess(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    stopReason: "stop",
    timestamp: Date.now(),
    provider: "primary",
    model: "main",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as AssistantMessage;
}

function createHarness() {
  const primary = createFakeModel("primary", "main");
  const fallback = createFakeModel("fallback", "backup");
  const secondFallback = createFakeModel("fallback", "second");
  const manual = createFakeModel("manual", "chosen");
  const models = new Map<string, FakeModel>([
    ["primary/main", primary],
    ["fallback/backup", fallback],
    ["fallback/second", secondFallback],
    ["manual/chosen", manual],
  ]);
  const rejectedModels = new Set<string>();
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses = new Map<string, string | undefined>();
  const thinkingLevels: string[] = [];
  const ctx = {
    model: primary,
    modelRegistry: {
      find(provider: string, modelId: string) {
        return models.get(`${provider}/${modelId}`);
      },
    },
    ui: {
      notify(message: string, type?: "info" | "warning" | "error") {
        notifications.push({ message, type });
      },
      setStatus(key: string, value: string | undefined) {
        statuses.set(key, value);
      },
      theme: {
        fg(_color: string, value: string) {
          return value;
        },
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    async setModel(model: FakeModel) {
      if (rejectedModels.has(`${model.provider}/${model.id}`)) return false;
      (ctx as { model: FakeModel }).model = model;
      return true;
    },
    setThinkingLevel(level: string) {
      thinkingLevels.push(level);
    },
  } as unknown as ExtensionAPI;
  const runtime: ModeFailoverRuntime = {
    healthStore: new ModelHealthStore(join(createTempDirSync("model-health-"), "health.json")),
  };
  const spec: ModeSpec = {
    provider: "primary",
    modelId: "main",
    thinkingLevel: "medium",
    fallbacks: [{ provider: "fallback", modelId: "backup", thinkingLevel: "low" }],
  };

  return {
    ctx,
    pi,
    runtime,
    spec,
    primary,
    fallback,
    secondFallback,
    manual,
    models,
    rejectedModels,
    notifications,
    statuses,
    thinkingLevels,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("classifyModelFailure", () => {
  it("classifies rate limits with retry delay", () => {
    const result = classifyModelFailure("429 RESOURCE_EXHAUSTED retryDelay: 2s");

    expect(result.kind).toBe("temporary_quota");
    expect(cooldownDelayMs(result)).toBe(2000);
  });

  it("classifies codex usage reset minutes", () => {
    const result = classifyModelFailure(
      "You have hit your ChatGPT usage limit. Try again in ~12 min.",
    );

    expect(result.kind).toBe("temporary_quota");
    expect(cooldownDelayMs(result)).toBe(720000);
  });

  it.each([
    "GoUsageLimitError",
    "FreeUsageLimitError",
    "available balance is too low",
    "insufficient_quota",
    "out of budget",
    "quota exceeded",
    "billing hard limit reached",
  ])("classifies upstream Codex terminal quota errors as billing: %s", (message) => {
    const result = classifyModelFailure(message);

    expect(result.kind).toBe("billing");
    expect(shouldFallbackImmediately(result)).toBe(true);
  });

  it.each(["usage_limit_reached", "usage_not_included", "rate_limit_exceeded"])(
    "classifies upstream Codex usage codes as rate limits: %s",
    (message) => {
      const result = classifyModelFailure(message);

      expect(result.kind).toBe("rate_limit");
      expect(shouldFallbackImmediately(result)).toBe(true);
    },
  );

  it("classifies transient unavailable errors separately", () => {
    const result = classifyModelFailure("503 service unavailable: upstream connect timeout");

    expect(result.kind).toBe("unavailable");
  });

  it.each([
    "overloaded",
    "service unavailable",
    "upstream connect error",
    "connection refused",
    "Failed after retries",
    "No response body",
    "Request failed",
    "Codex SSE response headers timed out after 10000ms",
    "WebSocket transport is not available in this runtime",
    "WebSocket stream closed before response.completed",
    "Invalid Codex SSE JSON: unexpected token",
    "Invalid Codex WebSocket JSON: unexpected token",
  ])("classifies upstream Codex retryable errors as unavailable: %s", (message) => {
    const result = classifyModelFailure(message);

    expect(result.kind).toBe("unavailable");
  });

  it("classifies generic OpenAI processing failures as unavailable", () => {
    const result = classifyModelFailure(
      "Error: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID e4f5a936-060b-4a3d-a4a2-542b8b2eb602 in your message.",
    );

    expect(result.kind).toBe("unavailable");
  });

  it("does not classify embedded 429 digits as rate limits", () => {
    const result = classifyModelFailure("server returned error 14293 for request");

    expect(result.kind).toBe("unknown");
  });

  it("falls back immediately for quota and billing limits", () => {
    const result = classifyModelFailure("Monthly usage limit reached");

    expect(result.kind).toBe("billing");
    expect(shouldFallbackImmediately(result)).toBe(true);
  });
});

describe("upstream agent auto-retry patch", () => {
  type RetryableAgentSession = {
    _isNonRetryableProviderLimitError(errorMessage: string): boolean;
    _isRetryableError(message: AssistantMessage): boolean;
  };

  const retryablePrototype = AgentSession.prototype as unknown as RetryableAgentSession;

  function isRetryableError(errorMessage: string): boolean {
    return retryablePrototype._isRetryableError.call(
      {
        model: createFakeModel("codex-openai", "gpt-5.5"),
        _isNonRetryableProviderLimitError: retryablePrototype._isNonRetryableProviderLimitError,
      },
      createAssistantError(errorMessage),
    );
  }

  it("retries the generic OpenAI processing failure before failover", () => {
    expect(
      isRetryableError(
        "Error: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID a657e1a1-8f81-4710-899c-67bb595a1c6c in your message.",
      ),
    ).toBe(true);
  });

  it.each([
    "Failed after retries",
    "No response body",
    "Request failed",
    "WebSocket transport is not available in this runtime",
    "WebSocket stream closed before response.completed",
    "Invalid Codex SSE JSON: unexpected token",
    "Invalid Codex WebSocket JSON: unexpected token",
  ])("retries upstream Codex transient errors: %s", (message) => {
    expect(isRetryableError(message)).toBe(true);
  });

  it("does not retry upstream Codex terminal billing errors", () => {
    expect(isRetryableError("GoUsageLimitError: quota exceeded")).toBe(false);
  });
});

describe("ModelHealthStore", () => {
  it("tracks unavailable failures inside a window", () => {
    const store = new ModelHealthStore(join(createTempDirSync("model-health-"), "health.json"));

    expect(store.recordUnavailableFailure("provider/model", 60_000)).toBe(1);
    expect(store.recordUnavailableFailure("provider/model", 60_000)).toBe(2);
  });

  it("marks cooldowns and healthy state", () => {
    const store = new ModelHealthStore(join(createTempDirSync("model-health-"), "health.json"));

    store.markCooldown("provider/model", "rate_limit", 60_000, "429");
    expect(store.isCoolingDown("provider/model")).toBe(true);

    store.markHealthy("provider/model");
    expect(store.isCoolingDown("provider/model")).toBe(false);
  });

  it("does not write healthy entries without tracked state", () => {
    const path = join(createTempDirSync("model-health-"), "health.json");
    const store = new ModelHealthStore(path);

    store.markHealthy("provider/model");

    expect(existsSync(path)).toBe(false);
  });

  it("keeps malformed health files visible while falling back to empty state", () => {
    const path = join(createTempDirSync("model-health-"), "health.json");
    writeFileSync(path, "{", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new ModelHealthStore(path);

    expect(store.isCoolingDown("provider/model")).toBe(false);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to read model health file"));
    expect(readFileSync(path, "utf-8")).toBe("{");
    warn.mockRestore();
  });

  it("resets unavailable failures after the window expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const store = new ModelHealthStore(join(createTempDirSync("model-health-"), "health.json"));

    expect(store.recordUnavailableFailure("provider/model", 60_000)).toBe(1);
    expect(store.recordUnavailableFailure("provider/model", 60_000)).toBe(2);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.000Z"));
    expect(store.recordUnavailableFailure("provider/model", 60_000)).toBe(1);
  });

  it("does not shorten existing cooldowns", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const store = new ModelHealthStore(join(createTempDirSync("model-health-"), "health.json"));

    store.markCooldown("provider/model", "rate_limit", 60_000, "429");
    vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
    store.markCooldown("provider/model", "rate_limit", 1_000, "429");

    expect(store.availableAfterMs("provider/model")).toBe(50_000);
  });

  it("expires cooldowns on read", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const store = new ModelHealthStore(join(createTempDirSync("model-health-"), "health.json"));

    store.markCooldown("provider/model", "rate_limit", 1_000, "429");
    expect(store.isCoolingDown("provider/model")).toBe(true);

    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    expect(store.isCoolingDown("provider/model")).toBe(false);
  });
});

describe("mode failover event handling", () => {
  it("switches to fallback immediately on rate limit", async () => {
    const { ctx, pi, runtime, spec, fallback, thinkingLevels } = createHarness();

    await handleModeAssistantMessageEnd(
      pi,
      ctx,
      runtime,
      "build",
      spec,
      createAssistantError("429 RESOURCE_EXHAUSTED retryDelay: 2s"),
    );

    expect(ctx.model).toBe(fallback);
    expect(thinkingLevels).toEqual(["low"]);
    expect(runtime.healthStore.isCoolingDown("primary/main")).toBe(true);
  });

  it("waits for three unavailable failures before fallback", async () => {
    const { ctx, pi, runtime, spec, fallback } = createHarness();

    await handleModeAssistantMessageEnd(
      pi,
      ctx,
      runtime,
      "build",
      spec,
      createAssistantError("503 service unavailable"),
    );
    expect(ctx.model).not.toBe(fallback);

    await handleModeAssistantMessageEnd(
      pi,
      ctx,
      runtime,
      "build",
      spec,
      createAssistantError("503 service unavailable"),
    );
    expect(ctx.model).not.toBe(fallback);

    await handleModeAssistantMessageEnd(
      pi,
      ctx,
      runtime,
      "build",
      spec,
      createAssistantError("503 service unavailable"),
    );
    expect(ctx.model).toBe(fallback);
  });

  it("falls back after repeated OpenAI processing failures", async () => {
    const { ctx, pi, runtime, spec, fallback } = createHarness();
    const errorMessage =
      "Error: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID e4f5a936-060b-4a3d-a4a2-542b8b2eb602 in your message.";

    await handleModeAssistantMessageEnd(
      pi,
      ctx,
      runtime,
      "build",
      spec,
      createAssistantError(errorMessage),
    );
    expect(ctx.model).not.toBe(fallback);

    await handleModeAssistantMessageEnd(
      pi,
      ctx,
      runtime,
      "build",
      spec,
      createAssistantError(errorMessage),
    );
    expect(ctx.model).not.toBe(fallback);

    await handleModeAssistantMessageEnd(
      pi,
      ctx,
      runtime,
      "build",
      spec,
      createAssistantError(errorMessage),
    );
    expect(ctx.model).toBe(fallback);
  });

  it("success clears unavailable failure counter", async () => {
    const { ctx, pi, runtime, spec, fallback } = createHarness();

    await handleModeAssistantMessageEnd(
      pi,
      ctx,
      runtime,
      "build",
      spec,
      createAssistantError("503 service unavailable"),
    );
    await handleModeAssistantMessageEnd(
      pi,
      ctx,
      runtime,
      "build",
      spec,
      createAssistantError("503 service unavailable"),
    );
    await handleModeAssistantMessageEnd(pi, ctx, runtime, "build", spec, createAssistantSuccess());
    await handleModeAssistantMessageEnd(
      pi,
      ctx,
      runtime,
      "build",
      spec,
      createAssistantError("503 service unavailable"),
    );

    expect(ctx.model).not.toBe(fallback);
  });

  it("cascades to later fallback when earlier candidates are cooling", async () => {
    const { ctx, pi, runtime, spec, secondFallback } = createHarness();
    spec.fallbacks = [
      { provider: "fallback", modelId: "backup", thinkingLevel: "low" },
      { provider: "fallback", modelId: "second", thinkingLevel: "medium" },
    ];
    runtime.healthStore.markCooldown("fallback/backup", "rate_limit", 60_000, "429");

    await handleModeAssistantMessageEnd(
      pi,
      ctx,
      runtime,
      "build",
      spec,
      createAssistantError("429 RESOURCE_EXHAUSTED"),
    );

    expect(ctx.model).toBe(secondFallback);
  });

  it("does nothing when mode has no fallbacks", async () => {
    const { ctx, pi, runtime, spec, primary } = createHarness();
    spec.fallbacks = undefined;

    await handleModeAssistantMessageEnd(
      pi,
      ctx,
      runtime,
      "build",
      spec,
      createAssistantError("429 RESOURCE_EXHAUSTED"),
    );

    expect(ctx.model).toBe(primary);
  });

  it("does nothing when current model is outside candidate chain", async () => {
    const { ctx, pi, runtime, spec, manual } = createHarness();
    (ctx as { model: FakeModel }).model = manual;

    await handleModeAssistantMessageEnd(
      pi,
      ctx,
      runtime,
      "build",
      spec,
      createAssistantError("429 RESOURCE_EXHAUSTED"),
    );

    expect(ctx.model).toBe(manual);
  });

  it("skips missing fallback models and uses later valid fallback", async () => {
    const { ctx, pi, runtime, spec, secondFallback, models } = createHarness();
    models.delete("fallback/backup");
    spec.fallbacks = [
      { provider: "fallback", modelId: "backup", thinkingLevel: "low" },
      { provider: "fallback", modelId: "second", thinkingLevel: "medium" },
    ];

    await handleModeAssistantMessageEnd(
      pi,
      ctx,
      runtime,
      "build",
      spec,
      createAssistantError("429 RESOURCE_EXHAUSTED"),
    );

    expect(ctx.model).toBe(secondFallback);
  });

  it("skips fallback candidates rejected by setModel", async () => {
    const { ctx, pi, runtime, spec, secondFallback, rejectedModels } = createHarness();
    rejectedModels.add("fallback/backup");
    spec.fallbacks = [
      { provider: "fallback", modelId: "backup", thinkingLevel: "low" },
      { provider: "fallback", modelId: "second", thinkingLevel: "medium" },
    ];

    await handleModeAssistantMessageEnd(
      pi,
      ctx,
      runtime,
      "build",
      spec,
      createAssistantError("429 RESOURCE_EXHAUSTED"),
    );

    expect(ctx.model).toBe(secondFallback);
  });

  it("uses mode thinking level when fallback candidate has none", async () => {
    const { ctx, pi, runtime, spec, thinkingLevels } = createHarness();
    spec.fallbacks = [{ provider: "fallback", modelId: "backup" }];

    await handleModeAssistantMessageEnd(
      pi,
      ctx,
      runtime,
      "build",
      spec,
      createAssistantError("429 RESOURCE_EXHAUSTED"),
    );

    expect(thinkingLevels).toEqual(["medium"]);
  });

  it("ignores non-fallback failure classifications", async () => {
    const { ctx, pi, runtime, spec, primary } = createHarness();

    await handleModeAssistantMessageEnd(
      pi,
      ctx,
      runtime,
      "build",
      spec,
      createAssistantError("Authentication failed for provider"),
    );

    expect(ctx.model).toBe(primary);
  });

  it("keeps cooling primary off when it was reselected", async () => {
    const { ctx, pi, runtime, spec, fallback } = createHarness();
    runtime.healthStore.markCooldown("primary/main", "rate_limit", 60_000, "429");

    await restorePrimaryModelForMode(pi, ctx, runtime, "build", spec);

    expect(ctx.model).toBe(fallback);
  });

  it("restores primary after cooldown expires", async () => {
    const { ctx, pi, runtime, spec, primary, fallback } = createHarness();
    (ctx as { model: FakeModel }).model = fallback;

    await restorePrimaryModelForMode(pi, ctx, runtime, "build", spec);

    expect(ctx.model).toBe(primary);
  });

  it("clears fallback status after restoring primary", async () => {
    const { ctx, pi, runtime, spec, statuses } = createHarness();

    await handleModeAssistantMessageEnd(
      pi,
      ctx,
      runtime,
      "build",
      spec,
      createAssistantError("429 RESOURCE_EXHAUSTED"),
    );
    expect(statuses.get("mode-fallback")).toContain("fallback:fallback/backup");
    runtime.healthStore.markHealthy("primary/main");

    await restorePrimaryModelForMode(pi, ctx, runtime, "build", spec);

    expect(statuses.get("mode-fallback")).toBeUndefined();
  });
});
