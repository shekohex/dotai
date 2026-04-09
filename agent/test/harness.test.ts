import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calls, createTestSession, says, when, type TestSession } from "@marcfargas/pi-test-harness";
import { initTheme } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import { createPlaybookStreamFn } from "../node_modules/@marcfargas/pi-test-harness/src/playbook.ts";
import webFetchExtension from "../src/extensions/fetch.ts";
import webSearchExtension, { webSearchTool } from "../src/extensions/websearch.ts";
import patchExtension from "../src/extensions/patch.ts";
import handoffExtension from "../src/extensions/handoff.ts";
import { createLiteLLMProviderRegistrations } from "../src/extensions/litellm.ts";
import modelFamilySystemPromptExtension, {
  buildModelFamilySystemPrompt,
  extractPiDynamicTail,
} from "../src/extensions/model-family-system-prompt.ts";
import modesExtension from "../src/extensions/modes.ts";
import { installBundledResourcePaths } from "../src/extensions/bundled-resources.ts";
import {
  setRegisteredThemes,
  theme as activeTheme,
} from "../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";

process.env.OPENAI_API_KEY ??= "test-key";

function forceApplyPatchExtension(pi: ExtensionAPI) {
  const enablePatchTool = () => {
    const nextTools = new Set(pi.getActiveTools().filter((toolName) => toolName !== "edit" && toolName !== "write"));
    nextTools.add("apply_patch");
    pi.setActiveTools(Array.from(nextTools));
  };

  pi.on("session_start", async () => {
    enablePatchTool();
  });

  pi.on("before_agent_start", async () => {
    enablePatchTool();
    return undefined;
  });
}

function patchHarnessAgent(testSession: TestSession): void {
  const agent = testSession.session.agent as { state: { tools: unknown[] }; setTools?: (tools: unknown[]) => void };
  agent.setTools ??= (tools: unknown[]) => {
    agent.state.tools = tools;
  };
}

function createHandoffTestProviders(summaryText: string): {
  extensionFactory: (pi: ExtensionAPI) => void;
  dispose: () => void;
} {
  const registrations = [
    registerFauxProvider({
      provider: "codex-openai",
      models: [{ id: "gpt-5.4-mini", reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 }],
    }),
    registerFauxProvider({
      provider: "mode-provider",
      models: [
        { id: "mode-model", reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 },
        { id: "smart-model", reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 },
      ],
    }),
    registerFauxProvider({
      provider: "override-provider",
      models: [{ id: "override-model", reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 }],
    }),
  ];

  registrations[0].setResponses([fauxAssistantMessage(summaryText)]);

  return {
    extensionFactory(pi: ExtensionAPI) {
      for (const registration of registrations) {
        const model = registration.getModel();
        pi.registerProvider(model.provider, {
          baseUrl: model.baseUrl,
          apiKey: "TEST_KEY",
          api: registration.api,
          models: registration.models.map((registeredModel) => ({
            id: registeredModel.id,
            name: registeredModel.name,
            reasoning: registeredModel.reasoning,
            input: registeredModel.input,
            cost: registeredModel.cost,
            contextWindow: registeredModel.contextWindow,
            maxTokens: registeredModel.maxTokens,
          })),
        });
      }
    },
    dispose() {
      for (const registration of registrations) {
        registration.unregister();
      }
    },
  };
}

