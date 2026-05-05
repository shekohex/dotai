import { expect, test } from "vitest";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
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
const GITHUB_ACTIONS_TEST_TIMEOUT_MS = 30_000;

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(
    name,
    {
      timeout:
        process.env.GITHUB_ACTIONS === "true" ? GITHUB_ACTIONS_TEST_TIMEOUT_MS : TEST_TIMEOUT_MS,
    },
    fn,
  )) as typeof test;

async function waitForAssertion(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw lastError;
}

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
  expect(address && typeof address !== "string").toBeTruthy();

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

function readLaunchFileBackedValue(command: string, envName: string): string {
  const escapedName = envName.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = command.match(new RegExp(`${escapedName}='([^']+)'`));
  return match?.[1] ? readFileSync(match[1], "utf8") : "";
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
  registrations[2].setResponses(
    Array.from({ length: 8 }, () => fauxAssistantMessage("mode-provider response")),
  );
  registrations[3].setResponses(
    Array.from({ length: 8 }, () => fauxAssistantMessage("override-provider response")),
  );
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
      expect(model, `Missing model ${id}`).toBeTruthy();
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
      expect(model, `Missing model ${id}`).toBeTruthy();
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

function countModeStateEntries(testSession: TestSession): number {
  const entries = (
    testSession.session as {
      sessionManager: {
        getEntries: () => Array<{
          type: string;
          customType?: string;
        }>;
      };
    }
  ).sessionManager.getEntries();

  return entries.filter((entry) => entry.type === "custom" && entry.customType === "mode-state")
    .length;
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

function setSessionPersistence(testSession: TestSession, persisted: boolean): void {
  const sessionManager = (
    testSession.session as { sessionManager: { isPersisted?: () => boolean } }
  ).sessionManager as {
    isPersisted?: () => boolean;
  };
  sessionManager.isPersisted = () => persisted;
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
  expect(command?.getArgumentCompletions).toBeTruthy();
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

    expect(await readFile(filePath, "utf8")).toBe("export const value = 2;\n");
    expect(session.events.toolCallsFor("apply_patch").length).toBe(1);
    const toolExecutionEnd = session.events.all.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "apply_patch",
    );
    expect(toolExecutionEnd).toBeTruthy();
    expect(toolExecutionEnd.isError).toBe(false);
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

    expect(session.events.toolSequence()).toEqual(["bash"]);
    expect(session.events.toolResultsFor("bash")[0]?.mocked).toBe(true);
    expect(session.events.toolResultsFor("bash")[0]?.text ?? "").toMatch(
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

    expect(req.headers.authorization).toBe("Bearer fc-free");
    expect(body.url).toBe("https://example.com/harness");
    expect(body.formats).toEqual(["markdown"]);

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
  expect(address && typeof address === "object").toBeTruthy();
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
    expect(toolExecutionEnd).toBeTruthy();
    expect(toolExecutionEnd.isError).toBe(false);

    const toolResult = session.events.toolResultsFor("webfetch")[0]?.text ?? "";
    expect(toolResult).toMatch(/URL: https:\/\/example\.com\/harness/);
    expect(toolResult).toMatch(/Status: 200 OK/);
    expect(toolResult).toMatch(/# Fetch harness/);
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
      expect(getHeader("x-goog-api-key").length > 0).toBeTruthy();
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
            expect(provider).toBe("gemini");
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

    expect(updates.length > 1).toBeTruthy();

    const toolResult = result.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    expect(toolResult).toMatch(/Next\.js 16 released in October 2025\./);
    expect(toolResult).toMatch(/Sources:/);
    expect(toolResult).toMatch(/https:\/\/nextjs\.org\/blog\/next-16/);
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
      expect(getHeader("x-goog-api-key")).toBe("litellm-test-key");
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
    expect(
      bundledThemes.some((loadedTheme) => loadedTheme.name === "catppuccin-mocha"),
    ).toBeTruthy();

    setRegisteredThemes(bundledThemes);
    initTheme("catppuccin-mocha");

    expect(activeTheme.name).toBe("catppuccin-mocha");
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
    setSessionPersistence(session, true);

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
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(session.playbook.consumed).toBe(consumedBeforeCommand);
    expect(session.events.uiCallsFor("editor").length).toBe(0);
    expect(session.events.uiCallsFor("setEditorText").length).toBe(0);

    const model = session.session as {
      model: { provider: string; id: string };
      thinkingLevel: string;
    };
    expect(model.model.provider).toBe("mode-provider");
    expect(model.model.id).toBe("mode-model");
    expect(model.thinkingLevel).toBe("high");
    expect(getLatestModeState(session)).toBe("docs");
    expect(loader.calls.count).toBe(1);

    const userMessages = getBranchTextMessages(session).filter((entry) => entry.role === "user");
    expect(
      userMessages.some((entry) =>
        entry.text.includes("Parent session: /tmp/parent-session.jsonl"),
      ),
    ).toBe(true);

    const restoreEvents = observedModeChanges.filter((event) => event.reason === "restore");
    expect(restoreEvents.length).toBe(1, JSON.stringify(observedModeChanges));
    expect(restoreEvents[0]?.mode).toBe("docs");
    expect(restoreEvents[0]?.source).toBe("session_start");
    expect(restoreEvents[0]?.spec?.provider).toBe("mode-provider");
    expect(restoreEvents[0]?.spec?.modelId).toBe("mode-model");
    expect(restoreEvents[0]?.spec?.thinkingLevel).toBe("high");
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
    setSessionPersistence(session, true);

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
    await new Promise((resolve) => setTimeout(resolve, 5));

    const model = session.session as {
      model: { provider: string; id: string };
      thinkingLevel: string;
    };
    expect(model.model.provider).toBe("override-provider");
    expect(model.model.id).toBe("override-model");
    expect(model.thinkingLevel).toBe("high");
    expect(getLatestModeState(session)).toBe(undefined);
    expect(loader.calls.count).toBe(1);

    expect(observedModeChanges.length).toBe(1, JSON.stringify(observedModeChanges));
    expect(observedModeChanges[0]?.mode).toBe(undefined);
    expect(observedModeChanges[0]?.reason).toBe("restore");
    expect(observedModeChanges[0]?.source).toBe("session_start");
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
    expect(flagCompletions?.map((item) => item.label)).toEqual(["-mode", "-model"]);

    const modeCompletions = await getCommandArgumentCompletions(session, "handoff", "-mode ");
    expect(modeCompletions?.some((item) => item.label === "docs")).toBeTruthy();
    expect(modeCompletions?.some((item) => item.label === "smart")).toBeTruthy();
    expect(modeCompletions?.find((item) => item.label === "docs")?.description ?? "").toMatch(
      /mode-provider\/mode-model/,
    );
    expect(modeCompletions?.find((item) => item.label === "docs")?.description ?? "").toMatch(
      /thinking:high/,
    );

    const remainingFlagCompletions = await getCommandArgumentCompletions(
      session,
      "handoff",
      "-mode docs -",
    );
    expect(remainingFlagCompletions?.map((item) => item.label)).toEqual(["-model"]);

    const modelCompletions = await getCommandArgumentCompletions(
      session,
      "handoff",
      "-model override",
    );
    expect(modelCompletions?.[0]?.value).toBe("-model override-provider/override-model");
    expect(modelCompletions?.[0]?.label).toBe("override-model");
    expect(modelCompletions?.[0]?.description).toBe("override-provider");
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
    expect(rootCompletions?.map((item) => item.label)).toEqual(["status", "web"]);

    const fuzzyCompletions = await getCommandArgumentCompletions(session, "executor", "w");
    expect(fuzzyCompletions?.[0]?.label).toBe("web");
    expect(fuzzyCompletions?.some((item) => item.label === "status")).toBeTruthy();
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
    expect(uiContext).toBeTruthy();

    const customCalls: Array<{ args: unknown[] }> = [];
    const originalCustom = uiContext.custom?.bind(uiContext) ?? (async () => {});
    uiContext.custom = async (...args: unknown[]) => {
      customCalls.push({ args });
      return originalCustom(...(args as never));
    };

    await session.session.prompt("/executor");
    await session.session.agent.waitForIdle();

    expect(customCalls.length).toBe(1);
    expect(typeof customCalls[0]?.args[0]).toBe("function");
    expect(customCalls[0]?.args[1]).toBe(undefined);

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

    expect(executorMessages.length).toBe(0);
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
      setSessionPersistence(session, true);

      const initialPrompt = getCurrentSystemPrompt(session);
      expect(initialPrompt).toMatch(/<available_modes>/);
      expect(initialPrompt).toMatch(
        /<mode name="docs" model="mode-provider\/mode-model" thinkingLevel="high" description="Fast technical writing" \/>/,
      );
      expect(initialPrompt).toMatch(
        /<mode name="smart" model="mode-provider\/smart-model" thinkingLevel="low" \/>/,
      );

      await session.session.prompt("/mode store deep");
      await session.session.agent.waitForIdle();

      await waitForAssertion(() => {
        expect(getCurrentSystemPrompt(session)).toMatch(/<mode name="deep"/);
      });
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

      expect(flags.includes("mode-deep-work")).toBeTruthy();
      expect(flags.includes("mode-mini-max")).toBeTruthy();
      expect(flags.includes("mode-docs-fast")).toBeTruthy();
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
      setSessionPersistence(session!, true);

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
      expect(model.model.provider).toBe("mode-provider");
      expect(model.model.id).toBe("mode-model");
      expect(model.thinkingLevel).toBe("high");
      expect(getLatestModeState(session!)).toBe(undefined);

      expect(observedModeChanges.length > 0, JSON.stringify(observedModeChanges)).toBeTruthy();
      const latestModeChange = observedModeChanges.at(-1);
      expect(latestModeChange?.mode).toBe("docs");
      expect(latestModeChange?.reason).toBe("restore");
      expect(latestModeChange?.source).toBe("session_start");
      expect(latestModeChange?.spec?.provider).toBe("mode-provider");
      expect(latestModeChange?.spec?.modelId).toBe("mode-model");
      expect(latestModeChange?.spec?.thinkingLevel).toBe("high");
    });
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("mode reload startup does not append mode-state entry when nothing changed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-mode-reload-state-"));
  let session: TestSession | undefined;
  const providers = createHandoffTestProviders("## Context\nCaptured.\n\n## Task\nContinue.");

  await writeHandoffModesFile(cwd);

  try {
    await withProcessCwd(cwd, async () => {
      session = await createTestSession({
        cwd,
        extensionFactories: [modesExtension, providers.extensionFactory],
      });
      setSessionPersistence(session!, true);

      (
        session!.session as {
          extensionRunner: { setFlagValue: (name: string, value: boolean | string) => void };
        }
      ).extensionRunner.setFlagValue("mode-docs", true);

      await session!.session.reload();

      const firstCount = countModeStateEntries(session!);
      const firstModel = session!.session as {
        model: { provider: string; id: string };
        thinkingLevel: string;
      };
      expect(firstCount).toBe(0);
      expect(getLatestModeState(session!)).toBe(undefined);
      expect(firstModel.model.provider).toBe("mode-provider");
      expect(firstModel.model.id).toBe("mode-model");
      expect(firstModel.thinkingLevel).toBe("high");

      await session!.session.reload();

      const secondModel = session!.session as {
        model: { provider: string; id: string };
        thinkingLevel: string;
      };
      expect(countModeStateEntries(session!)).toBe(firstCount);
      expect(getLatestModeState(session!)).toBe(undefined);
      expect(secondModel.model.provider).toBe("mode-provider");
      expect(secondModel.model.id).toBe("mode-model");
      expect(secondModel.thinkingLevel).toBe("high");
    });
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("mode state dedupe is scoped to current branch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-mode-branch-dedupe-"));
  let session: TestSession | undefined;
  const providers = createHandoffTestProviders("## Context\nCaptured.\n\n## Task\nContinue.");

  await writeHandoffModesFile(cwd);

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [modesExtension, providers.extensionFactory],
    });
    patchHarnessAgent(session);
    setSessionPersistence(session, true);

    await session.session.prompt("seed branch root");
    await session.session.agent.waitForIdle();

    await session.session.prompt("/mode docs");
    await session.session.agent.waitForIdle();

    expect(countModeStateEntries(session)).toBe(1);

    const branchPointEntryId = (
      session.session as {
        sessionManager: {
          getEntries: () => Array<{ id: string; type: string; message?: { role: string } }>;
          branch: (entryId: string) => void;
        };
      }
    ).sessionManager
      .getEntries()
      .find((entry) => entry.type === "message" && entry.message?.role === "user")?.id;

    expect(branchPointEntryId).toBeTruthy();

    (
      session.session as {
        sessionManager: {
          branch: (entryId: string) => void;
        };
      }
    ).sessionManager.branch(branchPointEntryId!);

    await session.session.prompt("/mode docs");
    await session.session.agent.waitForIdle();

    expect(countModeStateEntries(session)).toBe(2);
    expect(getLatestModeState(session)).toBe("docs");
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
    const agentDir = await mkdtemp(join(tmpdir(), "agent-mode-flags-shared-selection-agent-"));
    let session: TestSession | undefined;
    const observedModeChanges: CapturedModeChange[] = [];
    const providers = createHandoffTestProviders("## Context\nCaptured.\n\n## Task\nContinue.");

    await writeSharedSelectionModesFile(cwd);

    try {
      await withTempAgentDir(agentDir, async () => {
        await withProcessCwd(cwd, async () => {
          session = await createTestSession({
            cwd,
            extensionFactories: [
              modesExtension,
              createModeChangeCaptureExtension(observedModeChanges),
              providers.extensionFactory,
            ],
          });
          setSessionPersistence(session!, true);

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
          expect(model.model.provider).toBe("mode-provider");
          expect(model.model.id).toBe("mode-model");
          expect(model.thinkingLevel).toBe("high");
          expect(getLatestModeState(session!)).toBe(undefined);

          observedModeChanges.length = 0;

          await session!.session.prompt("hello");
          await session!.session.agent.waitForIdle();
          await new Promise((resolve) => setTimeout(resolve, 5));

          expect(getLatestModeState(session!)).toBe("review");
          expect(observedModeChanges.length).toBe(0, JSON.stringify(observedModeChanges));
        });
      });
    } finally {
      session?.dispose();
      providers.dispose();
      await rm(agentDir, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest("modes extension skips persistence for ephemeral sessions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-mode-ephemeral-"));
  let session: TestSession | undefined;
  const providers = createHandoffTestProviders("## Context\nCaptured.\n\n## Task\nContinue.");

  await writeHandoffModesFile(cwd);

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [modesExtension, providers.extensionFactory],
    });
    setSessionPersistence(session, false);

    const modesPath = join(cwd, ".pi", "modes.json");
    const before = await readFile(modesPath, "utf8");

    await session.session.prompt("/mode docs");
    await session.session.agent.waitForIdle();

    expect(countModeStateEntries(session)).toBe(0);
    expect(getLatestModeState(session)).toBe(undefined);
    expect(await readFile(modesPath, "utf8")).toBe(before);
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest(
  "mode CLI flags keep explicit startup mode after other loaders register different flags",
  async () => {
    const sessionCwd = await mkdtemp(join(tmpdir(), "agent-mode-flags-shared-selection-local-"));
    const loaderCwd = await mkdtemp(join(tmpdir(), "agent-mode-flags-overwrite-loader-"));
    let session: TestSession | undefined;
    const observedModeChanges: CapturedModeChange[] = [];
    const providers = createHandoffTestProviders("## Context\nCaptured.\n\n## Task\nContinue.");

    await writeSharedSelectionModesFile(sessionCwd);
    await writeHandoffModesFile(loaderCwd);

    try {
      await withProcessCwd(sessionCwd, async () => {
        session = await createTestSession({
          cwd: sessionCwd,
          extensionFactories: [
            modesExtension,
            createModeChangeCaptureExtension(observedModeChanges),
            providers.extensionFactory,
          ],
        });
        setSessionPersistence(session!, true);

        (
          session!.session as {
            extensionRunner: { setFlagValue: (name: string, value: boolean | string) => void };
          }
        ).extensionRunner.setFlagValue("mode-review", true);

        await withProcessCwd(loaderCwd, async () => {
          const loader = new DefaultResourceLoader({
            cwd: loaderCwd,
            agentDir: loaderCwd,
            extensionFactories: [modesExtension, providers.extensionFactory],
          });
          await loader.reload();
        });

        await session!.session.reload();

        const model = session!.session as {
          model: { provider: string; id: string };
          thinkingLevel: string;
        };
        expect(model.model.provider).toBe("mode-provider");
        expect(model.model.id).toBe("mode-model");
        expect(model.thinkingLevel).toBe("high");
        expect(getLatestModeState(session!)).toBe(undefined);

        observedModeChanges.length = 0;

        await session!.session.prompt("hello");
        await session!.session.agent.waitForIdle();
        await new Promise((resolve) => setTimeout(resolve, 5));

        expect(getLatestModeState(session!)).toBe("review");
        expect(observedModeChanges.length).toBe(0, JSON.stringify(observedModeChanges));
      });
    } finally {
      session?.dispose();
      providers.dispose();
      await rm(sessionCwd, { recursive: true, force: true });
      await rm(loaderCwd, { recursive: true, force: true });
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

  expect(geminiRegistration).toBeTruthy();
  expect(geminiRegistration.provider).toBe("gemini");
  expect(geminiRegistration.config.baseUrl).toBe("https://litellm.example.test/v1beta");
  expect(geminiRegistration.config.apiKey).toBe("TEST_KEY");
  expect(Array.isArray(geminiRegistration.config.models)).toBeTruthy();
  expect(
    geminiRegistration.config.models!.some((model) => model.id === "gemini-2.5-flash"),
  ).toBeTruthy();
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
      expect(initialPrompt).toBe(buildModelFamilySystemPrompt(initialPrompt, "gpt-5.4"));
      const initialTail = extractPiDynamicTail(initialPrompt);

      await session.session.setModel(providers.getModel("gpt-5.4-mini") as never);
      expect(getCurrentSystemPrompt(session)).toBe(initialPrompt);

      await session.session.setModel(providers.getModel("gpt-5.4-codex") as never);
      const codexSystemPrompt = getCurrentSystemPrompt(session);
      expect(codexSystemPrompt).toBe(buildModelFamilySystemPrompt(initialPrompt, "gpt-5.4-codex"));
      expect(extractPiDynamicTail(codexSystemPrompt)).toBe(initialTail);

      await session.session.setModel(providers.getModel("gemini-2.5-pro") as never);
      const geminiSystemPrompt = getCurrentSystemPrompt(session);
      expect(geminiSystemPrompt).toBe(
        buildModelFamilySystemPrompt(initialPrompt, "gemini-2.5-pro"),
      );
      expect(extractPiDynamicTail(geminiSystemPrompt)).toBe(initialTail);

      await session.session.setModel(providers.getModel("kimi-k2.5") as never);
      const kimiSystemPrompt = getCurrentSystemPrompt(session);
      expect(kimiSystemPrompt).toBe(buildModelFamilySystemPrompt(initialPrompt, "kimi-k2.5"));

      await session.session.setModel(providers.getModel("router-1") as never);
      const defaultSystemPrompt = getCurrentSystemPrompt(session);
      expect(defaultSystemPrompt).toBe(buildModelFamilySystemPrompt(initialPrompt, "router-1"));
      expect(extractPiDynamicTail(defaultSystemPrompt)).toBe(initialTail);
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

      expect(seenSystemPrompts[0]).toBe(
        buildModelFamilySystemPrompt(seenSystemPrompts[0]!, "gpt-5.4"),
      );
      expect(seenSystemPrompts[1]).toBe(
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
      expect(currentPrompt).toBe(buildModelFamilySystemPrompt(gptPrompt, "gemini-2.5-pro"));
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

      expect(capturedToolSets.at(-1)).toEqual(["bash", "read"]);

      await session.session.prompt("/mode review");
      await session.session.agent.waitForIdle();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(capturedToolSets.at(-1)).toEqual(["read"]);

      await session.session.setModel(providers.getModel("smart-model") as never);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const restoredToolNames = capturedToolSets.at(-1) ?? [];
      expect(restoredToolNames.includes("bash")).toBeTruthy();
      expect(restoredToolNames.includes("read")).toBeTruthy();
      expect(restoredToolNames.includes("edit")).toBeTruthy();
      expect(restoredToolNames.includes("write")).toBeTruthy();
      expect(!restoredToolNames.includes("apply_patch")).toBeTruthy();
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
      expect(customMermaidMessages.length).toBe(0);

      const renderedText = renderSessionChatLines(session).join("\n");
      expect(renderedText).toMatch(/Release flow:/);
      expect(renderedText).toMatch(/Done\./);
      expect(renderedText).toMatch(/Start/);
      expect(renderedText).toMatch(/Validate/);
      expect(renderedText).not.toMatch(/```mermaid/);
      expect(renderedText).not.toMatch(/graph TD/);
      expect(renderedText).not.toMatch(/parser validation isn.?t usable/i);
      expect(renderedText).not.toMatch(/more lines, to expand/i);
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

        expect(readResults.length).toBe(2);
        expect(readResults[0] ?? "").toMatch(/export const Button = \(\) => null;/);
        expect(readResults[0] ?? "").toMatch(
          /Loaded subdirectory context from .*src\/AGENTS\.override\.md/,
        );
        expect(readResults[0] ?? "").toMatch(/override src rule/);
        expect(readResults[0] ?? "").toMatch(/second override line/);
        expect(readResults[0] ?? "").toMatch(
          /Loaded subdirectory context from .*src\/components\/AGENTS\.md/,
        );
        expect(readResults[0] ?? "").toMatch(/component rule/);
        expect(readResults[0] ?? "").not.toMatch(/plain src rule/);
        expect(readResults[0] ?? "").not.toMatch(/root rule/);

        expect(readResults[1] ?? "").toMatch(/export const Button = \(\) => null;/);
        expect(readResults[1] ?? "").not.toMatch(/Loaded subdirectory context from/);
        expect(readResults[1] ?? "").not.toMatch(/override src rule/);
        expect(readResults[1] ?? "").not.toMatch(/component rule/);

        const notifications = session.events.uiCallsFor("notify").map((call) => call.args[0]);
        expect(notifications).toEqual([
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

    expect(executorSkillPath).toBeTruthy();

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

    expect(readResult).toMatch(/name: executor/);
    expect(readResult).not.toMatch(/Loaded subdirectory context from/);

    const notifications = session.events.uiCallsFor("notify").map((call) => call.args[0]);
    expect(notifications).toEqual([]);
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

    expect(readResults.length).toBe(2);
    expect(readResults[0] ?? "").toMatch(/export const util = 1;/);
    expect(readResults[0] ?? "").toMatch(/Loaded subdirectory context from .*shared\/AGENTS\.md/);
    expect(readResults[0] ?? "").toMatch(/shared rule/);
    expect(readResults[0] ?? "").not.toMatch(/repo root rule/);

    expect(readResults[1] ?? "").toMatch(/outside file/);
    expect(readResults[1] ?? "").not.toMatch(/Loaded subdirectory context from/);
    expect(readResults[1] ?? "").not.toMatch(/external rule/);

    const notifications = session.events.uiCallsFor("notify").map((call) => call.args[0]);
    expect(notifications.length).toBe(1);
    expect(notifications[0] ?? "").toMatch(/shared\/AGENTS\.md/);
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
      setSessionPersistence(session, true);

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

      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(executionEnds.length).toBe(5);
      expect(executionEnds.every((event) => event.isError === false)).toBeTruthy();
      expect(executionEnds[0]?.result?.content?.[0]?.text ?? "").toMatch(
        /The subagent will return with a summary automatically when it finishes/i,
      );
      expect(executionEnds[1]?.result?.content?.[0]?.text ?? "").toMatch(/count: 1/);
      expect(executionEnds[1]?.result?.content?.[0]?.text ?? "").toMatch(
        new RegExp(`sessionId: ${sessionId}`),
      );
      expect(executionEnds[2]?.result?.content?.[0]?.text ?? "").toMatch(
        new RegExp(`sessionId: ${sessionId}`),
      );
      expect(executionEnds[2]?.result?.content?.[0]?.text ?? "").toMatch(/delivery: steer/);
      expect(executionEnds[3]?.result?.content?.[0]?.text ?? "").toMatch(
        new RegExp(`sessionId: ${sessionId}`),
      );
      expect(executionEnds[3]?.result?.content?.[0]?.text ?? "").toMatch(/cancelled/i);
      expect(executionEnds[4]?.result?.content?.[0]?.text ?? "").toMatch(
        new RegExp(`sessionId: ${sessionId}`),
      );
      expect(executionEnds[4]?.result?.content?.[0]?.text ?? "").toMatch(
        /Previous task resumed and followUp message delivered/i,
      );

      expect(mux.created.length).toBe(2);
      expect(mux.sent.length).toBe(2);
      expect(mux.killed.length).toBe(1);
      expect(mux.created[0]?.title).toBe("worker-one");
      expect(mux.created[1]?.title).toBe("worker-one");
      expect(mux.created[0]?.command ?? "").toMatch(/--session/);
      expect(mux.created[1]?.command ?? "").toMatch(/--session/);
      expect((mux.created[1]?.command ?? "").includes(sessionPath)).toBeTruthy();
      expect(
        readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
      ).toBe("Inspect failing tests");
      expect(
        readLaunchFileBackedValue(mux.created[1]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
      ).toBe("Inspect failing tests");
      expect(
        readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_CHILD_STATE_FILE"),
      ).toMatch(/"prompt":"Inspect failing tests"/);
      expect(
        readLaunchFileBackedValue(mux.created[1]?.command ?? "", "PI_SUBAGENT_CHILD_STATE_FILE"),
      ).toMatch(/"prompt":"Inspect failing tests"/);
      expect(
        readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_CHILD_STATE_FILE"),
      ).toMatch(/"autoExitTimeoutMs":30000/);
      expect(
        readLaunchFileBackedValue(mux.created[1]?.command ?? "", "PI_SUBAGENT_CHILD_STATE_FILE"),
      ).toMatch(/"autoExitTimeoutMs":30000/);
      {
        const promptValue = readLaunchFileBackedValue(
          mux.created[0]?.command ?? "",
          "PI_SUBAGENT_TASK_FILE",
        );
        const promptIndex = promptValue.indexOf("Inspect failing tests");
        const command = mux.created[0]?.command ?? "";
        const modeFlagIndex = command.indexOf("--mode-worker");
        expect(modeFlagIndex === -1 || promptIndex < modeFlagIndex).toBeTruthy();
      }
      expect(mux.sent[0]?.text).toBe("Focus on src/extensions first");
      expect(mux.sent[0]?.submitMode).toBe("steer");
      expect(mux.sent[1]?.text).toBe("Address review feedback");
      expect(mux.sent[1]?.submitMode).toBe("followUp");
      expect(session.events.uiCallsFor("setWidget").length > 0).toBeTruthy();

      const renderedText = renderSessionChatLines(session).join("\n");
      expect(renderedText).toMatch(
        /π start · worker-one · worker · Inspect failing tests · worker-one · running/,
      );
      expect(renderedText).toMatch(/π list · 1 agent · 1 running/);
      expect(renderedText).toMatch(
        /π message · [0-9a-f]{8} · steer · Focus on src\/extensions first/i,
      );
      expect(renderedText).toMatch(
        /worker-one · running · steer · Focus on src\/extensions[\s\S]*first/i,
      );
      expect(renderedText).toMatch(/π cancel · [0-9a-f]{8} · worker-one · cancelled/i);
      expect(renderedText).toMatch(/π message · [0-9a-f]{8} · followUp · Address review feedback/i);
      expect(renderedText).toMatch(
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
    setSessionPersistence(session, true);

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

    expect(mux.created.length).toBe(1);
    expect(mux.created[0]?.target).toBe("window");
    expect(mux.created[0]?.title).toBe("worker-window");
    expect(readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE")).toBe(
      "Inspect failing tests",
    );
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
      setSessionPersistence(session, true);

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

      expect(mux.created.length).toBe(1);
      expect(mux.created[0]?.title).toBe("worker-timeout");
      expect(
        readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_CHILD_STATE_FILE"),
      ).toMatch(/"prompt":"Inspect failing tests"/);
      expect(
        readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_CHILD_STATE_FILE"),
      ).toMatch(/"autoExitTimeoutMs":45/);
    } finally {
      session?.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest("subagent extension launches ephemeral children with --no-session", async () => {
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();

  try {
    session = await createTestSession({
      extensionFactories: [createSubagentExtension({ adapterFactory: () => mux })],
    });
    patchHarnessAgent(session);
    setSessionPersistence(session, true);

    await session.run(
      when("Start an ephemeral delegated worker", [
        calls("subagent", {
          action: "start",
          name: "worker-ephemeral",
          task: "Inspect failing tests",
          persisted: false,
        }),
        says("Started."),
      ]),
    );

    expect(mux.created.length).toBe(1);
    expect(mux.created[0]?.command ?? "").toMatch(/--no-session/);
    expect(mux.created[0]?.command ?? "").not.toMatch(/--session/);
  } finally {
    session?.dispose();
  }
});

timedTest(
  "subagent extension infers ephemeral children from ephemeral parent sessions",
  async () => {
    let session: TestSession | undefined;
    const mux = new HarnessMuxAdapter();

    try {
      session = await createTestSession({
        extensionFactories: [createSubagentExtension({ adapterFactory: () => mux })],
      });
      patchHarnessAgent(session);
      setSessionPersistence(session, false);

      await session.run(
        when("Start delegated worker from ephemeral parent", [
          calls("subagent", {
            action: "start",
            name: "worker-inferred-ephemeral",
            task: "Inspect failing tests",
          }),
          says("Started."),
        ]),
      );

      expect(mux.created.length).toBe(1);
      expect(mux.created[0]?.command ?? "").toMatch(/--no-session/);
      expect(mux.created[0]?.command ?? "").not.toMatch(/--session/);
    } finally {
      session?.dispose();
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
      setSessionPersistence(session, true);
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

      expect(mux.created.length).toBe(1);
      expect(
        readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
      ).toMatch(/Shared summary from handoff helper/);
      expect(
        readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
      ).toMatch(/Parent session/);
      expect(mux.created[0]?.command ?? "").not.toMatch(
        /--mode-worker .*Shared summary from handoff helper/,
      );
      const toolExecutionEnd = session.events.all.find(
        (event) => event.type === "tool_execution_end" && event.toolName === "subagent",
      ) as { result?: { content?: Array<{ type: string; text?: string }> } } | undefined;
      expect(toolExecutionEnd?.result?.content?.[0]?.text ?? "").toMatch(
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
    expect(toolExecutionEnd).toBeTruthy();
    expect(toolExecutionEnd.isError).toBe(true);
    const errorText =
      toolExecutionEnd.result?.content
        ?.filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n") ?? "";
    expect(errorText).toMatch(
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
    expect(toolExecutionEnd).toBeTruthy();
    expect(toolExecutionEnd.isError).toBe(true);
    const errorText =
      toolExecutionEnd.result?.content
        ?.filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n") ?? "";
    expect(errorText).toMatch(/Invalid subagent start params: `task` is required/);
    expect(errorText).toMatch(/There is no subagent read action later/i);
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

    expect(customMermaidMessages.length).toBe(1);
    expect(customMermaidMessages[0]?.details?.source ?? "").toMatch(/sequenceDiagram/);
    expect(customMermaidMessages[0]?.details?.ascii ?? "").not.toMatch(/\x1b\[/);
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

    expect(blocks.length).toBe(3);
    expect(blocks[0] ?? "").toMatch(/flowchart LR/);
    expect(blocks[0] ?? "").toMatch(/contains ```mermaid``` fence/);
    expect(blocks[1] ?? "").toMatch(/flowchart LR/);
    expect(blocks[2] ?? "").toMatch(/sequenceDiagram/);
    expect(blocks.every((block) => !block.includes("Start --> Validate"))).toBeTruthy();
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

      expect(await readFile(getStashFilePath(), "utf8")).toBe(
        entries.map((entry) => JSON.stringify(entry)).join("\n"),
      );

      expect(await loadStashEntries(cwd)).toEqual(entries);
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

      expect(await loadStashEntries(cwd)).toEqual([entries[0], entries[1]]);
      expect(await readFile(getStashFilePath(), "utf8")).toBe(
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
      expect(loaded.length).toBe(50);
      expect(loaded.map((entry) => entry.id)).toEqual(
        entries.slice(0, 50).map((entry) => entry.id),
      );
      expect(await readFile(getStashFilePath(), "utf8")).toBe(
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
      expect(loaded.length).toBe(50);
      expect(loaded.map((entry) => entry.id)).toEqual(
        entries.slice(0, 50).map((entry) => entry.id),
      );
      expect((await readFile(getStashFilePath(), "utf8")).split("\n").length).toBe(50);
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
    expect(stashCommand).toBeTruthy();
    expect(stashCommand?.description).toBe("Manage stashed prompts");
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

    expect(shortcuts.get("ctrl+alt+s")?.description).toBe("Stash current prompt");
    expect(shortcuts.get("ctrl+alt+p")?.description).toBe("Select prompt mode");
    expect(shortcuts.get("ctrl+alt+m")?.description).toBe("Cycle prompt mode");
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

    expect(shortcuts.get("ctrl+alt+o")?.description).toBe("Browse files mentioned in the session");
    expect(shortcuts.get("ctrl+alt+f")?.description).toBe(
      "Reveal the latest file reference in Finder",
    );
    expect(shortcuts.get("ctrl+alt+r")?.description).toBe("Quick Look the latest file reference");
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

      expect(session.events.uiCallsFor("setEditorText").at(-1)?.args[0]).toBe(entries[0]?.text);
      expect(session.events.uiCallsFor("notify").at(-1)?.args[0]).toBe(
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
      expect(latestPromptStashState).toBeTruthy();
      expect(await loadStashEntries(cwd)).toEqual([entries[1]]);
    });
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});
