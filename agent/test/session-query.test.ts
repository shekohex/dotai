import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { groupedExtensionsB } from "../src/extensions/definitions-group-b.js";
import { executeSessionQueryRequest } from "../src/extensions/session-query/execution.js";
import sessionQueryExtension from "../src/extensions/session-query/index.js";
import { isSessionQueryToolEnabled } from "../src/extensions/session-query/state.js";
import { syncModeTools } from "../src/extensions/modes/tools.js";
import { streamModel } from "../src/extensions/pi-ai-models.js";

vi.mock("../src/extensions/pi-ai-models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/extensions/pi-ai-models.js")>();
  return { ...actual, streamModel: vi.fn() };
});

type Handler = (event: object, ctx: ExtensionContext) => unknown;

function createHarness(
  options: {
    entries?: ExtensionCommandContext["sessionManager"]["getBranch"] extends () => infer T
      ? T
      : never;
  } = {},
) {
  let activeTools = ["read"];
  const entries = Array.isArray(options.entries) ? [...options.entries] : [];
  const handlers = new Map<string, Handler[]>();
  const registeredCommands: string[] = [];
  const notifications: string[] = [];

  const ctx = {
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
    },
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  } as ExtensionCommandContext;

  const pi = {
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data } as never);
    },
    getActiveTools: () => activeTools,
    getAllTools: () => [{ name: "read" }, { name: "session_query" }],
    on(eventName: string, handler: Handler) {
      handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
    },
    registerCommand(name: string) {
      registeredCommands.push(name);
    },
    registerTool: vi.fn(),
    setActiveTools(toolNames: string[]) {
      activeTools = toolNames;
    },
  } as unknown as ExtensionAPI;

  sessionQueryExtension(pi);

  return {
    ctx,
    entries,
    notifications,
    registeredCommands,
    get activeTools() {
      return activeTools;
    },
    async emit(eventName: string) {
      for (const handler of handlers.get(eventName) ?? []) await handler({}, ctx);
    },
    syncModeTools() {
      syncModeTools(pi, ctx, undefined);
    },
  };
}

describe("session-query extension", () => {
  test("bundled definitions include session-query extension", () => {
    expect(groupedExtensionsB.some((definition) => definition.id === "session-query")).toBe(true);
  });

  test("tool is disabled by default and mode sync does not re-add it", async () => {
    const harness = createHarness();

    await harness.emit("session_start");
    harness.syncModeTools();

    expect(isSessionQueryToolEnabled()).toBe(false);
    expect(harness.activeTools).toEqual(["read"]);
  });

  test("before-agent hook does not remove a search-loaded tool", async () => {
    const harness = createHarness();
    await harness.emit("session_start");
    harness.activeTools.push("session_query");

    await harness.emit("before_agent_start");

    expect(harness.activeTools).toEqual(["read", "session_query"]);
  });

  test("does not register a tool toggle command", () => {
    const harness = createHarness();

    expect(harness.registeredCommands).not.toContain("session-query");
  });

  test("legacy enabled session state still opts the tool in", async () => {
    const harness = createHarness({
      entries: [
        {
          type: "custom",
          customType: "tool-state",
          data: { version: 1, key: "session_query", enabled: true },
        },
      ] as never,
    });

    await harness.emit("session_start");

    expect(harness.activeTools).toEqual(["read", "session_query"]);
  });

  test("config default enables tool when session has no override", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "agent-session-query-settings-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      join(agentDir, "settings.json"),
      `${JSON.stringify({ sessionQuery: { enabled: true } })}\n`,
      "utf-8",
    );
    try {
      const harness = createHarness();

      await harness.emit("session_start");

      expect(harness.activeTools).toEqual(["read", "session_query"]);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  test("execution retries model fallback after stream failure", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-session-query-fallback-"));
    const sessionManager = SessionManager.create(cwd, cwd);
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "We changed src/main.ts" }],
      timestamp: Date.now(),
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Noted." }],
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const sessionPath = sessionManager.getSessionFile();
    if (sessionPath === undefined) throw new Error("expected session file");
    const models = new Map([
      [
        "gemini/gemini-3.1-flash-lite-preview",
        {
          provider: "gemini",
          id: "gemini-3.1-flash-lite-preview",
          api: "gemini",
          baseUrl: "https://litellm.example.test/v1beta",
        },
      ],
      [
        "gemini/gemini-3.1-pro-preview",
        {
          provider: "gemini",
          id: "gemini-3.1-pro-preview",
          api: "gemini",
          baseUrl: "https://litellm.example.test/v1beta",
        },
      ],
    ]);
    vi.mocked(streamModel).mockImplementation((model) => {
      const answer = model.id === "gemini-3.1-pro-preview" ? "Changed src/main.ts." : "";
      return {
        async *[Symbol.asyncIterator]() {},
        result: async () => ({
          role: "assistant",
          content:
            answer.length > 0
              ? [{ type: "text" as const, text: answer }]
              : [{ type: "text" as const, text: "provider error" }],
          stopReason: answer.length > 0 ? "stop" : "error",
          errorMessage: answer.length > 0 ? undefined : "provider error",
          timestamp: Date.now(),
        }),
      } as ReturnType<typeof streamModel>;
    });

    const result = await executeSessionQueryRequest(
      { sessionPath, question: "What changed?", sessionUuid: "session" },
      undefined,
      undefined,
      {
        modelRegistry: {
          find: (provider: string, modelId: string) => models.get(`${provider}/${modelId}`),
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
        },
        ui: { notify: vi.fn() },
      } as never,
    );

    expect(vi.mocked(streamModel).mock.calls.map(([model]) => model.id)).toEqual([
      "gemini-3.1-flash-lite-preview",
      "gemini-3.1-pro-preview",
    ]);
    expect(vi.mocked(streamModel).mock.calls.map(([model]) => model.api)).toEqual([
      "openai-responses",
      "openai-responses",
    ]);
    expect(vi.mocked(streamModel).mock.calls.map(([model]) => model.baseUrl)).toEqual([
      "https://litellm.example.test/v1",
      "https://litellm.example.test/v1",
    ]);
    expect(result.content[0]?.text).toBe("Changed src/main.ts.");
  });
});