function createModelFamilyTestProviders(): {
  extensionFactory: (pi: ExtensionAPI) => void;
  getModel: (id: string) => { provider: string; id: string } & Record<string, unknown>;
  setResponses: (response: Parameters<ReturnType<typeof registerFauxProvider>["setResponses"]>[0][number]) => void;
  dispose: () => void;
} {
  const registrations = [
    registerFauxProvider({
      provider: "family-gpt",
      models: [{ id: "gpt-5.4", reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 }],
    }),
    registerFauxProvider({
      provider: "family-gpt-mini",
      models: [{ id: "gpt-5.4-mini", reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 }],
    }),
    registerFauxProvider({
      provider: "family-codex",
      models: [{ id: "gpt-5.4-codex", reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 }],
    }),
    registerFauxProvider({
      provider: "family-gemini",
      models: [{ id: "gemini-2.5-pro", reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 }],
    }),
    registerFauxProvider({
      provider: "family-kimi",
      models: [{ id: "kimi-k2.5", reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 }],
    }),
    registerFauxProvider({
      provider: "family-default",
      models: [{ id: "router-1", reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 }],
    }),
  ];

  const modelById = new Map(registrations.map((registration) => {
    const model = registration.getModel();
    return [model.id, model] as const;
  }));

  return {
    extensionFactory(pi: ExtensionAPI) {
      for (const registration of registrations) {
        const model = registration.getModel();
        pi.registerProvider(model.provider, {
          baseUrl: model.baseUrl,
          apiKey: "TEST_KEY",
          api: registration.api,
          models: registration.models.map((registeredModel) => ({
            id: registeredModel.id,
            name: registeredModel.name,
            reasoning: registeredModel.reasoning,
            input: registeredModel.input,
            cost: registeredModel.cost,
            contextWindow: registeredModel.contextWindow,
            maxTokens: registeredModel.maxTokens,
          })),
        });
      }
    },
    getModel(id: string) {
      const model = modelById.get(id);
      assert.ok(model, `Missing model ${id}`);
      return model as { provider: string; id: string } & Record<string, unknown>;
    },
    setResponses(response) {
      for (const registration of registrations) {
        registration.setResponses([response]);
      }
    },
    dispose() {
      for (const registration of registrations) {
        registration.unregister();
      }
    },
  };
}

