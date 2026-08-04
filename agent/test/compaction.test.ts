import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  buildSessionContext,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { isRetryableAssistantError } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/retry.js";
import compactionExtension, {
  buildSummaryMessages,
  isAbortSignalAborted,
} from "../src/extensions/compaction.js";
import {
  buildRemoteCompactionHistory,
  messageToResponseItems,
  messagesToResponseItems,
  normalizeResponseItemsForPrompt,
} from "../src/extensions/compaction/openai-remote-messages.js";
import {
  buildRemoteCompactionHeaders,
  buildRemoteCompactionRequestBody,
  callRemoteCompactionEndpoint,
  parseRemoteCompactionEvents,
  remoteCompactionEndpointUrl,
  remoteCompactionModelKey,
  supportsOpenAIRemoteCompaction,
} from "../src/extensions/compaction/openai-remote-protocol.js";
import { resolveRemoteCompactionRequestBudget } from "../src/extensions/compaction/openai-remote-request-shrink.js";
import {
  applyRemoteHistoryPayload,
  extractResponsesRequestShape,
  extractRemoteCompactionDetails,
  reconstructRemoteCompactionState,
} from "../src/extensions/compaction/openai-remote-state.js";

const builtinCodexModel = getBuiltinModels("openai-codex")[0];
if (builtinCodexModel === undefined) throw new Error("Missing builtin openai-codex model");

const openAICodexModel: Model<Api> = builtinCodexModel;
const codexOpenAIModel: Model<Api> = {
  ...builtinCodexModel,
  provider: "codex-openai",
  api: "openai-responses",
  baseUrl: "https://gateway.example/v1",
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CODEX_HOME;
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true });
});

function useTemporaryCodexHome(): void {
  const path = mkdtempSync(join(tmpdir(), "compaction-codex-home-"));
  temporaryDirectories.push(path);
  process.env.CODEX_HOME = path;
}

function codexToken(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

type CompactionHandler = (
  event: Record<string, unknown>,
  ctx: ExtensionContext,
) => Promise<unknown>;

type ProviderRequestHandler = (
  event: { payload: unknown },
  ctx: ExtensionContext,
) => Promise<unknown> | unknown;

function createCompactionHandlerHarness(
  model: Model<Api>,
  toolState: {
    allTools?: ReturnType<ExtensionAPI["getAllTools"]>;
    activeTools?: string[];
    branchEntries?: SessionEntry[];
    thinkingLevel?: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  } = {},
): {
  handler: CompactionHandler;
  providerRequestHandler: ProviderRequestHandler;
  ctx: ExtensionContext;
  notices: string[];
} {
  const handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
  const notices: string[] = [];
  const pi = {
    on: (event: string, handler: (event: never, ctx: never) => unknown) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    getThinkingLevel: () => toolState.thinkingLevel ?? "high",
    getAllTools: () => toolState.allTools ?? [],
    getActiveTools: () => toolState.activeTools ?? [],
  } as unknown as ExtensionAPI;
  compactionExtension(pi);

  const ctx = {
    model,
    ui: {
      notify: (message: string) => notices.push(message),
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "gateway-key" }),
      find: () => undefined,
    },
    sessionManager: {
      getSessionId: () => "session-123",
      getBranch: () => toolState.branchEntries ?? [],
      getEntries: () => toolState.branchEntries ?? [],
      getLeafId: () => toolState.branchEntries?.at(-1)?.id ?? null,
    },
    getSystemPrompt: () => "system",
  } as unknown as ExtensionContext;
  const sessionStartHandler = handlers.get("session_start")?.[0];
  sessionStartHandler?.({} as never, ctx as never);
  const handler = handlers.get("session_before_compact")?.[0];
  if (handler === undefined) throw new Error("Compaction handler was not registered");
  const providerRequestHandler = handlers.get("before_provider_request")?.[0];
  if (providerRequestHandler === undefined) {
    throw new Error("Provider request handler was not registered");
  }
  return {
    handler: handler as CompactionHandler,
    providerRequestHandler: providerRequestHandler as ProviderRequestHandler,
    ctx,
    notices,
  };
}

function manualCompactionEvent(): Record<string, unknown> {
  return {
    type: "session_before_compact",
    reason: "manual",
    preparation: {
      messagesToSummarize: [],
      turnPrefixMessages: [],
      firstKeptEntryId: "message-1",
      tokensBefore: 100,
    },
    branchEntries: [],
  };
}

