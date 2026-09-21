import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import {
  isRateLimitedStreamFailure,
  parseRetryAfterMs,
} from "../src/extensions/observational-memory/agents/stream-errors.js";
import {
  modelKey,
  Runtime,
  type ResolveCtx,
  type ResolveResult,
} from "../src/extensions/observational-memory/runtime.js";

function fakeModel(provider: string, id: string): Model<Api> {
  return {
    provider,
    id,
    api: "openai-completions",
    baseUrl: "https://example.invalid",
    contextWindow: 128_000,
    maxTokens: 8_192,
  } as unknown as Model<Api>;
}

type RegistryModel = { provider: string; id: string };

type FakeRegistry = {
  models: RegistryModel[];
  /** Maps model key → headers payload returned by getApiKeyAndHeaders; missing → auth not ok. */
  auth: Map<string, { apiKey?: string; headers?: Record<string, string> }>;
};

function fakeRegistry(overrides: Partial<FakeRegistry> = {}): FakeRegistry {
  return { models: [], auth: new Map(), ...overrides };
}

function makeCtx(
  registry: FakeRegistry,
  sessionModel?: Model<Api>,
): ResolveCtx & { registry: FakeRegistry } {
  return {
    registry,
    model: sessionModel,
    modelRegistry: {
      find: (provider: string, id: string) =>
        registry.models.find((m) => m.provider === provider && m.id === id) as unknown as
          | Model<Api>
          | undefined,
      getApiKeyAndHeaders: (model: unknown) => {
        const key = modelKey(model as RegistryModel);
        const auth = registry.auth.get(key);
        if (auth === undefined) {
          return Promise.resolve({ ok: false as const, error: "no credential" });
        }
        return Promise.resolve({ ok: true as const, ...auth });
      },
      hasConfiguredAuth: () => false,
      isUsingOAuth: () => false,
    },
    hasUI: false,
  };
}

function useChain(runtime: Runtime, registry: FakeRegistry, candidates: RegistryModel[]): void {
  registry.models.push(...candidates);
  for (const candidate of candidates) {
    registry.auth.set(modelKey(candidate), { apiKey: `key-${modelKey(candidate)}` });
  }
  runtime.config.model = { provider: candidates[0]!.provider, id: candidates[0]!.id };
  runtime.config.fallbackModels = candidates
    .slice(1)
    .map((c) => ({ provider: c.provider, id: c.id }));
}

function expectModel(result: ResolveResult, provider: string, id: string): void {
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.model.provider).toBe(provider);
  expect(result.model.id).toBe(id);
}