async function writeModelFamilyModesFile(cwd: string): Promise<void> {
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "modes.json"),
    `${JSON.stringify({
      version: 1,
      currentMode: "build",
      modes: {
        build: {
          provider: "family-gpt",
          modelId: "gpt-5.4",
        },
        quick: {
          provider: "family-gpt-mini",
          modelId: "gpt-5.4-mini",
        },
        research: {
          provider: "family-gemini",
          modelId: "gemini-2.5-pro",
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

async function writeHandoffModesFile(cwd: string): Promise<void> {
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "modes.json"),
    `${JSON.stringify({
      version: 1,
      currentMode: "smart",
      modes: {
        smart: {
          provider: "mode-provider",
          modelId: "smart-model",
          thinkingLevel: "low",
        },
        rush: {
          provider: "mode-provider",
          modelId: "mode-model",
          thinkingLevel: "high",
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

function getLatestModeState(testSession: TestSession): string | undefined {
  const entries = ((testSession.session as {
    sessionManager: {
      getEntries: () => Array<{ type: string; customType?: string; data?: { activeMode?: string } }>;
    };
  }).sessionManager.getEntries());

  return entries
    .filter((entry) => entry.type === "custom" && entry.customType === "mode-state")
    .at(-1)
    ?.data?.activeMode;
}

function setFakeParentSessionPath(testSession: TestSession, sessionPath: string): void {
  const sessionManager = (testSession.session as { sessionManager: { getSessionFile: () => string | undefined } }).sessionManager as {
    getSessionFile: () => string | undefined;
  };
  sessionManager.getSessionFile = () => sessionPath;
}

function setMockCustomLoaderResult(
  testSession: TestSession,
  result: { summary?: string; warning?: string; error?: string; aborted?: boolean },
): void {
  const uiContext = ((testSession.session as { extensionRunner: { uiContext: { custom: <T>() => Promise<T> } } }).extensionRunner as {
    uiContext: { custom: <T>() => Promise<T> };
  }).uiContext;
  uiContext.custom = async <T>() => result as T;
}

function getBranchTextMessages(testSession: TestSession): Array<{ role: string; text: string }> {
  return ((testSession.session as { sessionManager: { getBranch: () => Array<{ type: string; message?: { role: string; content: string | Array<{ type: string; text?: string }> } }> } }).sessionManager.getBranch())
    .filter((entry) => entry.type === "message" && entry.message)
    .map((entry) => {
      return {
        role: entry.message!.role,
        text: getMessageText(entry.message!.content),
      };
    });
}

function getMessageText(content: string | Array<{ type: string; text?: string }>): string {
  return typeof content === "string"
    ? content
    : content
      .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
}

async function getCommandArgumentCompletions(
  testSession: TestSession,
  commandName: string,
  prefix: string,
): Promise<Array<{ value: string; label: string; description?: string }> | null> {
  const extensionRunner = (testSession.session as {
    extensionRunner: {
      getRegisteredCommands: () => Array<{
        name: string;
        invocationName: string;
        getArgumentCompletions?: (argumentPrefix: string) => Promise<Array<{ value: string; label: string; description?: string }> | null> | Array<{ value: string; label: string; description?: string }> | null;
      }>;
    };
  }).extensionRunner;

  const command = extensionRunner.getRegisteredCommands().find((registeredCommand) => registeredCommand.invocationName === commandName);
  assert.ok(command?.getArgumentCompletions);
  return await command.getArgumentCompletions(prefix);
}

function getCurrentSystemPrompt(testSession: TestSession): string {
  return ((testSession.session as { agent: { state: { systemPrompt: string } } }).agent.state.systemPrompt);
}

test("pi-test-harness runs apply_patch against the real tool implementation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-harness-"));
  const filePath = join(cwd, "sample.ts");
  let session: TestSession | undefined;

  await writeFile(filePath, "export const value = 1;\n", "utf8");

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [patchExtension, forceApplyPatchExtension],
    });
    patchHarnessAgent(session);

    await session.run(
      when("Patch sample.ts", [
        calls("apply_patch", {
          patchText: [
            "*** Begin Patch",
            "*** Update File: sample.ts",
            "@@",
            "-export const value = 1;",
            "+export const value = 2;",
            "*** End Patch",
          ].join("\n"),
        }),
        says("Patched."),
      ]),
    );

    assert.equal(await readFile(filePath, "utf8"), "export const value = 2;\n");
    assert.equal(session.events.toolCallsFor("apply_patch").length, 1);
    const toolExecutionEnd = session.events.all.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "apply_patch",
    );
    assert.ok(toolExecutionEnd);
    assert.equal(toolExecutionEnd.isError, false);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("pi-test-harness captures mocked built-in tool events", async () => {
  let session: TestSession | undefined;

  try {
    session = await createTestSession({
      mockTools: {
        bash: ({ command }) => `ran: ${command}`,
      },
    });
    patchHarnessAgent(session);

    await session.run(
      when("Run the preview tests", [
        calls("bash", { command: "npm run test:tool-preview" }),
        says("Done."),
      ]),
    );

    assert.deepEqual(session.events.toolSequence(), ["bash"]);
    assert.equal(session.events.toolResultsFor("bash")[0]?.mocked, true);
    assert.match(session.events.toolResultsFor("bash")[0]?.text ?? "", /ran: npm run test:tool-preview/);
  } finally {
    session?.dispose();
  }
});

test("pi-test-harness runs webfetch against the real tool implementation", async () => {
  let session: TestSession | undefined;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v2/scrape") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "not found" }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }

    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      url?: string;
      formats?: string[];
    };

    assert.equal(req.headers.authorization, "Bearer fc-free");
    assert.equal(body.url, "https://example.com/harness");
    assert.deepEqual(body.formats, ["markdown"]);

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      data: {
        markdown: "# Fetch harness",
        html: "<html><body><h1>Fetch harness</h1></body></html>",
        metadata: {
          url: "https://example.com/harness",
          sourceURL: "https://example.com/harness",
          statusCode: 200,
          contentType: "text/html; charset=utf-8",
        },
      },
    }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const originalApiUrl = process.env.WEBFETCH_FIRECRAWL_API_URL;
  const originalFirecrawlApiKey = process.env.FIRECRAWL_API_KEY;
  process.env.WEBFETCH_FIRECRAWL_API_URL = `http://127.0.0.1:${address.port}`;
  delete process.env.FIRECRAWL_API_KEY;

  try {
    session = await createTestSession({
      extensionFactories: [webFetchExtension],
    });
    patchHarnessAgent(session);

    await session.run(
      when("Fetch a known URL", [
        calls("webfetch", { url: "https://example.com/harness", timeout: 10, format: "markdown" }),
        says("Fetched."),
      ]),
    );

    const toolExecutionEnd = session.events.all.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "webfetch",
    );
    assert.ok(toolExecutionEnd);
    assert.equal(toolExecutionEnd.isError, false);

    const toolResult = session.events.toolResultsFor("webfetch")[0]?.text ?? "";
    assert.match(toolResult, /URL: https:\/\/example\.com\/harness/);
    assert.match(toolResult, /Status: 200 OK/);
    assert.match(toolResult, /# Fetch harness/);
  } finally {
    if (originalApiUrl === undefined) {
      delete process.env.WEBFETCH_FIRECRAWL_API_URL;
    } else {
      process.env.WEBFETCH_FIRECRAWL_API_URL = originalApiUrl;
    }
    if (originalFirecrawlApiKey === undefined) {
      delete process.env.FIRECRAWL_API_KEY;
    } else {
      process.env.FIRECRAWL_API_KEY = originalFirecrawlApiKey;
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    session?.dispose();
  }
});

