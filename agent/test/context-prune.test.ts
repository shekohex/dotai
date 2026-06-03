import { Text } from "@earendil-works/pi-tui";
import { stream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  getContextPruneAPI,
  setContextPruneRuntime,
  type FlushResult,
} from "../src/extensions/context-prune/public-api.js";
import {
  abortReason,
  createPruneAbortController,
  safeSetPruneStatusWidget,
  shouldSkipUndersizedBatch,
} from "../src/extensions/context-prune/index.js";
import {
  renderContextPruneCall,
  renderContextPruneResult,
  renderContextTreeQueryCall,
  renderContextTreeQueryResult,
} from "../src/extensions/context-prune/tool-render.js";
import { DEFAULT_CONFIG } from "../src/extensions/context-prune/types.js";
import { summarizeBatch, summarizeBatches } from "../src/extensions/context-prune/summarizer.js";

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
  return { ...actual, stream: vi.fn() };
});

const theme = {
  fg: (_token: string, value: string) => value,
  bold: (value: string) => value,
  italic: (value: string) => value,
};

const renderContext = {
  isPartial: false,
  isError: false,
  lastComponent: undefined,
};

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function createModel(provider: string, id: string, api: Api, baseUrl = "https://example.com/v1") {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: usage.cost,
    contextWindow: 100000,
    maxTokens: 4096,
  } satisfies Model<Api>;
}

function createContext(models: Model<Api>[]): ExtensionContext {
  return {
    model: models[0],
    modelRegistry: {
      find(provider: string, id: string) {
        return models.find((model) => model.provider === provider && model.id === id);
      },
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "key", headers: {} };
      },
    },
    ui: { notify: vi.fn() },
  } as never;
}

function createBatch(resultText = "x".repeat(1000)) {
  return {
    turnIndex: 1,
    timestamp: 1,
    assistantText: "",
    toolCalls: [
      {
        toolCallId: "tool-1",
        toolName: "bash",
        args: {},
        resultText,
        isError: false,
      },
    ],
  };
}

function createResponseStream(text: string) {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "text_delta", contentIndex: 0, delta: text, partial: message };
    },
    result: async () => message,
  };
}

function streamMock() {
  return vi.mocked(stream);
}

afterEach(() => {
  vi.clearAllMocks();
});

function renderText(component: Text): string {
  return component.render(120).join("\n");
}

describe("context-prune public API", () => {
  test("flush proxy and prune callbacks work", async () => {
    const callbacks = new Set<(result: FlushResult) => void>();
    const result: FlushResult = {
      ok: true,
      reason: "flushed",
      batchCount: 1,
      toolCallCount: 2,
      rawCharCount: 100,
      summaryCharCount: 20,
    };
    setContextPruneRuntime({
      getConfig: () => ({ ...DEFAULT_CONFIG, enabled: true }),
      updateConfig() {},
      async flush() {
        for (const callback of callbacks) callback(result);
        return result;
      },
      pendingBatchCount: () => 1,
      onPrune(callback) {
        callbacks.add(callback);
        return () => {
          callbacks.delete(callback);
        };
      },
    });
    const api = getContextPruneAPI({} as never);
    expect(api?.enabled).toBe(true);
    api?.updateConfig({ enabled: false });
    const seen: FlushResult[] = [];
    const unsubscribe = api?.onPrune((value) => seen.push(value));
    await expect(api?.flush({ delivery: "session" })).resolves.toEqual(result);
    expect(seen).toEqual([result]);
    unsubscribe?.();
  });
});

