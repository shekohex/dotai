import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  calls,
  createTestSession,
  says,
  when,
  type TestSession,
} from "@marcfargas/pi-test-harness";
import { DefaultResourceLoader, initTheme, InteractiveMode } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { setKeybindings } from "@mariozechner/pi-tui";
import { fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import stripAnsi from "strip-ansi";
import { createPlaybookStreamFn } from "../node_modules/@marcfargas/pi-test-harness/src/playbook.ts";
import { KeybindingsManager } from "../node_modules/@mariozechner/pi-coding-agent/dist/core/keybindings.js";
import webFetchExtension from "../src/extensions/fetch.ts";
import mermaidExtension, { extractMermaidBlocks } from "../src/extensions/mermaid.ts";
import webSearchExtension, { webSearchTool } from "../src/extensions/websearch.ts";
import patchExtension from "../src/extensions/patch.ts";
import handoffExtension from "../src/extensions/handoff.ts";
import { createLiteLLMProviderRegistrations } from "../src/extensions/litellm.ts";
import modelFamilySystemPromptExtension, {
  buildModelFamilySystemPrompt,
  extractPiDynamicTail,
} from "../src/extensions/model-family-system-prompt.ts";
import modesExtension from "../src/extensions/modes.ts";
import filesExtension from "../src/extensions/files.ts";
import executorExtension from "../src/extensions/executor/index.ts";
import { setExecutorSettingsForTests } from "../src/extensions/executor/settings.ts";
import {
  discoverSkillPaths,
  installBundledResourcePaths,
} from "../src/extensions/bundled-resources.ts";
import promptStashExtension, {
  getStashFilePath,
  loadStashEntries,
  saveStashEntries,
  type PromptStashEntry,
} from "../src/extensions/prompt-stash.ts";
import agentsMdExtension from "../src/extensions/agents-md.ts";
import { createSubagentExtension } from "../src/extensions/subagent.ts";
import type { MuxAdapter, PaneSubmitMode } from "../src/subagent-sdk/mux.ts";
import {
  setRegisteredThemes,
  theme as activeTheme,
} from "../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";

process.env.OPENAI_API_KEY ??= "test-key";

const TEST_TIMEOUT_MS = 15_000;

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

initTheme("dark");
setKeybindings(KeybindingsManager.create());

function forceApplyPatchExtension(pi: ExtensionAPI) {
  const enablePatchTool = () => {
    const nextTools = new Set(
      pi.getActiveTools().filter((toolName) => toolName !== "edit" && toolName !== "write"),
    );
    nextTools.add("apply_patch");
    pi.setActiveTools(Array.from(nextTools));
  };

  pi.on("session_start", async () => {
    enablePatchTool();
  });

  pi.on("before_agent_start", async () => {
    enablePatchTool();
    return;
  });
}

function patchHarnessAgent(testSession: TestSession): void {
  const agent = testSession.session.agent as {
    state: { tools: unknown[] };
    setTools?: (tools: unknown[]) => void;
  };
  agent.setTools ??= (tools: unknown[]) => {
    agent.state.tools = tools;
  };
}

async function withTempAgentDir<T>(agentDir: string, fn: () => Promise<T>): Promise<T> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    return await fn();
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
}