test("websearch emits streaming updates before the final result", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const updates: Array<{ content?: Array<{ type: string; text?: string }>; details?: { answer?: string } }> = [];

  globalThis.fetch = async (input, init) => {
    const requestHeaders = input instanceof Request ? input.headers : undefined;
    const initHeaders = init?.headers instanceof Headers
      ? init.headers
      : new Headers((init?.headers as Record<string, string> | undefined) ?? {});
    const getHeader = (name: string) => requestHeaders?.get(name) ?? initHeaders.get(name) ?? "";
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    if (url.endsWith("/health/readiness")) {
      return new Response("ok", { status: 200 });
    }

    if (url.includes(":streamGenerateContent")) {
      assert.ok(getHeader("x-goog-api-key").length > 0);
      const stream = new ReadableStream({
        start(controller) {
          const events = [
            {
              candidates: [{
                content: {
                  parts: [{ text: JSON.stringify({ answer: "Next.js 16 released in October 2025." }) }],
                },
              }],
            },
            {
              candidates: [{
                content: {
                  parts: [{ text: JSON.stringify({
                    answer: [
                      "Next.js 16 released in October 2025.",
                      "Turbopack stabilization and caching changes were part of the release.",
                      "Teams should re-run production build verification after upgrading.",
                    ].join("\n"),
                    sources: [
                      { title: "Next.js 16", url: "https://nextjs.org/blog/next-16" },
                      { title: "Version 16 Upgrade Guide", url: "https://nextjs.org/docs/app/guides/upgrading/version-16" },
                    ],
                    searchQueries: ["next.js 16 release date official", "next.js 16 upgrade guide"],
                  }) }],
                },
              }],
            },
          ];

          for (const event of events) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }

    if (url.includes(":generateContent")) {
      throw new Error("generateContent fallback should not be used in streaming test");
    }

    return originalFetch(input as Parameters<typeof fetch>[0], init);
  };

  try {
    const result = await webSearchTool.execute!(
      "test-websearch-stream",
      {
        query: "When did Next.js 16 release and what changed?",
        model: "gemini-2.5-flash",
        timeoutMs: 30000,
      },
      undefined,
      (update) => {
        updates.push(update as { content?: Array<{ type: string; text?: string }>; details?: { answer?: string } });
      },
      {
        modelRegistry: {
          find(provider: string, modelId: string) {
            assert.equal(provider, "gemini");
            return {
              id: modelId,
              name: modelId,
              provider: "gemini",
              api: "google-generative-ai",
              baseUrl: "https://litellm.example.test/v1beta",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1_000_000,
              maxTokens: 65_536,
            };
          },
          async getApiKeyAndHeaders() {
            return { ok: true as const, apiKey: "litellm-test-key", headers: undefined };
          },
        },
      } as never,
    );

    assert.ok(updates.length > 1);

    const toolResult = result.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    assert.match(toolResult, /Next\.js 16 released in October 2025\./);
    assert.match(toolResult, /Sources:/);
    assert.match(toolResult, /https:\/\/nextjs\.org\/blog\/next-16/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("websearch uses the LiteLLM api key with the gemini model provider", async () => {
  const originalFetch = globalThis.fetch;
  const originalLiteLLMApiKey = process.env.LITELLM_API_KEY;
  let session: TestSession | undefined;

  process.env.LITELLM_API_KEY = "litellm-test-key";

  globalThis.fetch = async (input, init) => {
    const requestHeaders = input instanceof Request ? input.headers : undefined;
    const initHeaders = init?.headers instanceof Headers
      ? init.headers
      : new Headers((init?.headers as Record<string, string> | undefined) ?? {});
    const getHeader = (name: string) => requestHeaders?.get(name) ?? initHeaders.get(name) ?? "";
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    if (url.endsWith("/health/readiness")) {
      return new Response("ok", { status: 200 });
    }

    if (url.includes(":streamGenerateContent")) {
      assert.equal(getHeader("x-goog-api-key"), "litellm-test-key");
      return new Response(JSON.stringify([{
        candidates: [{
          content: {
            parts: [{ text: JSON.stringify({
              answer: "Next.js 16 released in October 2025.",
              sources: [{ title: "Next.js 16", url: "https://nextjs.org/blog/next-16" }],
              searchQueries: ["next.js 16 release date official"],
            }) }],
          },
        }],
      }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.includes(":generateContent")) {
      throw new Error("generateContent fallback should not be used in api-key test");
    }

    return originalFetch(input as Parameters<typeof fetch>[0], init);
  };

  try {
    session = await createTestSession({
      extensionFactories: [webSearchExtension],
    });
    patchHarnessAgent(session);

    await session.run(
      when("Run a web search", [
        calls("websearch", {
          query: "When did Next.js 16 release?",
          model: "gemini-2.5-flash",
        }),
        says("Done."),
      ]),
    );
  } finally {
    session?.dispose();
    globalThis.fetch = originalFetch;
    if (originalLiteLLMApiKey === undefined) {
      delete process.env.LITELLM_API_KEY;
    } else {
      process.env.LITELLM_API_KEY = originalLiteLLMApiKey;
    }
  }
});

test("bundled themes are available before reload", async () => {
  installBundledResourcePaths();

  let session: TestSession | undefined;

  try {
    session = await createTestSession();

    const bundledThemes = session.session.resourceLoader.getThemes().themes;
    assert.ok(bundledThemes.some((loadedTheme) => loadedTheme.name === "catppuccin-mocha"));

    setRegisteredThemes(bundledThemes);
    initTheme("catppuccin-mocha");

    assert.equal(activeTheme.name, "catppuccin-mocha");
  } finally {
    session?.dispose();
  }
});

test("handoff command starts the new session in the requested mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-handoff-command-"));
  let session: TestSession | undefined;
  const providers = createHandoffTestProviders("## Context\nPrior decisions captured.\n\n## Task\nFinish the implementation.");

  await writeHandoffModesFile(cwd);

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [modesExtension, handoffExtension, providers.extensionFactory],
      mockUI: {
        editor: (_title, prefill) => `${prefill ?? ""}\n\nReviewed by user`,
      },
    });
    patchHarnessAgent(session);

    setFakeParentSessionPath(session, "/tmp/parent-session.jsonl");
    setMockCustomLoaderResult(session, {
      summary: "## Context\nPrior decisions captured.\n\n## Task\nFinish the implementation.",
    });

    await session.run(
      when("We traced the regression to the handoff extension", [
        says("Captured."),
      ]),
    );

    const consumedBeforeCommand = session.playbook.consumed;

    await session.session.prompt("/handoff -mode rush finish the implementation");
    await session.session.agent.waitForIdle();

    assert.equal(session.playbook.consumed, consumedBeforeCommand);

    const editorCall = session.events.uiCallsFor("editor").at(-1);
    assert.ok(editorCall);
    assert.equal(editorCall.args[0], "Edit handoff prompt");
    assert.match(String(editorCall.args[1]), /Parent session: \/tmp\/parent-session\.jsonl/);
    assert.match(String(editorCall.args[1]), /session_query/);

    const setEditorTextCall = session.events.uiCallsFor("setEditorText").at(-1);
    assert.ok(setEditorTextCall);
    assert.match(String(setEditorTextCall.args[0]), /Reviewed by user/);

    const model = (session.session as { model: { provider: string; id: string }; thinkingLevel: string });
    assert.equal(model.model.provider, "mode-provider");
    assert.equal(model.model.id, "mode-model");
    assert.equal(model.thinkingLevel, "high");
    assert.equal(getLatestModeState(session), "rush");
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("handoff command autocompletes flags, modes, and models", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-handoff-autocomplete-"));
  let session: TestSession | undefined;
  const providers = createHandoffTestProviders("## Context\nCaptured.\n\n## Task\nContinue.");

  await writeHandoffModesFile(cwd);

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [modesExtension, handoffExtension, providers.extensionFactory],
    });
    patchHarnessAgent(session);

    const flagCompletions = await getCommandArgumentCompletions(session, "handoff", "-");
    assert.deepEqual(flagCompletions?.map((item) => item.label), ["-mode", "-model"]);

    const modeCompletions = await getCommandArgumentCompletions(session, "handoff", "-mode ");
    assert.ok(modeCompletions?.some((item) => item.label === "rush"));
    assert.ok(modeCompletions?.some((item) => item.label === "smart"));
    assert.match(modeCompletions?.find((item) => item.label === "rush")?.description ?? "", /mode-provider\/mode-model/);
    assert.match(modeCompletions?.find((item) => item.label === "rush")?.description ?? "", /thinking:high/);

    const remainingFlagCompletions = await getCommandArgumentCompletions(session, "handoff", "-mode rush -");
    assert.deepEqual(remainingFlagCompletions?.map((item) => item.label), ["-model"]);

    const modelCompletions = await getCommandArgumentCompletions(session, "handoff", "-model override");
    assert.equal(modelCompletions?.[0]?.value, "-model override-provider/override-model");
    assert.equal(modelCompletions?.[0]?.label, "override-model");
    assert.equal(modelCompletions?.[0]?.description, "override-provider");
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("handoff tool prompt includes available modes and refreshes after mode changes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-handoff-modes-prompt-"));
  let session: TestSession | undefined;
  const providers = createHandoffTestProviders("## Context\nCaptured.\n\n## Task\nContinue.");

  await writeHandoffModesFile(cwd);

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [modesExtension, handoffExtension, providers.extensionFactory],
    });
    patchHarnessAgent(session);

    const initialPrompt = getCurrentSystemPrompt(session);
    assert.match(initialPrompt, /<available_modes>/);
    assert.match(initialPrompt, /<mode name="rush" model="mode-provider\/mode-model" thinkingLevel="high" \/>/);
    assert.match(initialPrompt, /<mode name="smart" model="mode-provider\/smart-model" thinkingLevel="low" \/>/);

    await session.session.prompt("/mode store deep");
    await session.session.agent.waitForIdle();

    const updatedPrompt = getCurrentSystemPrompt(session);
    assert.match(updatedPrompt, /<mode name="deep"/);
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("handoff tool switches session and auto-sends generated prompt with parent session hint", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-handoff-tool-"));
  let session: TestSession | undefined;
  const providers = createHandoffTestProviders("## Context\nWe fixed the root cause.\n\n## Task\nShip the follow-up changes.");

  await writeHandoffModesFile(cwd);

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [modesExtension, handoffExtension, providers.extensionFactory],
    });
    patchHarnessAgent(session);

    setFakeParentSessionPath(session, "/tmp/tool-parent-session.jsonl");

    const playbook = createPlaybookStreamFn([
      when("We fixed the root cause", [
        says("Good."),
      ]),
      when("Please handoff this work to a new session", [
        calls("handoff", {
          goal: "Ship the follow-up changes.",
          mode: "rush",
          model: "override-provider/override-model",
        }),
        says("Original turn complete."),
      ]),
      when("Ship the follow-up changes.", [
        says("New session response."),
      ]),
    ]);
    (session.session.agent as { streamFn: unknown }).streamFn = playbook.streamFn;

    await session.session.prompt("We fixed the root cause");
    await session.session.agent.waitForIdle();

    await session.session.prompt("Please handoff this work to a new session");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.session.agent.waitForIdle();

    const toolExecutionEnd = session.events.all.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "handoff",
    );
    assert.ok(toolExecutionEnd);
    assert.equal(toolExecutionEnd.isError, false);

    const model = (session.session as { model: { provider: string; id: string }; thinkingLevel: string });
    assert.equal(model.model.provider, "override-provider");
    assert.equal(model.model.id, "override-model");
    assert.equal(playbook.state.consumed, 3);
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("LiteLLM provider registrations add the gemini provider via v1beta", () => {
  const registrations = createLiteLLMProviderRegistrations(
    {
      healthy: true,
      label: "public",
      origin: "https://litellm.example.test",
      baseUrl: "https://litellm.example.test/v1",
    },
    "TEST_KEY",
  );

  const geminiRegistration = registrations.find((registration) => registration.provider === "gemini");

  assert.ok(geminiRegistration);
  assert.equal(geminiRegistration.provider, "gemini");
  assert.equal(geminiRegistration.config.baseUrl, "https://litellm.example.test/v1beta");
  assert.equal(geminiRegistration.config.apiKey, "TEST_KEY");
  assert.ok(Array.isArray(geminiRegistration.config.models));
  assert.ok(geminiRegistration.config.models!.some((model) => model.id === "gemini-2.5-flash"));
});