describe("context-prune settings", () => {
  test("defaults expose both context prune tools", () => {
    expect(DEFAULT_CONFIG.tools).toEqual({ contextPrune: true, contextTreeQuery: true });
  });

  test("defaults skip tiny raw outputs before summarization", () => {
    expect(DEFAULT_CONFIG.minRawCharsToPrune).toBe(700);
    expect(
      shouldSkipUndersizedBatch(DEFAULT_CONFIG, {
        turnIndex: 1,
        timestamp: 1,
        assistantText: "",
        toolCalls: [
          {
            toolCallId: "tool-1",
            toolName: "read",
            args: {},
            resultText: "tiny result",
            isError: false,
          },
        ],
      }),
    ).toBe(true);
  });

  test("min raw size guard can be disabled", () => {
    expect(
      shouldSkipUndersizedBatch(
        { ...DEFAULT_CONFIG, minRawCharsToPrune: 0 },
        {
          turnIndex: 1,
          timestamp: 1,
          assistantText: "",
          toolCalls: [
            {
              toolCallId: "tool-1",
              toolName: "read",
              args: {},
              resultText: "tiny result",
              isError: false,
            },
          ],
        },
      ),
    ).toBe(false);
  });

  test("saves under contextPrune in main agent settings", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "context-prune-settings-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    vi.resetModules();
    const { saveConfig, loadConfig, SETTINGS_PATH } =
      await import("../src/extensions/context-prune/config.js");
    writeFileSync(SETTINGS_PATH, `${JSON.stringify({ modes: { current: "build" } })}\n`, "utf-8");
    await saveConfig({ ...DEFAULT_CONFIG, enabled: true, pruneOn: "on-demand" });
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
    expect(settings.modes).toEqual({ current: "build" });
    expect(settings.contextPrune).toMatchObject({ enabled: true, pruneOn: "on-demand" });
    await expect(loadConfig()).resolves.toMatchObject({ enabled: true, pruneOn: "on-demand" });
    delete process.env.PI_CODING_AGENT_DIR;
  });

  test("loads tool exposure settings", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "context-prune-tool-settings-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    vi.resetModules();
    const { loadConfig, SETTINGS_PATH } = await import("../src/extensions/context-prune/config.js");
    writeFileSync(
      SETTINGS_PATH,
      `${JSON.stringify({
        contextPrune: { tools: { contextPrune: false, contextTreeQuery: true } },
      })}\n`,
      "utf-8",
    );
    await expect(loadConfig()).resolves.toMatchObject({
      tools: { contextPrune: false, contextTreeQuery: true },
    });
    delete process.env.PI_CODING_AGENT_DIR;
  });

  test("migrates missing tool exposure settings", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "context-prune-missing-tools-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    vi.resetModules();
    const { loadConfig, SETTINGS_PATH } = await import("../src/extensions/context-prune/config.js");
    writeFileSync(
      SETTINGS_PATH,
      `${JSON.stringify({ contextPrune: { enabled: false, pruneOn: "on-demand" } })}\n`,
      "utf-8",
    );
    await expect(loadConfig()).resolves.toMatchObject({
      enabled: false,
      pruneOn: "on-demand",
      tools: { contextPrune: true, contextTreeQuery: true },
    });
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
    expect(settings.contextPrune).toMatchObject({
      enabled: false,
      pruneOn: "on-demand",
      tools: { contextPrune: true, contextTreeQuery: true },
    });
    delete process.env.PI_CODING_AGENT_DIR;
  });

  test("disabled context pruning strips both tools from active tools", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "context-prune-disabled-tools-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    vi.resetModules();
    const { SETTINGS_PATH } = await import("../src/extensions/context-prune/config.js");
    writeFileSync(
      SETTINGS_PATH,
      `${JSON.stringify({ contextPrune: { enabled: false, pruneOn: "agentic-auto" } })}\n`,
      "utf-8",
    );
    const { default: contextPruneExtension } =
      await import("../src/extensions/context-prune/index.js");
    let activeTools = ["read", "context_prune", "context_tree_query"];
    const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
    contextPruneExtension({
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      getActiveTools: () => activeTools,
      setActiveTools: (toolNames: string[]) => {
        activeTools = toolNames;
      },
      on: (eventName: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
      },
    } as never);
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({}, {
        ui: { setStatus: vi.fn() },
        sessionManager: { getBranch: () => [] },
      } as never);
    }
    expect(activeTools).toEqual(["read"]);
    delete process.env.PI_CODING_AGENT_DIR;
  });

  test("tool exposure settings strip individual active tools", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "context-prune-individual-tools-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    vi.resetModules();
    const { SETTINGS_PATH } = await import("../src/extensions/context-prune/config.js");
    writeFileSync(
      SETTINGS_PATH,
      `${JSON.stringify({
        contextPrune: {
          enabled: true,
          pruneOn: "agentic-auto",
          tools: { contextPrune: false, contextTreeQuery: true },
        },
      })}\n`,
      "utf-8",
    );
    const { default: contextPruneExtension } =
      await import("../src/extensions/context-prune/index.js");
    let activeTools = ["read", "context_prune"];
    const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
    contextPruneExtension({
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      getActiveTools: () => activeTools,
      setActiveTools: (toolNames: string[]) => {
        activeTools = toolNames;
      },
      on: (eventName: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
      },
    } as never);
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({}, {
        ui: { setStatus: vi.fn() },
        sessionManager: { getBranch: () => [] },
      } as never);
    }
    expect(activeTools).toEqual(["read", "context_tree_query"]);
    delete process.env.PI_CODING_AGENT_DIR;
  });

  test("context prune tool is inactive when query tool is disabled", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "context-prune-query-disabled-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    vi.resetModules();
    const { SETTINGS_PATH } = await import("../src/extensions/context-prune/config.js");
    writeFileSync(
      SETTINGS_PATH,
      `${JSON.stringify({
        contextPrune: {
          enabled: true,
          pruneOn: "agentic-auto",
          tools: { contextPrune: true, contextTreeQuery: false },
        },
      })}\n`,
      "utf-8",
    );
    const { default: contextPruneExtension } =
      await import("../src/extensions/context-prune/index.js");
    let activeTools = ["read", "context_prune", "context_tree_query"];
    const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
    contextPruneExtension({
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      getActiveTools: () => activeTools,
      setActiveTools: (toolNames: string[]) => {
        activeTools = toolNames;
      },
      on: (eventName: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
      },
    } as never);
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({}, {
        ui: { setStatus: vi.fn() },
        sessionManager: { getBranch: () => [] },
      } as never);
    }
    expect(activeTools).toEqual(["read"]);
    delete process.env.PI_CODING_AGENT_DIR;
  });
});