describe("observational memory model fallback chain", () => {
  test("uses the primary model when it resolves", async () => {
    const runtime = new Runtime();
    const registry = fakeRegistry();
    useChain(runtime, registry, [
      { provider: "codex-openai", id: "gpt-5.6-luna" },
      { provider: "zai", id: "glm-5.3-flash" },
    ]);
    const result = await runtime.resolveModel(makeCtx(registry));
    expectModel(result, "codex-openai", "gpt-5.6-luna");
  });

  test("skips an unauthenticated primary and uses the first fallback", async () => {
    const runtime = new Runtime();
    const registry = fakeRegistry();
    useChain(runtime, registry, [
      { provider: "codex-openai", id: "gpt-5.6-luna" },
      { provider: "zai", id: "glm-5.3-flash" },
    ]);
    registry.auth.delete("codex-openai/gpt-5.6-luna");
    const result = await runtime.resolveModel(makeCtx(registry));
    expectModel(result, "zai", "glm-5.3-flash");
  });

  test("skips a missing fallback and reaches the next candidate", async () => {
    const runtime = new Runtime();
    const registry = fakeRegistry();
    useChain(runtime, registry, [
      { provider: "codex-openai", id: "gpt-5.6-luna" },
      { provider: "zai", id: "glm-5.3-flash" },
      { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    ]);
    registry.auth.delete("codex-openai/gpt-5.6-luna");
    registry.models = registry.models.filter((m) => m.provider !== "zai");
    const result = await runtime.resolveModel(makeCtx(registry));
    expectModel(result, "opencode-go", "deepseek-v4.1-flash");
  });

  test("falls back to the session model when the whole chain is rejected", async () => {
    const runtime = new Runtime();
    const registry = fakeRegistry();
    useChain(runtime, registry, [{ provider: "codex-openai", id: "gpt-5.6-luna" }]);
    registry.auth.delete("codex-openai/gpt-5.6-luna");
    const sessionModel = fakeModel("zai", "glm-5.3-flash");
    registry.auth.set("zai/glm-5.3-flash", { apiKey: "session-key" });
    const result = await runtime.resolveModel(makeCtx(registry, sessionModel));
    expectModel(result, "zai", "glm-5.3-flash");
  });

  test("excludes failed keys passed via skip, even the session model", async () => {
    const runtime = new Runtime();
    const registry = fakeRegistry();
    useChain(runtime, registry, [
      { provider: "codex-openai", id: "gpt-5.6-luna" },
      { provider: "zai", id: "glm-5.3-flash" },
    ]);
    const skip = new Set([modelKey({ provider: "codex-openai", id: "gpt-5.6-luna" })]);
    const sessionModel = fakeModel("zai", "glm-5.3-flash");
    registry.auth.set("zai/glm-5.3-flash", { apiKey: "session-key" });
    const result = await runtime.resolveModel(makeCtx(registry, sessionModel), skip);
    expectModel(result, "zai", "glm-5.3-flash");

    const exhausted = await runtime.resolveModel(
      makeCtx(registry, sessionModel),
      new Set([
        modelKey({ provider: "codex-openai", id: "gpt-5.6-luna" }),
        modelKey({ provider: "zai", id: "glm-5.3-flash" }),
      ]),
    );
    expect(exhausted.ok).toBe(false);
  });

  test("cooldown skips a rate-limited primary until it expires, then returns to it", async () => {
    const runtime = new Runtime();
    const registry = fakeRegistry();
    useChain(runtime, registry, [
      { provider: "codex-openai", id: "gpt-5.6-luna" },
      { provider: "zai", id: "glm-5.3-flash" },
    ]);
    runtime.noteModelCooldown("codex-openai", "gpt-5.6-luna", 60_000);
    const during = await runtime.resolveModel(makeCtx(registry));
    expectModel(during, "zai", "glm-5.3-flash");

    runtime.modelCooldowns.set(
      modelKey({ provider: "codex-openai", id: "gpt-5.6-luna" }),
      Date.now() - 1,
    );
    const after = await runtime.resolveModel(makeCtx(registry));
    expectModel(after, "codex-openai", "gpt-5.6-luna");
    expect(runtime.modelCooldowns.has("codex-openai/gpt-5.6-luna")).toBe(false);
  });

  test("carries the per-candidate thinking level on the resolved payload", async () => {
    const runtime = new Runtime();
    const registry = fakeRegistry();
    useChain(runtime, registry, [
      { provider: "codex-openai", id: "gpt-5.6-luna" },
      { provider: "zai", id: "glm-5.3-flash" },
    ]);
    runtime.config.fallbackModels = [{ provider: "zai", id: "glm-5.3-flash", thinking: "minimal" }];
    registry.models = registry.models.filter((m) => m.provider !== "codex-openai");
    const result = await runtime.resolveModel(makeCtx(registry));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.thinking).toBe("minimal");
  });
});

describe("rate-limit stream failure classification", () => {
  test("flags transient rate limits and overloads", () => {
    expect(
      isRateLimitedStreamFailure({
        stopReason: "error",
        errorMessage: "HTTP 429: too many requests",
      }),
    ).toBe(true);
    expect(
      isRateLimitedStreamFailure({ stopReason: "error", errorMessage: "provider is overloaded" }),
    ).toBe(true);
    expect(
      isRateLimitedStreamFailure({ stopReason: "error", errorMessage: "rate limit exceeded" }),
    ).toBe(true);
  });

  test("does not flag quota exhaustion, aborts, or other errors", () => {
    expect(
      isRateLimitedStreamFailure({ stopReason: "error", errorMessage: "insufficient_quota" }),
    ).toBe(false);
    expect(
      isRateLimitedStreamFailure({
        stopReason: "error",
        errorMessage: "Monthly usage limit reached",
      }),
    ).toBe(false);
    expect(isRateLimitedStreamFailure({ stopReason: "aborted", errorMessage: "rate limit" })).toBe(
      false,
    );
    expect(
      isRateLimitedStreamFailure({ stopReason: "error", errorMessage: "model not found" }),
    ).toBe(false);
  });

  test("parses provider retry hints and defaults cleanly", () => {
    expect(parseRetryAfterMs("Rate limited. Try again in 12s")).toBe(12_000);
    expect(parseRetryAfterMs("retry after 30 seconds")).toBe(30_000);
    expect(parseRetryAfterMs("no hint here")).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });
});