test("model family system prompt updates immediately on model switching and preserves the pi tail", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-family-system-prompt-"));
  let session: TestSession | undefined;
  const providers = createModelFamilyTestProviders();

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [modelFamilySystemPromptExtension, providers.extensionFactory],
    });
    await session.session.setModel(providers.getModel("gpt-5.4") as never);

    const initialPrompt = getCurrentSystemPrompt(session);
    assert.equal(initialPrompt, buildModelFamilySystemPrompt(initialPrompt, "gpt-5.4"));
    const initialTail = extractPiDynamicTail(initialPrompt);

    await session.session.setModel(providers.getModel("gpt-5.4-mini") as never);
    assert.equal(getCurrentSystemPrompt(session), initialPrompt);

    await session.session.setModel(providers.getModel("gpt-5.4-codex") as never);
    const codexSystemPrompt = getCurrentSystemPrompt(session);
    assert.equal(codexSystemPrompt, buildModelFamilySystemPrompt(initialPrompt, "gpt-5.4-codex"));
    assert.equal(extractPiDynamicTail(codexSystemPrompt), initialTail);

    await session.session.setModel(providers.getModel("gemini-2.5-pro") as never);
    const geminiSystemPrompt = getCurrentSystemPrompt(session);
    assert.equal(geminiSystemPrompt, buildModelFamilySystemPrompt(initialPrompt, "gemini-2.5-pro"));
    assert.equal(extractPiDynamicTail(geminiSystemPrompt), initialTail);

    await session.session.setModel(providers.getModel("kimi-k2.5") as never);
    const kimiSystemPrompt = getCurrentSystemPrompt(session);
    assert.equal(kimiSystemPrompt, buildModelFamilySystemPrompt(initialPrompt, "kimi-k2.5"));

    await session.session.setModel(providers.getModel("router-1") as never);
    const defaultSystemPrompt = getCurrentSystemPrompt(session);
    assert.equal(defaultSystemPrompt, buildModelFamilySystemPrompt(initialPrompt, "router-1"));
    assert.equal(extractPiDynamicTail(defaultSystemPrompt), initialTail);
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model family system prompt is used for provider requests after switching models", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-family-system-prompt-provider-"));
  let session: TestSession | undefined;
  const providers = createModelFamilyTestProviders();
  const seenSystemPrompts: string[] = [];
  const captureSystemPromptExtension = (pi: ExtensionAPI) => {
    pi.on("before_agent_start", async (event) => {
      seenSystemPrompts.push(event.systemPrompt);
      return undefined;
    });
  };

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [modelFamilySystemPromptExtension, captureSystemPromptExtension, providers.extensionFactory],
    });
    await session.session.setModel(providers.getModel("gpt-5.4") as never);
    providers.setResponses(fauxAssistantMessage("ok"));

    await session.session.prompt("hello");
    await session.session.agent.waitForIdle();

    await session.session.setModel(providers.getModel("gemini-2.5-pro") as never);
    providers.setResponses(fauxAssistantMessage("ok"));

    await session.session.prompt("hello again");
    await session.session.agent.waitForIdle();

    assert.equal(seenSystemPrompts[0], buildModelFamilySystemPrompt(seenSystemPrompts[0]!, "gpt-5.4"));
    assert.equal(seenSystemPrompts[1], buildModelFamilySystemPrompt(seenSystemPrompts[0]!, "gemini-2.5-pro"));
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("mode changes switch the system prompt when the selected mode changes model family", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-family-system-prompt-modes-"));
  let session: TestSession | undefined;
  const providers = createModelFamilyTestProviders();

  await writeModelFamilyModesFile(cwd);

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [modelFamilySystemPromptExtension, modesExtension, providers.extensionFactory],
    });

    const gptPrompt = getCurrentSystemPrompt(session);
    await session.session.prompt("/mode research");
    await session.session.agent.waitForIdle();

    const currentPrompt = getCurrentSystemPrompt(session);
    assert.equal(currentPrompt, buildModelFamilySystemPrompt(gptPrompt, "gemini-2.5-pro"));
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