async function createExecutorProbeServer(
  scopeDir: string,
): Promise<{ mcpUrl: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url === "/api/scope") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "scope_test", name: "executor-test", dir: scopeDir }));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  return {
    mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

class HarnessMuxAdapter implements MuxAdapter {
  readonly backend = "tmux";
  readonly created: Array<{
    cwd: string;
    title: string;
    command: string;
    target: "pane" | "window";
    paneId: string;
  }> = [];
  readonly sent: Array<{ paneId: string; text: string; submitMode?: PaneSubmitMode }> = [];
  readonly killed: string[] = [];
  readonly existingPanes = new Set<string>();

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createPane(options: {
    cwd: string;
    title: string;
    command: string;
    target: "pane" | "window";
  }): Promise<{ paneId: string }> {
    const paneId = `%${this.created.length + 1}`;
    this.created.push({ ...options, paneId });
    this.existingPanes.add(paneId);
    return { paneId };
  }

  async sendText(paneId: string, text: string, submitMode?: PaneSubmitMode): Promise<void> {
    this.sent.push({ paneId, text, submitMode });
  }

  async paneExists(paneId: string): Promise<boolean> {
    return this.existingPanes.has(paneId);
  }

  async killPane(paneId: string): Promise<void> {
    this.killed.push(paneId);
    this.existingPanes.delete(paneId);
  }

  async capturePane(): Promise<{ text: string }> {
    return { text: "" };
  }
}

function createHandoffTestProviders(summaryText: string): {
  extensionFactory: (pi: ExtensionAPI) => void;
  getModel: (id: string) => { provider: string; id: string } & Record<string, unknown>;
  dispose: () => void;
} {
  const registrations = [
    registerFauxProvider({
      provider: "gemini",
      models: [
        {
          id: "gemini-3.1-flash-lite-preview",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    }),
    registerFauxProvider({
      provider: "codex-openai",
      models: [
        {
          id: "gpt-5.4-mini",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    }),
    registerFauxProvider({
      provider: "mode-provider",
      models: [
        {
          id: "mode-model",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
        {
          id: "smart-model",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    }),
    registerFauxProvider({
      provider: "override-provider",
      models: [
        {
          id: "override-model",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    }),
  ];

  registrations[0].setResponses([fauxAssistantMessage(summaryText)]);
  registrations[1].setResponses([fauxAssistantMessage(summaryText)]);
  registrations[2].setResponses([
    fauxAssistantMessage("mode-provider response"),
    fauxAssistantMessage("mode-provider response"),
  ]);
  registrations[3].setResponses([
    fauxAssistantMessage("override-provider response"),
    fauxAssistantMessage("override-provider response"),
  ]);
  const modelById = new Map(
    registrations.flatMap((registration) => {
      const providerModel = registration.getModel();
      return registration.models.map(
        (registeredModel) =>
          [
            registeredModel.id,
            {
              ...providerModel,
              id: registeredModel.id,
              name: registeredModel.name,
            },
          ] as const,
      );
    }),
  );

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
  setResponses: (
    response: Parameters<ReturnType<typeof registerFauxProvider>["setResponses"]>[0][number],
  ) => void;
  dispose: () => void;
} {
  const registrations = [
    registerFauxProvider({
      provider: "family-gpt",
      models: [
        {
          id: "gpt-5.4",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    }),
    registerFauxProvider({
      provider: "family-gpt-mini",
      models: [
        {
          id: "gpt-5.4-mini",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    }),
    registerFauxProvider({
      provider: "family-codex",
      models: [
        {
          id: "gpt-5.4-codex",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    }),
    registerFauxProvider({
      provider: "family-gemini",
      models: [
        {
          id: "gemini-2.5-pro",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    }),
    registerFauxProvider({
      provider: "family-kimi",
      models: [
        {
          id: "kimi-k2.5",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    }),
    registerFauxProvider({
      provider: "family-default",
      models: [
        {
          id: "router-1",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    }),
  ];

  const modelById = new Map(
    registrations.map((registration) => {
      const model = registration.getModel();
      return [model.id, model] as const;
    }),
  );

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
    `${JSON.stringify(
      {
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
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function writeHandoffModesFile(cwd: string): Promise<void> {
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "modes.json"),
    `${JSON.stringify(
      {
        version: 1,
        currentMode: "smart",
        modes: {
          smart: {
            provider: "mode-provider",
            modelId: "smart-model",
            thinkingLevel: "low",
          },
          docs: {
            description: "Fast technical writing",
            provider: "mode-provider",
            modelId: "mode-model",
            thinkingLevel: "high",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function writeSharedSelectionModesFile(cwd: string): Promise<void> {
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "modes.json"),
    `${JSON.stringify(
      {
        version: 1,
        currentMode: "deep",
        modes: {
          deep: {
            provider: "mode-provider",
            modelId: "mode-model",
            thinkingLevel: "high",
            tools: ["read", "bash"],
            systemPrompt: "Deep mode",
          },
          review: {
            provider: "mode-provider",
            modelId: "mode-model",
            thinkingLevel: "high",
            tools: ["read"],
            systemPrompt: "Review mode",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function withProcessCwd<T>(cwd: string, callback: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    return await callback();
  } finally {
    process.chdir(previousCwd);
  }
}

async function writeCliFlagModesFile(cwd: string): Promise<void> {
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "modes.json"),
    `${JSON.stringify(
      {
        version: 1,
        currentMode: "Deep Work",
        modes: {
          "Deep Work": {
            provider: "mode-provider",
            modelId: "smart-model",
            thinkingLevel: "low",
          },
          "Mini Max": {
            provider: "mode-provider",
            modelId: "mode-model",
            thinkingLevel: "high",
          },
          "Docs Fast": {
            provider: "mode-provider",
            modelId: "mode-model",
            thinkingLevel: "high",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function getLatestModeState(testSession: TestSession): string | undefined {
  const entries = (
    testSession.session as {
      sessionManager: {
        getEntries: () => Array<{
          type: string;
          customType?: string;
          data?: { activeMode?: string };
        }>;
      };
    }
  ).sessionManager.getEntries();

  return entries
    .filter((entry) => entry.type === "custom" && entry.customType === "mode-state")
    .at(-1)?.data?.activeMode;
}

function createActiveToolsCaptureExtension(capturedToolSets: string[][]) {
  return (pi: ExtensionAPI) => {
    pi.events.on("modes:changed", () => {
      queueMicrotask(() => {
        capturedToolSets.push(
          pi
            .getActiveTools()
            .slice()
            .toSorted((left, right) => left.localeCompare(right)),
        );
      });
    });
  };
}

function setFakeParentSessionPath(testSession: TestSession, sessionPath: string): void {
  const sessionManager = (
    testSession.session as { sessionManager: { getSessionFile: () => string | undefined } }
  ).sessionManager as {
    getSessionFile: () => string | undefined;
  };
  sessionManager.getSessionFile = () => sessionPath;
}

function setMockCustomLoaderResult(
  testSession: TestSession,
  result: { summary?: string; warning?: string; error?: string; aborted?: boolean },
): { calls: { count: number } } {
  const uiContext = (
    (testSession.session as { extensionRunner: { uiContext: { custom: <T>() => Promise<T> } } })
      .extensionRunner as {
      uiContext: { custom: <T>() => Promise<T> };
    }
  ).uiContext;
  const calls = { count: 0 };
  uiContext.custom = async <T>() => {
    calls.count += 1;
    return result as T;
  };
  return { calls };
}

function getBranchTextMessages(testSession: TestSession): Array<{ role: string; text: string }> {
  return (
    testSession.session as {
      sessionManager: {
        getBranch: () => Array<{
          type: string;
          message?: { role: string; content: string | Array<{ type: string; text?: string }> };
        }>;
      };
    }
  ).sessionManager
    .getBranch()
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
        .filter(
          (part): part is { type: "text"; text: string } =>
            part.type === "text" && typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("\n");
}

async function getCommandArgumentCompletions(
  testSession: TestSession,
  commandName: string,
  prefix: string,
): Promise<Array<{ value: string; label: string; description?: string }> | null> {
  const extensionRunner = (
    testSession.session as {
      extensionRunner: {
        getRegisteredCommands: () => Array<{
          name: string;
          invocationName: string;
          getArgumentCompletions?: (
            argumentPrefix: string,
          ) =>
            | Promise<Array<{ value: string; label: string; description?: string }> | null>
            | Array<{ value: string; label: string; description?: string }>
            | null;
        }>;
      };
    }
  ).extensionRunner;

  const command = extensionRunner
    .getRegisteredCommands()
    .find((registeredCommand) => registeredCommand.invocationName === commandName);
  assert.ok(command?.getArgumentCompletions);
  return await command.getArgumentCompletions(prefix);
}

function getCurrentSystemPrompt(testSession: TestSession): string {
  return (testSession.session as { agent: { state: { systemPrompt: string } } }).agent.state
    .systemPrompt;
}

function renderSessionChatLines(testSession: TestSession, width = 120): string[] {
  const mode = new InteractiveMode({
    session: testSession.session,
    dispose: async () => {},
    setBeforeSessionInvalidate: () => {},
    setRebindSession: () => {},
  } as never);

  try {
    const sessionContext = (
      testSession.session as {
        sessionManager: {
          buildSessionContext: () => { messages: Array<{ role: string; content: unknown }> };
        };
      }
    ).sessionManager.buildSessionContext();

    (mode as any).renderSessionContext(sessionContext);
    return (mode as any).chatContainer
      .render(width)
      .map((line: string) => stripAnsi(line).trimEnd());
  } finally {
    ((mode as any).footerDataProvider as { dispose: () => void }).dispose();
  }
}

type CapturedModeChange = {
  mode?: string;
  previousMode?: string;
  source?: string;
  reason?: string;
  spec?: {
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
  };
};

function createModeChangeCaptureExtension(
  observedEvents: CapturedModeChange[],
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const emit = pi.events.emit.bind(pi.events) as (eventName: string, data: unknown) => void;
    (pi.events as { emit: (eventName: string, data: unknown) => void }).emit = (
      eventName,
      data,
    ) => {
      if (eventName === "modes:changed") {
        observedEvents.push(data as CapturedModeChange);
      }

      emit(eventName, data);
    };
  };
}

function createPromptStashEntry(id: string, text: string, createdAt: number): PromptStashEntry {
  return {
    version: 1,
    id,
    text,
    createdAt,
  };
}

timedTest("pi-test-harness runs apply_patch against the real tool implementation", async () => {
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

timedTest("pi-test-harness captures mocked built-in tool events", async () => {
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
    assert.match(
      session.events.toolResultsFor("bash")[0]?.text ?? "",
      /ran: npm run test:tool-preview/,
    );
  } finally {
    session?.dispose();
  }
});

timedTest("pi-test-harness runs webfetch against the real tool implementation", async () => {
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
    res.end(
      JSON.stringify({
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
      }),
    );
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
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    session?.dispose();
  }
});

timedTest("websearch emits streaming updates before the final result", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const updates: Array<{
    content?: Array<{ type: string; text?: string }>;
    details?: { answer?: string };
  }> = [];

  globalThis.fetch = async (input, init) => {
    const requestHeaders = input instanceof Request ? input.headers : undefined;
    const initHeaders =
      init?.headers instanceof Headers
        ? init.headers
        : new Headers((init?.headers as Record<string, string> | undefined) ?? {});
    const getHeader = (name: string) => requestHeaders?.get(name) ?? initHeaders.get(name) ?? "";
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.endsWith("/health/readiness")) {
      return new Response("ok", { status: 200 });
    }

    if (url.includes(":streamGenerateContent")) {
      assert.ok(getHeader("x-goog-api-key").length > 0);
      const stream = new ReadableStream({
        start(controller) {
          const events = [
            {
              candidates: [
                {
                  content: {
                    parts: [
                      { text: JSON.stringify({ answer: "Next.js 16 released in October 2025." }) },
                    ],
                  },
                },
              ],
            },
            {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          answer: [
                            "Next.js 16 released in October 2025.",
                            "Turbopack stabilization and caching changes were part of the release.",
                            "Teams should re-run production build verification after upgrading.",
                          ].join("\n"),
                          sources: [
                            { title: "Next.js 16", url: "https://nextjs.org/blog/next-16" },
                            {
                              title: "Version 16 Upgrade Guide",
                              url: "https://nextjs.org/docs/app/guides/upgrading/version-16",
                            },
                          ],
                          searchQueries: [
                            "next.js 16 release date official",
                            "next.js 16 upgrade guide",
                          ],
                        }),
                      },
                    ],
                  },
                },
              ],
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
        updates.push(
          update as {
            content?: Array<{ type: string; text?: string }>;
            details?: { answer?: string };
          },
        );
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

timedTest("websearch uses the LiteLLM api key with the gemini model provider", async () => {
  const originalFetch = globalThis.fetch;
  const originalLiteLLMApiKey = process.env.LITELLM_API_KEY;
  let session: TestSession | undefined;

  process.env.LITELLM_API_KEY = "litellm-test-key";

  globalThis.fetch = async (input, init) => {
    const requestHeaders = input instanceof Request ? input.headers : undefined;
    const initHeaders =
      init?.headers instanceof Headers
        ? init.headers
        : new Headers((init?.headers as Record<string, string> | undefined) ?? {});
    const getHeader = (name: string) => requestHeaders?.get(name) ?? initHeaders.get(name) ?? "";
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.endsWith("/health/readiness")) {
      return new Response("ok", { status: 200 });
    }

    if (url.includes(":streamGenerateContent")) {
      assert.equal(getHeader("x-goog-api-key"), "litellm-test-key");
      return new Response(
        JSON.stringify([
          {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        answer: "Next.js 16 released in October 2025.",
                        sources: [{ title: "Next.js 16", url: "https://nextjs.org/blog/next-16" }],
                        searchQueries: ["next.js 16 release date official"],
                      }),
                    },
                  ],
                },
              },
            ],
          },
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
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

timedTest("bundled themes are available before reload", async () => {
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

timedTest("handoff command starts the new session in the requested mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-handoff-command-"));
  let session: TestSession | undefined;
  const observedModeChanges: CapturedModeChange[] = [];
  const providers = createHandoffTestProviders(
    "## Context\nPrior decisions captured.\n\n## Task\nFinish the implementation.",
  );

  await writeHandoffModesFile(cwd);

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [
        modesExtension,
        handoffExtension,
        createModeChangeCaptureExtension(observedModeChanges),
        providers.extensionFactory,
      ],
      mockUI: {
        editor: (_title, prefill) => `${prefill ?? ""}\n\nReviewed by user`,
      },
    });
    patchHarnessAgent(session);

    setFakeParentSessionPath(session, "/tmp/parent-session.jsonl");
    const loader = setMockCustomLoaderResult(session, {
      summary: "## Context\nPrior decisions captured.\n\n## Task\nFinish the implementation.",
    });

    await session.run(
      when("We traced the regression to the handoff extension", [says("Captured.")]),
    );

    const consumedBeforeCommand = session.playbook.consumed;
    observedModeChanges.length = 0;

    await session.session.prompt("/handoff -mode docs finish the implementation");
    await session.session.agent.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(session.playbook.consumed, consumedBeforeCommand);
    assert.equal(session.events.uiCallsFor("editor").length, 0);
    assert.equal(session.events.uiCallsFor("setEditorText").length, 0);

    const model = session.session as {
      model: { provider: string; id: string };
      thinkingLevel: string;
    };
    assert.equal(model.model.provider, "mode-provider");
    assert.equal(model.model.id, "mode-model");
    assert.equal(model.thinkingLevel, "high");
    assert.equal(getLatestModeState(session), "docs");
    assert.equal(loader.calls.count, 1);

    const userMessages = getBranchTextMessages(session).filter((entry) => entry.role === "user");
    assert.ok(
      userMessages.some((entry) =>
        entry.text.includes("Parent session: /tmp/parent-session.jsonl"),
      ),
    );

    const restoreEvents = observedModeChanges.filter((event) => event.reason === "restore");
    assert.equal(restoreEvents.length, 1, JSON.stringify(observedModeChanges));
    assert.equal(restoreEvents[0]?.mode, "docs");
    assert.equal(restoreEvents[0]?.source, "session_start");
    assert.equal(restoreEvents[0]?.spec?.provider, "mode-provider");
    assert.equal(restoreEvents[0]?.spec?.modelId, "mode-model");
    assert.equal(restoreEvents[0]?.spec?.thinkingLevel, "high");
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("handoff command with mode and model applies the startup selection once", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-handoff-command-mixed-"));
  let session: TestSession | undefined;
  const observedModeChanges: CapturedModeChange[] = [];
  const providers = createHandoffTestProviders(
    "## Context\nPrior decisions captured.\n\n## Task\nFinish the implementation.",
  );

  await writeHandoffModesFile(cwd);

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [
        modesExtension,
        handoffExtension,
        createModeChangeCaptureExtension(observedModeChanges),
        providers.extensionFactory,
      ],
      mockUI: {
        editor: (_title, prefill) => `${prefill ?? ""}\n\nReviewed by user`,
      },
    });
    patchHarnessAgent(session);

    setFakeParentSessionPath(session, "/tmp/parent-session.jsonl");
    const loader = setMockCustomLoaderResult(session, {
      summary: "## Context\nPrior decisions captured.\n\n## Task\nFinish the implementation.",
    });

    await session.run(
      when("We traced the regression to the handoff extension", [says("Captured.")]),
    );

    observedModeChanges.length = 0;

    await session.session.prompt(
      "/handoff -mode docs -model override-provider/override-model finish the implementation",
    );
    await session.session.agent.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const model = session.session as {
      model: { provider: string; id: string };
      thinkingLevel: string;
    };
    assert.equal(model.model.provider, "override-provider");
    assert.equal(model.model.id, "override-model");
    assert.equal(model.thinkingLevel, "high");
    assert.equal(getLatestModeState(session), undefined);
    assert.equal(loader.calls.count, 1);

    assert.equal(observedModeChanges.length, 1, JSON.stringify(observedModeChanges));
    assert.equal(observedModeChanges[0]?.mode, undefined);
    assert.equal(observedModeChanges[0]?.reason, "restore");
    assert.equal(observedModeChanges[0]?.source, "session_start");
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("handoff command autocompletes flags, modes, and models", async () => {
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
    assert.deepEqual(
      flagCompletions?.map((item) => item.label),
      ["-mode", "-model"],
    );

    const modeCompletions = await getCommandArgumentCompletions(session, "handoff", "-mode ");
    assert.ok(modeCompletions?.some((item) => item.label === "docs"));
    assert.ok(modeCompletions?.some((item) => item.label === "smart"));
    assert.match(
      modeCompletions?.find((item) => item.label === "docs")?.description ?? "",
      /mode-provider\/mode-model/,
    );
    assert.match(
      modeCompletions?.find((item) => item.label === "docs")?.description ?? "",
      /thinking:high/,
    );

    const remainingFlagCompletions = await getCommandArgumentCompletions(
      session,
      "handoff",
      "-mode docs -",
    );
    assert.deepEqual(
      remainingFlagCompletions?.map((item) => item.label),
      ["-model"],
    );

    const modelCompletions = await getCommandArgumentCompletions(
      session,
      "handoff",
      "-model override",
    );
    assert.equal(modelCompletions?.[0]?.value, "-model override-provider/override-model");
    assert.equal(modelCompletions?.[0]?.label, "override-model");
    assert.equal(modelCompletions?.[0]?.description, "override-provider");
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("executor command autocompletes subcommands with fuzzy search", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-executor-autocomplete-"));
  let session: TestSession | undefined;
  const server = await createExecutorProbeServer(cwd);

  try {
    setExecutorSettingsForTests({
      autoStart: true,
      probeTimeoutMs: 200,
      candidates: [{ label: "lan", mcpUrl: server.mcpUrl }],
    });

    session = await createTestSession({
      cwd,
      extensionFactories: [executorExtension],
    });

    const rootCompletions = await getCommandArgumentCompletions(session, "executor", "");
    assert.deepEqual(
      rootCompletions?.map((item) => item.label),
      ["status", "web"],
    );

    const fuzzyCompletions = await getCommandArgumentCompletions(session, "executor", "w");
    assert.equal(fuzzyCompletions?.[0]?.label, "web");
    assert.ok(fuzzyCompletions?.some((item) => item.label === "status"));
  } finally {
    setExecutorSettingsForTests(undefined);
    await server.close();
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("executor command without arguments shows status", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-executor-command-"));
  let session: TestSession | undefined;
  const server = await createExecutorProbeServer(cwd);

  try {
    setExecutorSettingsForTests({
      autoStart: true,
      probeTimeoutMs: 200,
      candidates: [{ label: "lan", mcpUrl: server.mcpUrl }],
    });

    session = await createTestSession({
      cwd,
      extensionFactories: [executorExtension],
    });

    const uiContext = (
      session.session as {
        _extensionUIContext?: { custom?: (...args: unknown[]) => Promise<unknown> };
      }
    )._extensionUIContext;
    assert.ok(uiContext);

    const customCalls: Array<{ args: unknown[] }> = [];
    const originalCustom = uiContext.custom?.bind(uiContext) ?? (async () => {});
    uiContext.custom = async (...args: unknown[]) => {
      customCalls.push({ args });
      return originalCustom(...(args as never));
    };

    await session.session.prompt("/executor");
    await session.session.agent.waitForIdle();

    assert.equal(customCalls.length, 1);
    assert.equal(typeof customCalls[0]?.args[0], "function");
    assert.equal(customCalls[0]?.args[1], undefined);

    const branchEntries = (
      session.session as {
        sessionManager: {
          getBranch: () => Array<{
            type: string;
            customType?: string;
            content?: string;
            details?: { state?: { kind?: string }; candidates?: Array<{ mcpUrl?: string }> };
          }>;
        };
      }
    ).sessionManager.getBranch();

    const executorMessages = branchEntries.filter(
      (entry) => entry.type === "custom_message" && entry.customType === "executor",
    );

    assert.equal(executorMessages.length, 0);
  } finally {
    setExecutorSettingsForTests(undefined);
    await server.close();
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest(
  "subagent tool prompt includes available modes and refreshes after mode changes",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-handoff-modes-prompt-"));
    let session: TestSession | undefined;
    const providers = createHandoffTestProviders("## Context\nCaptured.\n\n## Task\nContinue.");

    await writeHandoffModesFile(cwd);

    try {
      session = await createTestSession({
        cwd,
        extensionFactories: [modesExtension, createSubagentExtension(), providers.extensionFactory],
      });
      patchHarnessAgent(session);

      const initialPrompt = getCurrentSystemPrompt(session);
      assert.match(initialPrompt, /<available_modes>/);
      assert.match(
        initialPrompt,
        /<mode name="docs" model="mode-provider\/mode-model" thinkingLevel="high" description="Fast technical writing" \/>/,
      );
      assert.match(
        initialPrompt,
        /<mode name="smart" model="mode-provider\/smart-model" thinkingLevel="low" \/>/,
      );

      await session.session.prompt("/mode store deep");
      await session.session.agent.waitForIdle();

      const updatedPrompt = getCurrentSystemPrompt(session);
      assert.match(updatedPrompt, /<mode name="deep"/);
    } finally {
      session?.dispose();
      providers.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest("modes extension registers CLI flags from discovered modes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-mode-flags-"));
  const providers = createHandoffTestProviders("## Context\nCaptured.\n\n## Task\nContinue.");

  await writeCliFlagModesFile(cwd);

  try {
    await withProcessCwd(cwd, async () => {
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: cwd,
        extensionFactories: [modesExtension, providers.extensionFactory],
      });
      await loader.reload();

      const flags = loader
        .getExtensions()
        .extensions.flatMap((extension) => Array.from(extension.flags.keys()));

      assert.ok(flags.includes("mode-deep-work"));
      assert.ok(flags.includes("mode-mini-max"));
      assert.ok(flags.includes("mode-docs-fast"));
    });
  } finally {
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("mode CLI flags apply the selected mode on reload startup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-mode-flags-reload-"));
  let session: TestSession | undefined;
  const observedModeChanges: CapturedModeChange[] = [];
  const providers = createHandoffTestProviders("## Context\nCaptured.\n\n## Task\nContinue.");

  await writeHandoffModesFile(cwd);

  try {
    await withProcessCwd(cwd, async () => {
      session = await createTestSession({
        cwd,
        extensionFactories: [
          modesExtension,
          createModeChangeCaptureExtension(observedModeChanges),
          providers.extensionFactory,
        ],
      });

      observedModeChanges.length = 0;
      (
        session!.session as {
          extensionRunner: { setFlagValue: (name: string, value: boolean | string) => void };
        }
      ).extensionRunner.setFlagValue("mode-docs", true);

      await session!.session.reload();

      const model = session!.session as {
        model: { provider: string; id: string };
        thinkingLevel: string;
      };
      assert.equal(model.model.provider, "mode-provider");
      assert.equal(model.model.id, "mode-model");
      assert.equal(model.thinkingLevel, "high");
      assert.equal(getLatestModeState(session!), "docs");

      assert.ok(observedModeChanges.length > 0, JSON.stringify(observedModeChanges));
      const latestModeChange = observedModeChanges.at(-1);
      assert.equal(latestModeChange?.mode, "docs");
      assert.equal(latestModeChange?.reason, "restore");
      assert.equal(latestModeChange?.source, "session_start");
      assert.equal(latestModeChange?.spec?.provider, "mode-provider");
      assert.equal(latestModeChange?.spec?.modelId, "mode-model");
      assert.equal(latestModeChange?.spec?.thinkingLevel, "high");
    });
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest(
  "mode CLI flags preserve the explicit startup mode when modes share a selection",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-mode-flags-shared-selection-"));
    let session: TestSession | undefined;
    const observedModeChanges: CapturedModeChange[] = [];
    const providers = createHandoffTestProviders("## Context\nCaptured.\n\n## Task\nContinue.");

    await writeSharedSelectionModesFile(cwd);

    try {
      await withProcessCwd(cwd, async () => {
        session = await createTestSession({
          cwd,
          extensionFactories: [
            modesExtension,
            createModeChangeCaptureExtension(observedModeChanges),
            providers.extensionFactory,
          ],
        });

        (
          session!.session as {
            extensionRunner: { setFlagValue: (name: string, value: boolean | string) => void };
          }
        ).extensionRunner.setFlagValue("mode-review", true);

        await session!.session.reload();

        const model = session!.session as {
          model: { provider: string; id: string };
          thinkingLevel: string;
        };
        assert.equal(model.model.provider, "mode-provider");
        assert.equal(model.model.id, "mode-model");
        assert.equal(model.thinkingLevel, "high");
        assert.equal(getLatestModeState(session!), "review");

        observedModeChanges.length = 0;

        await session!.session.prompt("hello");
        await session!.session.agent.waitForIdle();
        await new Promise((resolve) => setTimeout(resolve, 25));

        assert.equal(getLatestModeState(session!), "review");
        assert.equal(observedModeChanges.length, 0, JSON.stringify(observedModeChanges));
      });
    } finally {
      session?.dispose();
      providers.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest("LiteLLM provider registrations add the gemini provider via v1beta", () => {
  const registrations = createLiteLLMProviderRegistrations(
    {
      healthy: true,
      label: "public",
      origin: "https://litellm.example.test",
      baseUrl: "https://litellm.example.test/v1",
    },
    "TEST_KEY",
  );

  const geminiRegistration = registrations.find(
    (registration) => registration.provider === "gemini",
  );

  assert.ok(geminiRegistration);
  assert.equal(geminiRegistration.provider, "gemini");
  assert.equal(geminiRegistration.config.baseUrl, "https://litellm.example.test/v1beta");
  assert.equal(geminiRegistration.config.apiKey, "TEST_KEY");
  assert.ok(Array.isArray(geminiRegistration.config.models));
  assert.ok(geminiRegistration.config.models!.some((model) => model.id === "gemini-2.5-flash"));
});

timedTest(
  "model family system prompt updates immediately on model switching and preserves the pi tail",
  async () => {
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
      assert.equal(
        geminiSystemPrompt,
        buildModelFamilySystemPrompt(initialPrompt, "gemini-2.5-pro"),
      );
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
  },
);

timedTest(
  "model family system prompt is used for provider requests after switching models",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-family-system-prompt-provider-"));
    let session: TestSession | undefined;
    const providers = createModelFamilyTestProviders();
    const seenSystemPrompts: string[] = [];
    const captureSystemPromptExtension = (pi: ExtensionAPI) => {
      pi.on("before_agent_start", async (event) => {
        seenSystemPrompts.push(event.systemPrompt);
        return;
      });
    };

    try {
      session = await createTestSession({
        cwd,
        extensionFactories: [
          modelFamilySystemPromptExtension,
          captureSystemPromptExtension,
          providers.extensionFactory,
        ],
      });
      await session.session.setModel(providers.getModel("gpt-5.4") as never);
      providers.setResponses(fauxAssistantMessage("ok"));

      await session.session.prompt("hello");
      await session.session.agent.waitForIdle();

      await session.session.setModel(providers.getModel("gemini-2.5-pro") as never);
      providers.setResponses(fauxAssistantMessage("ok"));

      await session.session.prompt("hello again");
      await session.session.agent.waitForIdle();

      assert.equal(
        seenSystemPrompts[0],
        buildModelFamilySystemPrompt(seenSystemPrompts[0]!, "gpt-5.4"),
      );
      assert.equal(
        seenSystemPrompts[1],
        buildModelFamilySystemPrompt(seenSystemPrompts[0]!, "gemini-2.5-pro"),
      );
    } finally {
      session?.dispose();
      providers.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest(
  "mode changes switch the system prompt when the selected mode changes model family",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-family-system-prompt-modes-"));
    let session: TestSession | undefined;
    const providers = createModelFamilyTestProviders();

    await writeModelFamilyModesFile(cwd);

    try {
      session = await createTestSession({
        cwd,
        extensionFactories: [
          modelFamilySystemPromptExtension,
          modesExtension,
          providers.extensionFactory,
        ],
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
  },
);

timedTest(
  "modes extension scopes tools and restores the default toolset when leaving a scoped mode",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-mode-tools-"));
    let session: TestSession | undefined;
    const providers = createHandoffTestProviders("## Context\nCaptured.\n\n## Task\nContinue.");
    const capturedToolSets: string[][] = [];

    await writeSharedSelectionModesFile(cwd);

    try {
      session = await createTestSession({
        cwd,
        extensionFactories: [
          modesExtension,
          createActiveToolsCaptureExtension(capturedToolSets),
          providers.extensionFactory,
        ],
      });
      await session.session.prompt("/mode deep");
      await session.session.agent.waitForIdle();
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.deepEqual(capturedToolSets.at(-1), ["bash", "read"]);

      await session.session.prompt("/mode review");
      await session.session.agent.waitForIdle();
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.deepEqual(capturedToolSets.at(-1), ["read"]);

      await session.session.setModel(providers.getModel("smart-model") as never);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const restoredToolNames = capturedToolSets.at(-1) ?? [];
      assert.ok(restoredToolNames.includes("bash"));
      assert.ok(restoredToolNames.includes("read"));
      assert.ok(restoredToolNames.includes("edit"));
      assert.ok(restoredToolNames.includes("write"));
      assert.ok(!restoredToolNames.includes("apply_patch"));
    } finally {
      session?.dispose();
      providers.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest(
  "mermaid extension renders assistant diagrams inline without emitting extra custom messages",
  async () => {
    let session: TestSession | undefined;

    try {
      session = await createTestSession({
        extensionFactories: [mermaidExtension],
      });
      patchHarnessAgent(session);

      const playbook = createPlaybookStreamFn([
        when("Show me the release flow", [
          says(
            [
              "Release flow:",
              "",
              "```mermaid",
              "graph TD",
              "  Start --> Validate",
              "  Validate --> Build",
              "  Build --> Ship",
              "```",
              "",
              "Done.",
            ].join("\n"),
          ),
        ]),
      ]);

      (session.session.agent as { streamFn: unknown }).streamFn = playbook.streamFn;

      await session.session.prompt("Show me the release flow");
      await session.session.agent.waitForIdle();

      const branchEntries = (
        session.session as {
          sessionManager: {
            getBranch: () => Array<{
              type: string;
              message?: { role: string; customType?: string };
              customType?: string;
            }>;
          };
        }
      ).sessionManager.getBranch();

      const customMermaidMessages = branchEntries.filter(
        (entry) => entry.type === "custom_message" && entry.customType === "pi-mermaid",
      );
      assert.equal(customMermaidMessages.length, 0);

      const renderedText = renderSessionChatLines(session).join("\n");
      assert.match(renderedText, /Release flow:/);
      assert.match(renderedText, /Done\./);
      assert.match(renderedText, /Start/);
      assert.match(renderedText, /Validate/);
      assert.doesNotMatch(renderedText, /```mermaid/);
      assert.doesNotMatch(renderedText, /graph TD/);
      assert.doesNotMatch(renderedText, /parser validation isn.?t usable/i);
      assert.doesNotMatch(renderedText, /more lines, to expand/i);
    } finally {
      session?.dispose();
    }
  },
);

timedTest(
  "agents-md extension loads nested AGENTS context once per session and notifies the UI",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-agents-md-"));
    const agentDir = await mkdtemp(join(tmpdir(), "agent-agents-md-global-"));
    let session: TestSession | undefined;

    try {
      await mkdir(join(cwd, "src", "components"), { recursive: true });
      await writeFile(join(cwd, "AGENTS.md"), "root rule\n", "utf8");
      await writeFile(join(cwd, "src", "AGENTS.md"), "plain src rule\n", "utf8");
      await writeFile(
        join(cwd, "src", "AGENTS.override.md"),
        "override src rule\nsecond override line\n",
        "utf8",
      );
      await writeFile(join(cwd, "src", "components", "AGENTS.md"), "component rule\n", "utf8");
      await writeFile(
        join(cwd, "src", "components", "Button.tsx"),
        "export const Button = () => null;\n",
        "utf8",
      );

      await withTempAgentDir(agentDir, async () => {
        session = await createTestSession({
          cwd,
          extensionFactories: [agentsMdExtension],
        });
        patchHarnessAgent(session);

        await session.run(
          when("Read the button component", [
            calls("read", { path: "src/components/Button.tsx" }),
            says("done"),
          ]),
          when("Read the button component again", [
            calls("read", { path: "src/components/Button.tsx" }),
            says("done again"),
          ]),
        );

        const readResults = session.events.all
          .filter((event) => event.type === "tool_execution_end" && event.toolName === "read")
          .map((event) =>
            (
              (event as { result?: { content?: Array<{ type: string; text?: string }> } }).result
                ?.content ?? []
            )
              .filter((part) => part.type === "text")
              .map((part) => part.text ?? "")
              .join("\n"),
          );

        assert.equal(readResults.length, 2);
        assert.match(readResults[0] ?? "", /export const Button = \(\) => null;/);
        assert.match(
          readResults[0] ?? "",
          /Loaded subdirectory context from .*src\/AGENTS\.override\.md/,
        );
        assert.match(readResults[0] ?? "", /override src rule/);
        assert.match(readResults[0] ?? "", /second override line/);
        assert.match(
          readResults[0] ?? "",
          /Loaded subdirectory context from .*src\/components\/AGENTS\.md/,
        );
        assert.match(readResults[0] ?? "", /component rule/);
        assert.doesNotMatch(readResults[0] ?? "", /plain src rule/);
        assert.doesNotMatch(readResults[0] ?? "", /root rule/);

        assert.match(readResults[1] ?? "", /export const Button = \(\) => null;/);
        assert.doesNotMatch(readResults[1] ?? "", /Loaded subdirectory context from/);
        assert.doesNotMatch(readResults[1] ?? "", /override src rule/);
        assert.doesNotMatch(readResults[1] ?? "", /component rule/);

        const notifications = session.events.uiCallsFor("notify").map((call) => call.args[0]);
        assert.deepEqual(notifications, [
          "Loaded src/AGENTS.override.md into context (2 lines)",
          "Loaded src/components/AGENTS.md into context (1 line)",
        ]);
      });
    } finally {
      session?.dispose();
      await rm(cwd, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  },
);

timedTest("agents-md extension ignores bundled skill reads outside the session cwd", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-agents-md-skill-"));
  let session: TestSession | undefined;

  try {
    const executorSkillPath = discoverSkillPaths().find((skillPath) =>
      skillPath.endsWith("/executor/SKILL.md"),
    );

    assert.ok(executorSkillPath);

    session = await createTestSession({
      cwd,
      extensionFactories: [agentsMdExtension],
    });
    patchHarnessAgent(session);

    await session.run(
      when("Read bundled executor skill", [
        calls("read", { path: executorSkillPath }),
        says("done"),
      ]),
    );

    const readResult = session.events.all
      .filter((event) => event.type === "tool_execution_end" && event.toolName === "read")
      .map((event) =>
        (
          (event as { result?: { content?: Array<{ type: string; text?: string }> } }).result
            ?.content ?? []
        )
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n"),
      )
      .join("\n");

    assert.match(readResult, /name: executor/);
    assert.doesNotMatch(readResult, /Loaded subdirectory context from/);

    const notifications = session.events.uiCallsFor("notify").map((call) => call.args[0]);
    assert.deepEqual(notifications, []);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("agents-md extension loads AGENTS only within the session git root", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-agents-md-repo-root-"));
  const cwd = join(repoRoot, "apps", "cli");
  const externalDir = await mkdtemp(join(homedir(), "agent-agents-md-external-"));
  let session: TestSession | undefined;

  try {
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await mkdir(join(repoRoot, "shared"), { recursive: true });

    await writeFile(join(repoRoot, "AGENTS.md"), "repo root rule\n", "utf8");
    await writeFile(join(repoRoot, "shared", "AGENTS.md"), "shared rule\n", "utf8");
    await writeFile(join(repoRoot, "shared", "util.ts"), "export const util = 1;\n", "utf8");

    await writeFile(join(externalDir, "AGENTS.md"), "external rule\n", "utf8");
    await writeFile(join(externalDir, "note.txt"), "outside file\n", "utf8");

    session = await createTestSession({
      cwd,
      extensionFactories: [agentsMdExtension],
    });
    patchHarnessAgent(session);

    await session.run(
      when("Read file within repo but outside cwd", [
        calls("read", { path: join(repoRoot, "shared", "util.ts") }),
        says("done"),
      ]),
      when("Read file outside repo root", [
        calls("read", { path: join(externalDir, "note.txt") }),
        says("done"),
      ]),
    );

    const readResults = session.events.all
      .filter((event) => event.type === "tool_execution_end" && event.toolName === "read")
      .map((event) =>
        (
          (event as { result?: { content?: Array<{ type: string; text?: string }> } }).result
            ?.content ?? []
        )
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n"),
      );

    assert.equal(readResults.length, 2);
    assert.match(readResults[0] ?? "", /export const util = 1;/);
    assert.match(readResults[0] ?? "", /Loaded subdirectory context from .*shared\/AGENTS\.md/);
    assert.match(readResults[0] ?? "", /shared rule/);
    assert.doesNotMatch(readResults[0] ?? "", /repo root rule/);

    assert.match(readResults[1] ?? "", /outside file/);
    assert.doesNotMatch(readResults[1] ?? "", /Loaded subdirectory context from/);
    assert.doesNotMatch(readResults[1] ?? "", /external rule/);

    const notifications = session.events.uiCallsFor("notify").map((call) => call.args[0]);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0] ?? "", /shared\/AGENTS\.md/);
  } finally {
    session?.dispose();
    await rm(repoRoot, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});

timedTest(
  "subagent extension runs start, list, message, cancel, and auto-resume through the harness playbook",
  async () => {
    let session: TestSession | undefined;
    const mux = new HarnessMuxAdapter();

    try {
      session = await createTestSession({
        extensionFactories: [createSubagentExtension({ adapterFactory: () => mux })],
      });
      patchHarnessAgent(session);

      await session.run(
        when("Start a delegated worker", [
          calls("subagent", {
            action: "start",
            name: "worker-one",
            task: "Inspect failing tests",
          }),
          says("Started."),
        ]),
        when("List delegated workers", [calls("subagent", { action: "list" }), says("Listed.")]),
        when("Send follow-up to delegated worker", [
          calls("subagent", () => {
            const startEvent = session!.events.all.find(
              (event) => event.type === "tool_execution_end" && event.toolName === "subagent",
            ) as { result?: { details?: { state?: { sessionId?: string } } } } | undefined;
            const sessionId = startEvent?.result?.details?.state?.sessionId ?? "";
            return {
              action: "message",
              sessionId,
              message: "Focus on src/extensions first",
              delivery: "steer",
            };
          }),
          says("Messaged."),
        ]),
        when("Cancel delegated worker", [
          calls("subagent", () => {
            const startEvent = session!.events.all.find(
              (event) => event.type === "tool_execution_end" && event.toolName === "subagent",
            ) as { result?: { details?: { state?: { sessionId?: string } } } } | undefined;
            const sessionId = startEvent?.result?.details?.state?.sessionId ?? "";
            return {
              action: "cancel",
              sessionId,
            };
          }),
          says("Cancelled."),
        ]),
        when("Message delegated worker after cancel", [
          calls("subagent", () => {
            const startEvent = session!.events.all.find(
              (event) => event.type === "tool_execution_end" && event.toolName === "subagent",
            ) as { result?: { details?: { state?: { sessionId?: string } } } } | undefined;
            const sessionId = startEvent?.result?.details?.state?.sessionId ?? "";
            return {
              action: "message",
              sessionId,
              message: "Address review feedback",
              delivery: "followUp",
            };
          }),
          says("Messaged again."),
        ]),
      );

      const executionEnds = session.events.all.filter(
        (event) => event.type === "tool_execution_end" && event.toolName === "subagent",
      ) as Array<{
        result?: {
          content?: Array<{ type: string; text?: string }>;
          details?: { state?: { sessionId?: string; sessionPath?: string } };
        };
        isError?: boolean;
      }>;
      const startedState = executionEnds[0]?.result?.details?.state;
      const sessionId = startedState?.sessionId ?? "";
      const sessionPath = startedState?.sessionPath ?? "";

      assert.match(sessionId, /^[0-9a-f-]{36}$/i);
      assert.equal(executionEnds.length, 5);
      assert.ok(executionEnds.every((event) => event.isError === false));
      assert.match(
        executionEnds[0]?.result?.content?.[0]?.text ?? "",
        /The subagent will return with a summary automatically when it finishes/i,
      );
      assert.match(executionEnds[1]?.result?.content?.[0]?.text ?? "", /count: 1/);
      assert.match(
        executionEnds[1]?.result?.content?.[0]?.text ?? "",
        new RegExp(`sessionId: ${sessionId}`),
      );
      assert.match(
        executionEnds[2]?.result?.content?.[0]?.text ?? "",
        new RegExp(`sessionId: ${sessionId}`),
      );
      assert.match(executionEnds[2]?.result?.content?.[0]?.text ?? "", /delivery: steer/);
      assert.match(
        executionEnds[3]?.result?.content?.[0]?.text ?? "",
        new RegExp(`sessionId: ${sessionId}`),
      );
      assert.match(executionEnds[3]?.result?.content?.[0]?.text ?? "", /cancelled/i);
      assert.match(
        executionEnds[4]?.result?.content?.[0]?.text ?? "",
        new RegExp(`sessionId: ${sessionId}`),
      );
      assert.match(
        executionEnds[4]?.result?.content?.[0]?.text ?? "",
        /Previous task resumed and followUp message delivered/i,
      );

      assert.equal(mux.created.length, 2);
      assert.equal(mux.sent.length, 2);
      assert.equal(mux.killed.length, 1);
      assert.equal(mux.created[0]?.title, "worker-one");
      assert.equal(mux.created[1]?.title, "worker-one");
      assert.match(mux.created[0]?.command ?? "", /--session/);
      assert.match(mux.created[1]?.command ?? "", /--session/);
      assert.ok((mux.created[1]?.command ?? "").includes(sessionPath));
      assert.match(mux.created[0]?.command ?? "", /Inspect failing tests/);
      assert.match(mux.created[1]?.command ?? "", /Inspect failing tests/);
      assert.match(mux.created[0]?.command ?? "", /"prompt":"Inspect failing tests"/);
      assert.match(mux.created[1]?.command ?? "", /"prompt":"Inspect failing tests"/);
      assert.match(mux.created[0]?.command ?? "", /"autoExitTimeoutMs":30000/);
      assert.match(mux.created[1]?.command ?? "", /"autoExitTimeoutMs":30000/);
      {
        const command = mux.created[0]?.command ?? "";
        const promptIndex = command.indexOf("Inspect failing tests");
        const modeFlagIndex = command.indexOf("--mode-worker");
        assert.ok(modeFlagIndex === -1 || promptIndex < modeFlagIndex);
      }
      assert.equal(mux.sent[0]?.text, "Focus on src/extensions first");
      assert.equal(mux.sent[0]?.submitMode, "steer");
      assert.equal(mux.sent[1]?.text, "Address review feedback");
      assert.equal(mux.sent[1]?.submitMode, "followUp");
      assert.ok(session.events.uiCallsFor("setWidget").length > 0);

      const renderedText = renderSessionChatLines(session).join("\n");
      assert.match(
        renderedText,
        /π start · worker-one · worker · Inspect failing tests · worker-one · running/,
      );
      assert.match(renderedText, /π list · 1 agent · 1 running/);
      assert.match(
        renderedText,
        /π message · [0-9a-f]{8} · steer · Focus on src\/extensions first/i,
      );
      assert.match(
        renderedText,
        /worker-one · running · steer · Focus on src\/extensions[\s\S]*first/i,
      );
      assert.match(renderedText, /π cancel · [0-9a-f]{8} · worker-one · cancelled/i);
      assert.match(renderedText, /π message · [0-9a-f]{8} · followUp · Address review feedback/i);
      assert.match(
        renderedText,
        /worker-one · running · resumed · followUp · Address[\s\S]*review\s+feedback/i,
      );
    } finally {
      session?.dispose();
    }
  },
);

timedTest("subagent extension launches into a tmux window when the mode requests it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-subagent-window-mode-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();

  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "modes.json"),
    `${JSON.stringify(
      {
        version: 1,
        modes: {
          reviewer: {
            tools: ["read"],
            autoExit: true,
            tmuxTarget: "window",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [createSubagentExtension({ adapterFactory: () => mux })],
    });
    patchHarnessAgent(session);

    await session.run(
      when("Start a delegated reviewer in a new tmux window", [
        calls("subagent", {
          action: "start",
          name: "worker-window",
          mode: "reviewer",
          task: "Inspect failing tests",
        }),
        says("Started."),
      ]),
    );

    assert.equal(mux.created.length, 1);
    assert.equal(mux.created[0]?.target, "window");
    assert.equal(mux.created[0]?.title, "worker-window");
    assert.match(mux.created[0]?.command ?? "", /Inspect failing tests/);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest(
  "subagent extension propagates mode-specific idle timeout into the child bootstrap state",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-subagent-timeout-mode-"));
    let session: TestSession | undefined;
    const mux = new HarnessMuxAdapter();

    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "modes.json"),
      `${JSON.stringify(
        {
          version: 1,
          modes: {
            reviewer: {
              tools: ["read"],
              autoExit: true,
              autoExitTimeoutMs: 45,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    try {
      session = await createTestSession({
        cwd,
        extensionFactories: [createSubagentExtension({ adapterFactory: () => mux })],
      });
      patchHarnessAgent(session);

      await session.run(
        when("Start a delegated reviewer with a custom idle timeout", [
          calls("subagent", {
            action: "start",
            name: "worker-timeout",
            mode: "reviewer",
            task: "Inspect failing tests",
          }),
          says("Started."),
        ]),
      );

      assert.equal(mux.created.length, 1);
      assert.equal(mux.created[0]?.title, "worker-timeout");
      assert.match(mux.created[0]?.command ?? "", /"prompt":"Inspect failing tests"/);
      assert.match(mux.created[0]?.command ?? "", /"autoExitTimeoutMs":45/);
    } finally {
      session?.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest(
  "subagent extension uses shared handoff summarization when handoff is enabled",
  async () => {
    let session: TestSession | undefined;
    const mux = new HarnessMuxAdapter();
    const summaryText =
      "## Context\nShared summary from handoff helper\n\n## Task\nContinue the delegated work";
    const providers = createHandoffTestProviders(summaryText);

    try {
      session = await createTestSession({
        extensionFactories: [
          providers.extensionFactory,
          createSubagentExtension({ adapterFactory: () => mux }),
        ],
      });
      patchHarnessAgent(session);
      setFakeParentSessionPath(session, "/tmp/parent-handoff-session.jsonl");

      await session.run(
        when("We traced the failure to the tmux adapter", [says("Captured baseline context.")]),
        when("Start a delegated worker with a handoff", [
          calls("subagent", {
            action: "start",
            name: "worker-two",
            task: "Continue the delegated work",
            handoff: true,
          }),
          says("Started with handoff."),
        ]),
      );

      assert.equal(mux.created.length, 1);
      assert.match(mux.created[0]?.command ?? "", /Shared summary from handoff helper/);
      assert.match(mux.created[0]?.command ?? "", /Parent session/);
      assert.doesNotMatch(
        mux.created[0]?.command ?? "",
        /--mode-worker .*Shared summary from handoff helper/,
      );
      const toolExecutionEnd = session.events.all.find(
        (event) => event.type === "tool_execution_end" && event.toolName === "subagent",
      ) as { result?: { content?: Array<{ type: string; text?: string }> } } | undefined;
      assert.match(
        toolExecutionEnd?.result?.content?.[0]?.text ?? "",
        /will return with a summary automatically when it finishes/i,
      );
    } finally {
      providers.dispose();
      session?.dispose();
    }
  },
);

timedTest("subagent extension reports standard tool errors for invalid operations", async () => {
  let session: TestSession | undefined;

  try {
    session = await createTestSession({
      extensionFactories: [
        createSubagentExtension({ adapterFactory: () => new HarnessMuxAdapter() }),
      ],
    });
    patchHarnessAgent(session);

    await session.run(
      when("Message a missing delegated worker", [
        calls("subagent", {
          action: "message",
          sessionId: "missing-session",
          message: "hello",
        }),
        says("Handled."),
      ]),
    );

    const toolExecutionEnd = session.events.all.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "subagent",
    );
    assert.ok(toolExecutionEnd);
    assert.equal(toolExecutionEnd.isError, true);
    const errorText =
      toolExecutionEnd.result?.content
        ?.filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n") ?? "";
    assert.match(
      errorText,
      /subagent message failed: sessionId missing-session was not found in this parent session/,
    );
  } finally {
    session?.dispose();
  }
});

timedTest("subagent extension reports actionable invalid param errors", async () => {
  let session: TestSession | undefined;

  try {
    session = await createTestSession({
      extensionFactories: [
        createSubagentExtension({ adapterFactory: () => new HarnessMuxAdapter() }),
      ],
    });
    patchHarnessAgent(session);

    await session.run(
      when("Start a delegated worker without a task", [
        calls("subagent", {
          action: "start",
          name: "worker-one",
        }),
        says("Handled."),
      ]),
    );

    const toolExecutionEnd = session.events.all.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "subagent",
    );
    assert.ok(toolExecutionEnd);
    assert.equal(toolExecutionEnd.isError, true);
    const errorText =
      toolExecutionEnd.result?.content
        ?.filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n") ?? "";
    assert.match(errorText, /Invalid subagent start params: `task` is required/);
    assert.match(errorText, /There is no subagent read action later/i);
  } finally {
    session?.dispose();
  }
});

timedTest("mermaid command still emits a standalone preview message", async () => {
  let session: TestSession | undefined;

  try {
    session = await createTestSession({
      extensionFactories: [mermaidExtension],
    });
    patchHarnessAgent(session);

    const playbook = createPlaybookStreamFn([
      when("Render the system flow", [
        says(
          [
            "```mermaid",
            "sequenceDiagram",
            "  Alice->>Bob: ping",
            "  Bob-->>Alice: pong",
            "```",
          ].join("\n"),
        ),
      ]),
    ]);

    (session.session.agent as { streamFn: unknown }).streamFn = playbook.streamFn;

    await session.session.prompt("Render the system flow");
    await session.session.agent.waitForIdle();

    await session.session.prompt("/mermaid");
    await session.session.agent.waitForIdle();

    const branchEntries = (
      session.session as {
        sessionManager: {
          getBranch: () => Array<{
            type: string;
            customType?: string;
            details?: { source?: string };
          }>;
        };
      }
    ).sessionManager.getBranch();

    const customMermaidMessages = branchEntries.filter(
      (entry) => entry.type === "custom_message" && entry.customType === "pi-mermaid",
    );

    assert.equal(customMermaidMessages.length, 1);
    assert.match(customMermaidMessages[0]?.details?.source ?? "", /sequenceDiagram/);
  } finally {
    session?.dispose();
  }
});

timedTest(
  "mermaid fence parser ignores nested mermaid fences inside other code blocks and labels",
  () => {
    const content = [
      "Here’s the difference, using Mermaid itself.",
      "",
      "**Old additive approach**",
      "```mermaid",
      "flowchart LR",
      "  A[Assistant message contains ```mermaid``` fence] --> B[Extension parses it]",
      "  B --> C[Extension sends a separate custom message]",
      "  A --> D[Raw fence still stays visible]",
      "  C --> E[ASCII diagram appears again]",
      "```",
      "",
      "**New inline patching approach**",
      "```mermaid",
      "flowchart LR",
      "  A[AssistantMessageComponent.updateContent] --> B[Detect mermaid fence]",
      "  B --> C[Replace fence with inline ASCII component]",
      "  C --> D[Single message renders cleanly]",
      "  D --> E[No duplicate custom message]",
      "```",
      "",
      "**Example assistant content**",
      "```text",
      "Release flow:",
      "",
      "```mermaid",
      "graph TD",
      "  Start --> Validate",
      "  Validate --> Build",
      "  Build --> Ship",
      "```",
      "",
      "Done.",
      "```",
      "",
      "**Why this feels better**",
      "```mermaid",
      "sequenceDiagram",
      "  participant U as User",
      "  participant A as Assistant message",
      "  participant R as Renderer",
      "",
      "  U->>A: Sends text with mermaid block",
      "  R->>A: Patches content in place",
      "  A-->>U: One coherent message with diagram inline",
      "```",
    ].join("\n");

    const blocks = extractMermaidBlocks(content);

    assert.equal(blocks.length, 3);
    assert.match(blocks[0] ?? "", /flowchart LR/);
    assert.match(blocks[0] ?? "", /contains ```mermaid``` fence/);
    assert.match(blocks[1] ?? "", /flowchart LR/);
    assert.match(blocks[2] ?? "", /sequenceDiagram/);
    assert.ok(blocks.every((block) => !block.includes("Start --> Validate")));
  },
);

timedTest("prompt stash persistence round-trips clean JSONL entries", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-prompt-stash-happy-"));
  const agentDir = await mkdtemp(join(tmpdir(), "agent-prompt-stash-agent-"));
  const entries = [
    createPromptStashEntry("entry-1", "First draft", 1_000),
    createPromptStashEntry("entry-2", "Second draft\nWith two lines", 2_000),
  ];

  try {
    await withTempAgentDir(agentDir, async () => {
      await saveStashEntries(cwd, entries);

      assert.equal(
        await readFile(getStashFilePath(), "utf8"),
        entries.map((entry) => JSON.stringify(entry)).join("\n"),
      );

      assert.deepEqual(await loadStashEntries(cwd), entries);
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

timedTest("prompt stash load self-heals malformed JSONL lines", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-prompt-stash-heal-"));
  const agentDir = await mkdtemp(join(tmpdir(), "agent-prompt-stash-agent-"));
  const entries = [
    createPromptStashEntry("entry-1", "Keep me", 1_000),
    createPromptStashEntry("entry-2", "Keep me too", 2_000),
  ];

  try {
    await withTempAgentDir(agentDir, async () => {
      await writeFile(
        getStashFilePath(),
        [
          JSON.stringify(entries[0]),
          "{not json}",
          "   ",
          JSON.stringify({ ...entries[1], extra: true }),
          `${JSON.stringify(entries[1])}  `,
          "",
        ].join("\n"),
        "utf8",
      );

      assert.deepEqual(await loadStashEntries(cwd), [entries[0], entries[1]]);
      assert.equal(
        await readFile(getStashFilePath(), "utf8"),
        [JSON.stringify(entries[0]), JSON.stringify(entries[1])].join("\n"),
      );
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

timedTest("prompt stash normalizes oversized JSONL files on load", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-prompt-stash-load-cap-"));
  const agentDir = await mkdtemp(join(tmpdir(), "agent-prompt-stash-agent-"));
  const entries = Array.from({ length: 52 }, (_, index) =>
    createPromptStashEntry(`entry-${index + 1}`, `Prompt ${index + 1}`, index + 1),
  );

  try {
    await withTempAgentDir(agentDir, async () => {
      await writeFile(
        getStashFilePath(),
        entries.map((entry) => JSON.stringify(entry)).join("\n"),
        "utf8",
      );

      const loaded = await loadStashEntries(cwd);
      assert.equal(loaded.length, 50);
      assert.deepEqual(
        loaded.map((entry) => entry.id),
        entries.slice(0, 50).map((entry) => entry.id),
      );
      assert.equal(
        await readFile(getStashFilePath(), "utf8"),
        entries
          .slice(0, 50)
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      );
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

timedTest("prompt stash caps persisted entries at fifty", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-prompt-stash-cap-"));
  const agentDir = await mkdtemp(join(tmpdir(), "agent-prompt-stash-agent-"));
  const entries = Array.from({ length: 51 }, (_, index) =>
    createPromptStashEntry(`entry-${index + 1}`, `Prompt ${index + 1}`, index + 1),
  );

  try {
    await withTempAgentDir(agentDir, async () => {
      await saveStashEntries(cwd, entries);

      const loaded = await loadStashEntries(cwd);
      assert.equal(loaded.length, 50);
      assert.deepEqual(
        loaded.map((entry) => entry.id),
        entries.slice(0, 50).map((entry) => entry.id),
      );
      assert.equal((await readFile(getStashFilePath(), "utf8")).split("\n").length, 50);
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

timedTest("prompt stash registers the stash command when loaded", async () => {
  let session: TestSession | undefined;

  try {
    session = await createTestSession({
      extensionFactories: [promptStashExtension],
    });

    const registeredCommands = (
      session.session as {
        extensionRunner: {
          getRegisteredCommands: () => Array<{ invocationName: string; description?: string }>;
        };
      }
    ).extensionRunner.getRegisteredCommands();

    const stashCommand = registeredCommands.find((command) => command.invocationName === "stash");
    assert.ok(stashCommand);
    assert.equal(stashCommand?.description, "Manage stashed prompts");
  } finally {
    session?.dispose();
  }
});

timedTest("prompt stash registers a non-conflicting shortcut", async () => {
  let session: TestSession | undefined;

  try {
    session = await createTestSession({
      extensionFactories: [modesExtension, promptStashExtension],
    });

    const shortcuts = (
      session.session as {
        extensionRunner: {
          getShortcuts: (
            resolvedKeybindings: unknown,
          ) => Map<string, { description?: string; extensionPath: string }>;
        };
      }
    ).extensionRunner.getShortcuts(KeybindingsManager.create().getEffectiveConfig());

    assert.equal(shortcuts.get("ctrl+alt+s")?.description, "Stash current prompt");
    assert.equal(shortcuts.get("ctrl+alt+p")?.description, "Select prompt mode");
    assert.equal(shortcuts.get("ctrl+alt+m")?.description, "Cycle prompt mode");
  } finally {
    session?.dispose();
  }
});

timedTest("files extension registers alt-based shortcuts", async () => {
  let session: TestSession | undefined;

  try {
    session = await createTestSession({
      extensionFactories: [filesExtension],
    });

    const shortcuts = (
      session.session as {
        extensionRunner: {
          getShortcuts: (
            resolvedKeybindings: unknown,
          ) => Map<string, { description?: string; extensionPath: string }>;
        };
      }
    ).extensionRunner.getShortcuts(KeybindingsManager.create().getEffectiveConfig());

    assert.equal(shortcuts.get("ctrl+alt+o")?.description, "Browse files mentioned in the session");
    assert.equal(
      shortcuts.get("ctrl+alt+f")?.description,
      "Reveal the latest file reference in Finder",
    );
    assert.equal(shortcuts.get("ctrl+alt+r")?.description, "Quick Look the latest file reference");
  } finally {
    session?.dispose();
  }
});

timedTest("/stash pop applies the latest entry and removes it from disk", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-prompt-stash-pop-"));
  const agentDir = await mkdtemp(join(tmpdir(), "agent-prompt-stash-agent-"));
  const entries = [
    createPromptStashEntry("entry-1", "Latest draft\nSecond line", 2_000),
    createPromptStashEntry("entry-2", "Older draft", 1_000),
  ];
  let session: TestSession | undefined;

  try {
    await withTempAgentDir(agentDir, async () => {
      await saveStashEntries(cwd, entries);

      session = await createTestSession({
        cwd,
        extensionFactories: [promptStashExtension],
      });
      patchHarnessAgent(session);

      await session.session.prompt("/stash pop");
      await session.session.agent.waitForIdle();

      assert.equal(session.events.uiCallsFor("setEditorText").at(-1)?.args[0], entries[0]?.text);
      assert.equal(
        session.events.uiCallsFor("notify").at(-1)?.args[0],
        "Applied latest stash entry (2 lines)",
      );
      const latestPromptStashState = (
        session.session as {
          sessionManager: {
            getEntries: () => Array<{ type: string; customType?: string; data?: unknown }>;
          };
        }
      ).sessionManager
        .getEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === "prompt-stash-state")
        .at(-1);
      assert.ok(latestPromptStashState);
      assert.deepEqual(await loadStashEntries(cwd), [entries[1]]);
    });
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});