describe("compaction extension", () => {
  test("adds custom instructions as additional constraints", () => {
    const messages = buildSummaryMessages(
      [],
      "Previous facts",
      "# Goal\nPreserve active goal progress.",
    );

    const text = messages[0]?.content[0]?.text ?? "";
    expect(text).toContain("Previous session summary for context:\nPrevious facts");
    expect(text).toContain("# Additional Constraints And Instructions");
    expect(text).toContain("# Goal\nPreserve active goal progress.");
  });

  test("omits additional constraints when custom instructions are blank", () => {
    const messages = buildSummaryMessages([], undefined, "  ");
    const text = messages[0]?.content[0]?.text ?? "";

    expect(text).not.toContain("# Additional Constraints And Instructions");
  });

  test("treats missing auto-compaction signal as not aborted", () => {
    expect(isAbortSignalAborted(undefined)).toBe(false);
  });

  test("retries LiteLLM Responses API in-stream errors", () => {
    expect(
      isRetryableAssistantError({
        role: "assistant",
        api: openAICodexModel.api,
        provider: openAICodexModel.provider,
        model: openAICodexModel.id,
        content: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: "Error: litellm.APIError: Response API in-stream error",
        timestamp: 1,
      }),
    ).toBe(true);
  });

  test("gates remote compaction to configured Codex providers", () => {
    expect(supportsOpenAIRemoteCompaction(codexOpenAIModel)).toBe(true);
    expect(supportsOpenAIRemoteCompaction(openAICodexModel)).toBe(true);
    expect(supportsOpenAIRemoteCompaction({ ...codexOpenAIModel, provider: "openai" })).toBe(false);
    expect(remoteCompactionEndpointUrl(codexOpenAIModel)).toBe(
      "https://gateway.example/v1/responses",
    );
    expect(remoteCompactionEndpointUrl(openAICodexModel)).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    expect(remoteCompactionModelKey(codexOpenAIModel)).not.toBe(
      remoteCompactionModelKey({ ...codexOpenAIModel, baseUrl: "https://other.example/v1" }),
    );
    expect(
      resolveRemoteCompactionRequestBudget({
        ...codexOpenAIModel,
        id: "gpt-5.6-sol",
        contextWindow: 272_000,
      }),
    ).toBe(258_400);
    expect(
      resolveRemoteCompactionRequestBudget({
        ...openAICodexModel,
        id: "gpt-5.6-sol",
        contextWindow: 272_000,
      }),
    ).toBe(372_000);
  });

  test("builds Codex remote compaction headers", () => {
    useTemporaryCodexHome();
    const headers = buildRemoteCompactionHeaders({
      model: openAICodexModel,
      apiKey: codexToken("account-123"),
      headers: { "x-codex-beta-features": "existing_feature" },
      sessionId: "session-123",
    });

    expect(headers["chatgpt-account-id"]).toBe("account-123");
    expect(headers["x-codex-beta-features"]).toBe("existing_feature,remote_compaction_v2");
    expect(headers["x-codex-window-id"]).toBe("session-123:0");
    expect(headers.session_id).toBe("session-123");
  });

  test("converts assistant reasoning and tool calls to Responses items", () => {
    const items = messageToResponseItems({
      role: "assistant",
      api: "openai-responses",
      provider: "codex-openai",
      model: codexOpenAIModel.id,
      content: [
        {
          type: "thinking",
          thinking: "reasoning",
          thinkingSignature: JSON.stringify({
            type: "reasoning",
            summary: [{ type: "summary_text", text: "summary" }],
            encrypted_content: "encrypted",
          }),
        },
        {
          type: "text",
          text: "Calling tool",
          textSignature: JSON.stringify({ v: 1, id: "text-1", phase: "commentary" }),
        },
        { type: "toolCall", id: "call-1|suffix", name: "read", arguments: { path: "a" } },
      ],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 1,
    });

    expect(items).toEqual([
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "summary" }],
        encrypted_content: "encrypted",
      },
      {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "Calling tool" }],
      },
      { type: "function_call", name: "read", call_id: "call-1", arguments: '{"path":"a"}' },
    ]);
  });

  test("converts extension custom messages to Responses user messages", () => {
    expect(
      messageToResponseItems({
        role: "custom",
        customType: "live-delegation",
        content: "Inspect the reconciliation page.",
        display: true,
        timestamp: 1,
      }),
    ).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "Inspect the reconciliation page." }],
      },
    ]);
  });

  test("normalizes replay history and unsupported images", () => {
    const normalized = normalizeResponseItemsForPrompt(
      [
        { type: "ghost_snapshot", data: "omit" },
        { type: "function_call", call_id: "missing-output", name: "read", arguments: "{}" },
        { type: "function_call", call_id: "synthetic-output", name: "bash", arguments: "{}" },
        { type: "function_call_output", call_id: "orphan", output: "omit" },
        { type: "tool_search_output", execution: "server", tools: [] },
        {
          type: "function_call_output",
          call_id: "missing-output",
          output: { content: [{ type: "input_image", image_url: "data:image/png;base64,x" }] },
        },
      ],
      { ...codexOpenAIModel, input: ["text"] },
    );

    expect(normalized.some((item) => item.type === "ghost_snapshot")).toBe(false);
    expect(normalized.some((item) => item.call_id === "orphan")).toBe(false);
    expect(normalized.some((item) => item.type === "tool_search_output")).toBe(true);
    expect(
      normalized.some(
        (item) =>
          item.type === "function_call_output" &&
          item.call_id === "synthetic-output" &&
          item.output === "aborted",
      ),
    ).toBe(true);
    expect(normalized.at(-1)?.output).toEqual({
      content: [
        {
          type: "input_text",
          text: "image content omitted because you do not support image input",
        },
      ],
    });
  });

  test("retains image-only user messages with native compaction artifact", () => {
    const history = buildRemoteCompactionHistory(
      [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,x" }],
        },
      ],
      { type: "compaction", encrypted_content: "opaque" },
    );

    expect(history).toHaveLength(2);
    expect(history[0]?.role).toBe("user");
    expect(history[1]).toEqual({ type: "compaction", encrypted_content: "opaque" });
  });

  test("keeps the newest real user message whole when it exceeds retention budget", () => {
    const text = "x".repeat(300_000);
    const history = buildRemoteCompactionHistory(
      [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      ],
      { type: "compaction", encrypted_content: "opaque" },
    );

    expect(history[0]?.content).toEqual([{ type: "input_text", text }]);
  });

  test("retains real user messages without replaying injected context", () => {
    const userMessage = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Fix the compaction loop." }],
    };
    const history = buildRemoteCompactionHistory(
      [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "# AGENTS.md instructions\ninternal\n</INSTRUCTIONS>" },
          ],
        },
        userMessage,
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<environment_context>internal</environment_context>" },
          ],
        },
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: '<hook_prompt hook_run_id="hook-1">internal</hook_prompt>',
            },
          ],
        },
      ],
      { type: "compaction", encrypted_content: "opaque" },
    );

    expect(history).toEqual([userMessage, { type: "compaction", encrypted_content: "opaque" }]);
  });

  test("calls Responses compaction endpoint with trailing trigger", async () => {
    useTemporaryCodexHome();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          [
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque"}}',
            "",
            'data: {"type":"response.completed","response":{"id":"resp-1","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          { status: 200 },
        ),
      );
    const input = [
      {
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ];

    const result = await callRemoteCompactionEndpoint({
      model: codexOpenAIModel,
      apiKey: "gateway-key",
      sessionId: "session-123",
      tokensBefore: 1,
      input,
      instructions: "system",
      tools: [],
    });

    expect(result.output.at(-1)).toEqual({ type: "compaction", encrypted_content: "opaque" });
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://gateway.example/v1/responses");
    const body = JSON.parse(String(request?.body)) as { input: Array<{ type: string }> };
    expect(body.input.at(-1)).toEqual({ type: "compaction_trigger" });
    expect(body.store).toBe(false);
  });

  test("does not resurrect history before a portable compaction", async () => {
    useTemporaryCodexHome();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          [
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque"}}',
            "",
            'data: {"type":"response.completed","response":{"id":"resp-1"}}',
            "",
          ].join("\n"),
          { status: 200 },
        ),
      );
    const branchEntries = [
      {
        type: "message",
        id: "old-message",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "OLD_HISTORY", timestamp: 1 },
      },
      {
        type: "message",
        id: "kept-message",
        parentId: "old-message",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "KEPT_HISTORY", timestamp: 2 },
      },
      {
        type: "compaction",
        id: "portable-compaction",
        parentId: "kept-message",
        timestamp: "2026-01-01T00:00:02.000Z",
        summary: "PORTABLE_SUMMARY",
        firstKeptEntryId: "kept-message",
        tokensBefore: 200_000,
      },
      {
        type: "message",
        id: "current-message",
        parentId: "portable-compaction",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: { role: "user", content: "CURRENT_HISTORY", timestamp: 3 },
      },
    ] as SessionEntry[];
    const harness = createCompactionHandlerHarness(codexOpenAIModel, { branchEntries });

    await harness.handler(
      {
        ...manualCompactionEvent(),
        preparation: {
          messagesToSummarize: [],
          turnPrefixMessages: [],
          firstKeptEntryId: "current-message",
          tokensBefore: 246_000,
        },
        branchEntries,
      },
      harness.ctx,
    );

    const body = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).not.toContain("OLD_HISTORY");
    expect(body).toContain("PORTABLE_SUMMARY");
    expect(body).toContain("KEPT_HISTORY");
    expect(body).toContain("CURRENT_HISTORY");
  });

  test("truncates oversized trailing tool output before native compaction", async () => {
    useTemporaryCodexHome();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          [
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque"}}',
            "",
            'data: {"type":"response.completed","response":{"id":"resp-1"}}',
            "",
          ].join("\n"),
          { status: 200 },
        ),
      );

    await callRemoteCompactionEndpoint({
      model: { ...codexOpenAIModel, contextWindow: 1_000 },
      apiKey: "gateway-key",
      tokensBefore: 2_000,
      input: [
        { type: "function_call", call_id: "call-1", name: "read", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "call-1",
          output: "large tool output ".repeat(2_000),
        },
      ],
      tools: [],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      input: Array<Record<string, unknown>>;
    };
    expect(body.input[1]).toMatchObject({
      type: "function_call_output",
      call_id: "call-1",
      output: "Output exceeded the available model context and was truncated",
    });
  });

  test("retries transient native compaction failures", async () => {
    useTemporaryCodexHome();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("temporary failure", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          [
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque"}}',
            "",
            'data: {"type":"response.completed","response":{"id":"resp-1"}}',
            "",
          ].join("\n"),
          { status: 200 },
        ),
      );

    await callRemoteCompactionEndpoint({
      model: codexOpenAIModel,
      apiKey: "gateway-key",
      tokensBefore: 1,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      tools: [],
      retryDelayMs: 0,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("rejects compaction artifacts without encrypted content", () => {
    expect(() =>
      parseRemoteCompactionEvents([
        { type: "response.output_item.done", item: { type: "compaction" } },
        { type: "response.completed", response: { id: "resp-1" } },
      ]),
    ).toThrow("expected exactly one compaction item, got 0");
  });

  test("canonicalizes compaction_summary output with checkpoint metadata", () => {
    expect(
      parseRemoteCompactionEvents([
        {
          type: "response.output_item.done",
          item: {
            type: "compaction_summary",
            id: "cmp-1",
            encrypted_content: "opaque",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
          },
        },
        { type: "response.completed", response: { id: "resp-1" } },
      ]).compactionItem,
    ).toEqual({
      type: "compaction",
      id: "cmp-1",
      encrypted_content: "opaque",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
    });
  });

  test("does not run a fallback model after server-side compaction succeeds", async () => {
    useTemporaryCodexHome();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        [
          'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque"}}',
          "",
          'data: {"type":"response.completed","response":{"id":"resp-1","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}',
          "",
        ].join("\n"),
        { status: 200 },
      ),
    );
    const harness = createCompactionHandlerHarness(codexOpenAIModel);

    const result = await harness.handler(manualCompactionEvent(), harness.ctx);

    expect(harness.notices).toEqual([
      expect.stringContaining("Compaction [server]: requesting"),
      expect.stringContaining("without running a fallback model"),
    ]);
    expect(harness.notices.some((notice) => notice.includes("Compaction [fallback]"))).toBe(false);
    expect((result as { compaction?: { summary?: string } }).compaction?.summary).toContain(
      "[OpenAI native compaction checkpoint]",
    );
    expect(result).toMatchObject({
      compaction: {
        details: {
          remoteCompaction: {
            provider: "openai-responses-compaction",
            api: codexOpenAIModel.api,
            model: codexOpenAIModel.id,
            baseUrl: codexOpenAIModel.baseUrl,
            compactResponseId: "resp-1",
            createdAt: expect.any(String),
            requestMeta: {
              tokensBefore: 100,
              previousSummaryPresent: false,
              compactedKeptWindow: true,
            },
          },
        },
      },
    });
  });

  test("cancels compaction when the latest native checkpoint belongs to another endpoint", async () => {
    useTemporaryCodexHome();
    const otherEndpointModel = {
      ...codexOpenAIModel,
      baseUrl: "https://other-gateway.example/v1",
    };
    const branchEntries = [
      {
        type: "compaction",
        id: "compact-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        summary: "native checkpoint placeholder",
        firstKeptEntryId: "message-1",
        tokensBefore: 100,
        details: {
          remoteCompaction: {
            version: 2,
            provider: "openai-responses-compaction",
            modelKey: remoteCompactionModelKey(otherEndpointModel),
            api: otherEndpointModel.api,
            model: otherEndpointModel.id,
            baseUrl: otherEndpointModel.baseUrl,
            replacementHistory: [{ type: "compaction", encrypted_content: "opaque-history" }],
          },
        },
      },
    ] as SessionEntry[];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          [
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"replacement"}}',
            "",
            'data: {"type":"response.completed","response":{"id":"resp-1"}}',
            "",
          ].join("\n"),
          { status: 200 },
        ),
      );
    const harness = createCompactionHandlerHarness(codexOpenAIModel, { branchEntries });

    const result = await harness.handler(
      { ...manualCompactionEvent(), branchEntries },
      harness.ctx,
    );

    expect(result).toEqual({ cancel: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.notices).toContainEqual(
      expect.stringContaining("cancelled to preserve its encrypted history"),
    );
  });

  test("reuses a native checkpoint across models on the same provider endpoint", async () => {
    useTemporaryCodexHome();
    const currentModel = { ...codexOpenAIModel, id: "gpt-5.6-sol" };
    const branchEntries = [
      {
        type: "compaction",
        id: "compact-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        summary: "native checkpoint placeholder",
        firstKeptEntryId: "message-1",
        tokensBefore: 100,
        details: {
          remoteCompaction: {
            version: 2,
            provider: "openai-responses-compaction",
            modelKey: remoteCompactionModelKey(codexOpenAIModel),
            api: codexOpenAIModel.api,
            model: codexOpenAIModel.id,
            baseUrl: codexOpenAIModel.baseUrl,
            replacementHistory: [{ type: "compaction", encrypted_content: "opaque-history" }],
          },
        },
      },
    ] as SessionEntry[];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          [
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"replacement"}}',
            "",
            'data: {"type":"response.completed","response":{"id":"resp-1"}}',
            "",
          ].join("\n"),
          { status: 200 },
        ),
      );
    const harness = createCompactionHandlerHarness(currentModel, { branchEntries });

    const result = await harness.handler(
      { ...manualCompactionEvent(), branchEntries },
      harness.ctx,
    );

    expect(result).not.toEqual({ cancel: true });
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain("opaque-history");
  });

  test("preserves dynamic provider instructions and tools during server-side compaction", async () => {
    useTemporaryCodexHome();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          [
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque"}}',
            "",
            'data: {"type":"response.completed","response":{"id":"resp-1","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}',
            "",
          ].join("\n"),
          { status: 200 },
        ),
      );
    const searchTool = {
      name: "search_tools",
      label: "Search Tools",
      description: "Load optional tools",
      parameters: { type: "object", properties: {} },
    };
    const dynamicTool = {
      name: "dynamic_tool",
      label: "Dynamic Tool",
      description: "Available only after search_tools loads it",
      parameters: { type: "object", properties: {} },
    };
    const staleTool = {
      name: "stale_tool",
      label: "Stale Tool",
      description: "Was disabled after the previous provider request",
      parameters: { type: "object", properties: {} },
    };
    const harness = createCompactionHandlerHarness(codexOpenAIModel, {
      allTools: [dynamicTool, searchTool, staleTool] as ReturnType<ExtensionAPI["getAllTools"]>,
      activeTools: ["search_tools", "dynamic_tool"],
    });
    const providerSearchTool = {
      type: "function",
      name: "search_tools",
      description: "Load optional tools",
      parameters: { type: "object", properties: {} },
    };
    const providerDynamicTool = {
      type: "function",
      name: "dynamic_tool",
      description: "Available only after search_tools loads it",
      parameters: { type: "object", properties: {} },
      defer_loading: true,
    };
    const providerStaleTool = {
      type: "function",
      name: "stale_tool",
      description: "Was disabled after the previous provider request",
      parameters: { type: "object", properties: {} },
    };
    const namedProviderTool = {
      type: "function",
      name: "provider_native_tool",
      description: "Defined by the provider",
      parameters: { type: "object", properties: {} },
    };
    const unnamedProviderTool = { type: "web_search_preview" };

    await harness.providerRequestHandler(
      {
        payload: {
          model: codexOpenAIModel.id,
          input: [
            {
              type: "tool_search_output",
              call_id: "load-dynamic-tool",
              execution: "client",
              status: "completed",
              tools: [providerDynamicTool],
            },
          ],
          instructions: "Base instructions\n\nDynamic extension instructions",
          tools: [
            providerSearchTool,
            providerStaleTool,
            namedProviderTool,
            namedProviderTool,
            unnamedProviderTool,
          ],
        },
      },
      harness.ctx,
    );
    await harness.handler(manualCompactionEvent(), harness.ctx);

    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      instructions?: string;
      tools?: unknown[];
    };
    expect(body.instructions).toBe("Base instructions\n\nDynamic extension instructions");
    expect(body.tools).toEqual([
      providerSearchTool,
      {
        type: "function",
        name: "dynamic_tool",
        description: "Available only after search_tools loads it",
        parameters: { type: "object", properties: {} },
      },
      namedProviderTool,
      unnamedProviderTool,
    ]);
  });

  test("delegates native compaction failures to Pi compaction", async () => {
    useTemporaryCodexHome();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("remote failure", { status: 500, statusText: "Server Error" }),
    );
    const harness = createCompactionHandlerHarness(codexOpenAIModel);

    const result = await harness.handler(manualCompactionEvent(), harness.ctx);

    const serverFailureIndex = harness.notices.findIndex((notice) =>
      notice.includes("Compaction [server] failed"),
    );
    expect(serverFailureIndex).toBeGreaterThanOrEqual(0);
    expect(result).toBeUndefined();
    expect(harness.notices.some((notice) => notice.includes("could not find"))).toBe(false);
  });

  test("cancels an aborted remote compaction before Pi fallback", async () => {
    useTemporaryCodexHome();
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("This operation was aborted", "AbortError"),
    );
    const harness = createCompactionHandlerHarness(codexOpenAIModel);

    const result = await harness.handler(
      { ...manualCompactionEvent(), signal: controller.signal },
      harness.ctx,
    );

    expect(result).toEqual({ cancel: true });
  });

  test("injects the previous native window into Pi fallback compaction", async () => {
    useTemporaryCodexHome();
    const modelKey = remoteCompactionModelKey(codexOpenAIModel);
    const nativeWindow = [{ type: "compaction", encrypted_content: "opaque-history" }];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("context window exceeded", { status: 400, statusText: "Bad Request" }),
      );
    const harness = createCompactionHandlerHarness(codexOpenAIModel, {
      branchEntries: [
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "2025-12-31T23:59:59.000Z",
          message: { role: "user", content: "kept context", timestamp: 1 },
        },
        {
          type: "compaction",
          id: "compact-1",
          parentId: "message-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          summary: "native checkpoint placeholder",
          firstKeptEntryId: "message-1",
          tokensBefore: 100,
          details: {
            remoteCompaction: {
              version: 2,
              provider: "openai-responses-compaction",
              modelKey,
              replacementHistory: nativeWindow,
            },
          },
        },
      ] as SessionEntry[],
    });
    const result = await harness.handler(manualCompactionEvent(), harness.ctx);
    const rewritten = await harness.providerRequestHandler(
      {
        payload: {
          model: codexOpenAIModel.id,
          instructions: "You are a context summarization assistant.",
          input: [
            { role: "developer", content: "Summarize the conversation." },
            { role: "user", content: [{ type: "input_text", text: "<conversation />" }] },
          ],
        },
      },
      harness.ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
    expect(rewritten).toEqual({
      model: codexOpenAIModel.id,
      instructions: "You are a context summarization assistant.",
      input: [
        { role: "developer", content: "Summarize the conversation." },
        nativeWindow[0],
        { role: "user", content: [{ type: "input_text", text: "<conversation />" }] },
      ],
    });
  });

  test("builds exact remote request shape", () => {
    const body = buildRemoteCompactionRequestBody({
      model: codexOpenAIModel,
      input: [{ type: "message", role: "user", content: [] }],
      instructions: "system",
      tools: [{ type: "function", name: "read" }],
      reasoning: { effort: "high", summary: "auto" },
      text: { verbosity: "medium" },
      serviceTier: "priority",
      sessionId: "session-123",
    });

    expect(body).toMatchObject({
      model: codexOpenAIModel.id,
      parallel_tool_calls: true,
      tool_choice: "auto",
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "session-123",
      reasoning: { effort: "high", summary: "auto" },
      text: { verbosity: "medium" },
      service_tier: "priority",
    });
  });

  test("preserves GPT-5.6 max reasoning request shape", () => {
    expect(
      extractResponsesRequestShape({
        model: codexOpenAIModel.id,
        input: [],
        reasoning: { effort: "max", summary: "auto" },
        service_tier: "priority",
      }),
    ).toEqual({
      reasoning: { effort: "max", summary: "auto" },
      serviceTier: "priority",
    });
  });

  test("clamps unsupported GPT-5.6 minimal reasoning to low", async () => {
    useTemporaryCodexHome();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          [
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque"}}',
            "",
            'data: {"type":"response.completed","response":{"id":"resp-1"}}',
            "",
          ].join("\n"),
          { status: 200 },
        ),
      );
    const harness = createCompactionHandlerHarness(
      { ...codexOpenAIModel, id: "gpt-5.6-sol" },
      { thinkingLevel: "minimal" },
    );

    await harness.handler(manualCompactionEvent(), harness.ctx);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      reasoning?: { effort?: string };
    };
    expect(body.reasoning?.effort).toBe("low");
  });

  test("warns that native compaction ignores custom compact guidance", async () => {
    useTemporaryCodexHome();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        [
          'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque"}}',
          "",
          'data: {"type":"response.completed","response":{"id":"resp-1"}}',
          "",
        ].join("\n"),
        { status: 200 },
      ),
    );
    const harness = createCompactionHandlerHarness(codexOpenAIModel);

    await harness.handler(
      { ...manualCompactionEvent(), customInstructions: "Focus only on deployment." },
      harness.ctx,
    );

    expect(harness.notices).toContainEqual(
      expect.stringContaining("ignores custom /compact guidance"),
    );
  });

  test("filters malformed persisted items without losing remote state", () => {
    const details = extractRemoteCompactionDetails({
      remoteCompaction: {
        version: 2,
        provider: "openai-responses-compaction",
        modelKey: `codex-openai:openai-responses:${codexOpenAIModel.id}`,
        replacementHistory: [{ invalid: true }, { type: "compaction", encrypted_content: "x" }],
        usage: { invalid: true },
      },
    });

    expect(details?.replacementHistory).toEqual([{ type: "compaction", encrypted_content: "x" }]);
    expect(details?.usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });

  test("reconstructs compatible post-compaction turns and rewrites payload", () => {
    const modelKey = remoteCompactionModelKey(codexOpenAIModel);
    const branchEntries = [
      {
        type: "compaction",
        id: "compact-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        summary: "summary",
        firstKeptEntryId: "user-1",
        tokensBefore: 100,
        details: {
          remoteCompaction: {
            version: 2,
            provider: "openai-responses-compaction",
            modelKey,
            replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
          },
        },
      },
      {
        type: "message",
        id: "user-2",
        parentId: "compact-1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "continue", timestamp: 2 },
      },
      {
        type: "message",
        id: "assistant-2",
        parentId: "user-2",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          api: "openai-responses",
          provider: "codex-openai",
          model: codexOpenAIModel.id,
          content: [{ type: "text", text: "continued" }],
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 3,
        },
      },
    ] as SessionEntry[];

    const state = reconstructRemoteCompactionState(branchEntries);
    expect(state?.explicitHistory).toHaveLength(3);
    expect(
      applyRemoteHistoryPayload(
        { model: codexOpenAIModel.id, messages: ["old"], previous_response_id: "old" },
        state?.explicitHistory ?? [],
      ),
    ).toEqual({ model: codexOpenAIModel.id, input: state?.explicitHistory });
  });

  test("preserves deferred tool discovery artifacts while replaying native history", () => {
    const nativeHistory = [
      { type: "compaction", encrypted_content: "opaque" },
      {
        role: "user",
        content: [{ type: "input_text", text: "Load the subagent tool" }],
      },
      { type: "function_call", name: "search_tools", call_id: "search-call", arguments: "{}" },
      { type: "function_call_output", call_id: "search-call", output: "Loaded subagent" },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Need delegated review" }],
        encrypted_content: "encrypted-reasoning",
      },
      {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "Starting reviewer" }],
      },
    ];
    const toolSearchCall = {
      type: "tool_search_call",
      call_id: "pi_tool_load_subagent",
      execution: "client",
      status: "completed",
      arguments: { query: "subagent", limit: 1 },
    };
    const toolSearchOutput = {
      type: "tool_search_output",
      call_id: "pi_tool_load_subagent",
      execution: "client",
      status: "completed",
      tools: [
        {
          type: "function",
          name: "subagent",
          description: "Manage child sessions",
          parameters: { type: "object", properties: {} },
          defer_loading: true,
        },
      ],
    };
    const dynamicDeveloperInstructions = {
      role: "developer",
      content: [{ type: "input_text", text: "Dynamic extension instructions" }],
    };

    expect(
      applyRemoteHistoryPayload(
        {
          model: codexOpenAIModel.id,
          input: [
            dynamicDeveloperInstructions,
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "native checkpoint placeholder" }],
            },
            {
              role: "user",
              content: [{ type: "input_text", text: "Load the subagent tool" }],
            },
            { ...nativeHistory[2], id: "fc_search" },
            nativeHistory[3],
            toolSearchCall,
            toolSearchOutput,
            {
              ...nativeHistory[4],
              id: "rs_reasoning",
            },
            {
              ...nativeHistory[5],
              id: "msg_reviewer",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "Starting reviewer",
                  annotations: [],
                },
              ],
            },
          ],
        },
        nativeHistory,
        1,
      ),
    ).toEqual({
      model: codexOpenAIModel.id,
      input: [
        dynamicDeveloperInstructions,
        nativeHistory[0],
        {
          role: "user",
          content: [{ type: "input_text", text: "Load the subagent tool" }],
        },
        { ...nativeHistory[2], id: "fc_search" },
        nativeHistory[3],
        toolSearchCall,
        toolSearchOutput,
        { ...nativeHistory[4], id: "rs_reasoning" },
        {
          ...nativeHistory[5],
          id: "msg_reviewer",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Starting reviewer",
              annotations: [],
            },
          ],
        },
      ],
    });
  });

  test("preserves provider-only tail items during native replay", async () => {
    const replacementHistory = [{ type: "compaction", encrypted_content: "opaque" }];
    const userMessage = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Load the subagent tool" }],
    };
    const assistantMessage = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Loaded" }],
    };
    const toolSearchCall = {
      type: "tool_search_call",
      call_id: "load-subagent",
      execution: "client",
      status: "completed",
      arguments: { query: "subagent", limit: 1 },
    };
    const toolSearchOutput = {
      type: "tool_search_output",
      call_id: "load-subagent",
      execution: "client",
      status: "completed",
      tools: [{ type: "function", name: "subagent" }],
    };
    const modelKey = remoteCompactionModelKey(codexOpenAIModel);
    const harness = createCompactionHandlerHarness(codexOpenAIModel, {
      branchEntries: [
        {
          type: "message",
          id: "pre",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "PRE_COMPACTION", timestamp: 0 },
        },
        {
          type: "compaction",
          id: "compact-1",
          parentId: "pre",
          timestamp: "2026-01-01T00:00:01.000Z",
          summary: "native checkpoint placeholder",
          firstKeptEntryId: "pre",
          tokensBefore: 100,
          details: {
            remoteCompaction: {
              version: 2,
              provider: "openai-responses-compaction",
              modelKey,
              replacementHistory,
            },
          },
        },
        {
          type: "message",
          id: "user-1",
          parentId: "compact-1",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: { role: "user", content: "Load the subagent tool", timestamp: 1 },
        },
        {
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp: "2026-01-01T00:00:03.000Z",
          message: {
            role: "assistant",
            api: "openai-responses",
            provider: "codex-openai",
            model: codexOpenAIModel.id,
            content: [{ type: "text", text: "Loaded" }],
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 2,
          },
        },
      ] as SessionEntry[],
    });

    const summaryInput = messagesToResponseItems(
      convertToLlm(
        buildSessionContext(harness.ctx.sessionManager.getBranch(), "assistant-1").messages,
      ),
    );
    const rewritten = await harness.providerRequestHandler(
      {
        payload: {
          input: [
            ...summaryInput.slice(0, 2),
            userMessage,
            toolSearchCall,
            toolSearchOutput,
            assistantMessage,
          ],
        },
      },
      harness.ctx,
    );
    expect(JSON.stringify(rewritten)).toContain("opaque");
    expect(JSON.stringify(rewritten)).toContain("load-subagent");
  });

  test("preserves current provider payload tail beyond persisted branch entries", async () => {
    const modelKey = remoteCompactionModelKey(codexOpenAIModel);
    const branchEntries = [
      {
        type: "message",
        id: "pre",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "PRE_COMPACTION", timestamp: 1 },
      },
      {
        type: "compaction",
        id: "compact-1",
        parentId: "pre",
        timestamp: "2026-01-01T00:00:01.000Z",
        summary: "native checkpoint placeholder",
        firstKeptEntryId: "pre",
        tokensBefore: 100,
        details: {
          remoteCompaction: {
            version: 2,
            provider: "openai-responses-compaction",
            modelKey,
            api: codexOpenAIModel.api,
            baseUrl: codexOpenAIModel.baseUrl,
            replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
          },
        },
      },
      {
        type: "message",
        id: "tail",
        parentId: "compact-1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "user", content: "PERSISTED_TAIL", timestamp: 2 },
      },
    ] as SessionEntry[];
    const harness = createCompactionHandlerHarness(codexOpenAIModel, { branchEntries });
    const piInput = messagesToResponseItems(
      convertToLlm(buildSessionContext(branchEntries, "tail").messages),
    );
    piInput.push(
      ...messageToResponseItems({ role: "user", content: "CURRENT_TAIL", timestamp: 3 }),
    );

    const rewritten = (await harness.providerRequestHandler(
      { payload: { model: codexOpenAIModel.id, input: piInput, instructions: "system" } },
      harness.ctx,
    )) as { input: unknown[] };
    const serialized = JSON.stringify(rewritten.input);

    expect(serialized).toContain("opaque");
    expect(serialized).toContain("PERSISTED_TAIL");
    expect(serialized).toContain("CURRENT_TAIL");
    expect(serialized).not.toContain("native checkpoint placeholder");
    expect(serialized).not.toContain("PRE_COMPACTION");
  });

  test("preserves the native checkpoint across a newer portable compaction", async () => {
    const modelKey = remoteCompactionModelKey(codexOpenAIModel);
    const branchEntries = [
      {
        type: "message",
        id: "pre",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "PRE_COMPACTION", timestamp: 1 },
      },
      {
        type: "compaction",
        id: "native-compact",
        parentId: "pre",
        timestamp: "2026-01-01T00:00:01.000Z",
        summary: "native checkpoint placeholder",
        firstKeptEntryId: "pre",
        tokensBefore: 100,
        details: {
          remoteCompaction: {
            version: 2,
            provider: "openai-responses-compaction",
            modelKey,
            api: codexOpenAIModel.api,
            baseUrl: codexOpenAIModel.baseUrl,
            replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
          },
        },
      },
      {
        type: "message",
        id: "fallback-tail",
        parentId: "native-compact",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "user", content: "FALLBACK_TAIL", timestamp: 2 },
      },
      {
        type: "compaction",
        id: "portable-compact",
        parentId: "fallback-tail",
        timestamp: "2026-01-01T00:00:03.000Z",
        summary: "PORTABLE_SUMMARY",
        firstKeptEntryId: "fallback-tail",
        tokensBefore: 200,
      },
      {
        type: "message",
        id: "current-tail",
        parentId: "portable-compact",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: { role: "user", content: "CURRENT_TAIL", timestamp: 4 },
      },
    ] as SessionEntry[];
    const harness = createCompactionHandlerHarness(codexOpenAIModel, { branchEntries });
    const piInput = messagesToResponseItems(
      convertToLlm(buildSessionContext(branchEntries, "current-tail").messages),
    );

    const rewritten = (await harness.providerRequestHandler(
      { payload: { model: codexOpenAIModel.id, input: piInput, instructions: "system" } },
      harness.ctx,
    )) as { input: unknown[] };
    const serialized = JSON.stringify(rewritten.input);

    expect(serialized).toContain("opaque");
    expect(serialized).toContain("PORTABLE_SUMMARY");
    expect(serialized).toContain("CURRENT_TAIL");
    expect(serialized).not.toContain("native checkpoint placeholder");
  });

  test("starts a new native checkpoint from the latest portable context", async () => {
    useTemporaryCodexHome();
    const modelKey = remoteCompactionModelKey(codexOpenAIModel);
    const branchEntries = [
      {
        type: "message",
        id: "pre",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "PRE_COMPACTION", timestamp: 1 },
      },
      {
        type: "compaction",
        id: "native-compact",
        parentId: "pre",
        timestamp: "2026-01-01T00:00:01.000Z",
        summary: "native checkpoint placeholder",
        firstKeptEntryId: "pre",
        tokensBefore: 100,
        details: {
          remoteCompaction: {
            version: 2,
            provider: "openai-responses-compaction",
            modelKey,
            api: codexOpenAIModel.api,
            baseUrl: codexOpenAIModel.baseUrl,
            replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
          },
        },
      },
      {
        type: "message",
        id: "fallback-tail",
        parentId: "native-compact",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "user", content: "FALLBACK_TAIL", timestamp: 2 },
      },
      {
        type: "compaction",
        id: "portable-compact",
        parentId: "fallback-tail",
        timestamp: "2026-01-01T00:00:03.000Z",
        summary: "PORTABLE_SUMMARY",
        firstKeptEntryId: "fallback-tail",
        tokensBefore: 200,
      },
      {
        type: "message",
        id: "current-tail",
        parentId: "portable-compact",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: { role: "user", content: "CURRENT_TAIL", timestamp: 4 },
      },
    ] as SessionEntry[];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          [
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"replacement"}}',
            "",
            'data: {"type":"response.completed","response":{"id":"resp-1"}}',
            "",
          ].join("\n"),
          { status: 200 },
        ),
      );
    const harness = createCompactionHandlerHarness(codexOpenAIModel, { branchEntries });

    await harness.handler({ ...manualCompactionEvent(), branchEntries }, harness.ctx);

    const body = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).toContain("PORTABLE_SUMMARY");
    expect(body).toContain("CURRENT_TAIL");
    expect(body).not.toContain('"encrypted_content":"opaque"');
  });

  test("reconstructs custom extension turns after remote compaction", () => {
    const modelKey = remoteCompactionModelKey(codexOpenAIModel);
    const branchEntries = [
      {
        type: "compaction",
        id: "compact-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        summary: "summary",
        firstKeptEntryId: "custom-1",
        tokensBefore: 100,
        details: {
          remoteCompaction: {
            version: 2,
            provider: "openai-responses-compaction",
            modelKey,
            replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
          },
        },
      },
      {
        type: "custom_message",
        id: "custom-1",
        parentId: "compact-1",
        timestamp: "2026-01-01T00:00:01.000Z",
        customType: "subagent-status",
        content: "Subagent completed the delegated task.",
        display: true,
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "custom-1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          api: "openai-responses",
          provider: "codex-openai",
          model: codexOpenAIModel.id,
          content: [{ type: "text", text: "Acknowledged" }],
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 3,
        },
      },
    ] as SessionEntry[];

    expect(reconstructRemoteCompactionState(branchEntries)?.explicitHistory).toEqual([
      { type: "compaction", encrypted_content: "opaque" },
      {
        role: "user",
        content: [{ type: "input_text", text: "Subagent completed the delegated task." }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Acknowledged" }],
      },
    ]);
  });

  test("preserves post-compaction turns completed by another model", () => {
    const modelKey = remoteCompactionModelKey(codexOpenAIModel);
    const branchEntries = [
      {
        type: "compaction",
        id: "compact-1",
        details: {
          remoteCompaction: {
            version: 2,
            provider: "openai-responses-compaction",
            modelKey,
            replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
          },
        },
      },
      {
        type: "message",
        id: "user-other",
        message: { role: "user", content: "DROP_USER", timestamp: 2 },
      },
      {
        type: "message",
        id: "assistant-other",
        message: {
          role: "assistant",
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude",
          content: [{ type: "text", text: "DROP_ASSISTANT" }],
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 3,
        },
      },
    ] as SessionEntry[];

    expect(reconstructRemoteCompactionState(branchEntries)?.explicitHistory).toEqual([
      { type: "compaction", encrypted_content: "opaque" },
      {
        role: "user",
        content: [{ type: "input_text", text: "DROP_USER" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "DROP_ASSISTANT" }],
      },
    ]);
  });
});