describe("context-prune summarizer", () => {
  test("uses OpenAI Responses API for LiteLLM Gemini models", async () => {
    const geminiModel = createModel(
      "gemini",
      "gemini-3.1-flash-lite-preview",
      "google-generative-ai",
      "https://gateway.example/v1beta",
    );
    const mock = streamMock();
    mock.mockReturnValue(createResponseStream("summary") as never);

    const result = await summarizeBatch(
      createBatch(),
      { ...DEFAULT_CONFIG, summarizerModels: ["gemini/gemini-3.1-flash-lite-preview"] },
      createContext([geminiModel]),
    );

    expect(result?.summaryText).toBe("summary");
    expect(mock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "gemini",
        id: "gemini-3.1-flash-lite-preview",
        api: "openai-responses",
        baseUrl: "https://gateway.example/v1",
        reasoning: false,
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  test("falls back immediately on rate limit and cools down model for parallel batches", async () => {
    const geminiModel = createModel(
      "gemini",
      "gemini-3.1-flash-lite-preview",
      "google-generative-ai",
    );
    const fallbackModel = createModel("opencode-go", "deepseek-v4-flash", "openai-completions");
    const mock = streamMock();
    mock.mockImplementation((model) => {
      if (model.provider === "gemini") {
        throw new Error(
          '429 RESOURCE_EXHAUSTED RetryInfo retryDelay: "2.015665228s" quotaResetDelay: "2.015665228s"',
        );
      }
      return createResponseStream(`summary from ${model.provider}`) as never;
    });

    const results = await summarizeBatches(
      [createBatch("a".repeat(1000)), createBatch("b".repeat(1000))],
      {
        ...DEFAULT_CONFIG,
        summarizerModels: ["gemini/gemini-3.1-flash-lite-preview", "opencode-go/deepseek-v4-flash"],
      },
      createContext([geminiModel, fallbackModel]),
    );

    expect(results.map((result) => result?.summaryText)).toEqual([
      "summary from opencode-go",
      "summary from opencode-go",
    ]);
    expect(mock.mock.calls.filter(([model]) => model.provider === "gemini")).toHaveLength(1);
    expect(mock.mock.calls.filter(([model]) => model.provider === "opencode-go")).toHaveLength(2);
  });
});

describe("context-prune cancellation", () => {
  test("combined abort controller follows context signal reason", () => {
    const source = new AbortController();
    const combined = createPruneAbortController(source.signal);
    source.abort("session switched");
    expect(combined.signal.aborted).toBe(true);
    expect(abortReason(combined.signal)).toBe("session switched");
  });

  test("status cleanup ignores stale context errors", () => {
    expect(() =>
      safeSetPruneStatusWidget(
        {
          ui: {
            setStatus() {
              throw new Error("This extension ctx is stale after session replacement or reload.");
            },
          },
        } as never,
        {
          currentConfig: { value: DEFAULT_CONFIG },
          stats: {
            getStats: () => ({
              callCount: 0,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              totalCost: 0,
            }),
          },
        },
      ),
    ).not.toThrow();
  });
});

describe("context-prune tool rendering", () => {
  test("context_prune renderers use compact rail status", () => {
    const call = renderContextPruneCall({}, theme, { ...renderContext, isPartial: true });
    const result = renderContextPruneResult(
      { details: { ok: true, reason: "flushed", toolCallCount: 3, batchCount: 1 } },
      {},
      theme,
      renderContext,
    );
    expect(call).toBeInstanceOf(Text);
    expect(result).toBeInstanceOf(Text);
    expect(renderText(call)).toContain("Pruning");
    expect(renderText(result)).toContain("Pruned");
  });

  test("context_tree_query renderers summarize refs and hits", () => {
    const call = renderContextTreeQueryCall({ toolCallIds: ["T1", "T2"] }, theme, renderContext);
    const result = renderContextTreeQueryResult(
      { details: { results: { T1: {}, T2: {} } } },
      {},
      theme,
      renderContext,
    );
    expect(renderText(call)).toContain("2 refs");
    expect(renderText(result)).toContain("2 found");
  });
});
