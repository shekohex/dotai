import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import compactionExtension, {
  buildSummaryMessages,
  isAbortSignalAborted,
} from "../src/extensions/compaction.js";
import {
  buildRemoteCompactionHistory,
  messageToResponseItems,
  normalizeResponseItemsForPrompt,
} from "../src/extensions/compaction/openai-remote-messages.js";
import {
  buildRemoteCompactionHeaders,
  buildRemoteCompactionRequestBody,
  callRemoteCompactionEndpoint,
  remoteCompactionEndpointUrl,
  supportsOpenAIRemoteCompaction,
} from "../src/extensions/compaction/openai-remote-protocol.js";
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

function createCompactionHandlerHarness(model: Model<Api>): {
  handler: CompactionHandler;
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
    getThinkingLevel: () => "high",
    getAllTools: () => [],
    getActiveTools: () => [],
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
      getBranch: () => [],
    },
    getSystemPrompt: () => "system",
  } as unknown as ExtensionContext;
  const handler = handlers.get("session_before_compact")?.[0];
  if (handler === undefined) throw new Error("Compaction handler was not registered");
  return { handler: handler as CompactionHandler, ctx, notices };
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

  test("calls Responses compaction endpoint with trailing trigger", async () => {
    useTemporaryCodexHome();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          [
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque"}}',
            "",
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          { status: 200 },
        ),
      );
    const input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ];

    const result = await callRemoteCompactionEndpoint({
      model: codexOpenAIModel,
      apiKey: "gateway-key",
      sessionId: "session-123",
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

  test("does not run a fallback model after server-side compaction succeeds", async () => {
    useTemporaryCodexHome();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        [
          'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque"}}',
          "",
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}',
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
    expect(result).toMatchObject({
      compaction: {
        details: {
          remoteCompaction: {
            provider: "openai-responses-compaction",
          },
        },
      },
    });
  });

  test("starts fallback models only after server-side compaction fails", async () => {
    useTemporaryCodexHome();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("remote failure", { status: 500, statusText: "Server Error" }),
    );
    const harness = createCompactionHandlerHarness(codexOpenAIModel);

    await harness.handler(manualCompactionEvent(), harness.ctx);

    const serverFailureIndex = harness.notices.findIndex((notice) =>
      notice.includes("Compaction [server] failed"),
    );
    const fallbackIndex = harness.notices.findIndex((notice) =>
      notice.includes("Compaction: could not find"),
    );
    expect(serverFailureIndex).toBeGreaterThanOrEqual(0);
    expect(fallbackIndex).toBeGreaterThan(serverFailureIndex);
  });

  test("builds exact remote request shape", () => {
    const body = buildRemoteCompactionRequestBody({
      model: codexOpenAIModel,
      input: [{ type: "message", role: "user", content: [] }],
      instructions: "system",
      tools: [{ type: "function", name: "read" }],
      reasoning: { effort: "high", summary: "auto" },
      text: { verbosity: "medium" },
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
    });
  });

  test("preserves GPT-5.6 max reasoning request shape", () => {
    expect(
      extractResponsesRequestShape({
        model: codexOpenAIModel.id,
        input: [],
        reasoning: { effort: "max", summary: "auto" },
      }),
    ).toEqual({ reasoning: { effort: "max", summary: "auto" } });
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
    const modelKey = `codex-openai:openai-responses:${codexOpenAIModel.id}`;
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

  test("drops post-compaction turns completed by another model", () => {
    const modelKey = `codex-openai:openai-responses:${codexOpenAIModel.id}`;
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

    expect(JSON.stringify(reconstructRemoteCompactionState(branchEntries))).not.toContain("DROP_");
  });
});
