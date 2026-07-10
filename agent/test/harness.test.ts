import { afterEach, expect, test } from "vitest";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { calls, createTestSession, says, when, type TestSession } from "@support/pi-test-harness";
import {
  DefaultResourceLoader,
  initTheme,
  InteractiveMode,
  parseArgs,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setKeybindings } from "@earendil-works/pi-tui";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import stripAnsi from "strip-ansi";
import { createPlaybookStreamFn } from "@support/pi-test-harness/playbook";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { createTempDir } from "./test-utils/temp-paths.ts";
import webFetchExtension from "../src/extensions/fetch.ts";
import mermaidExtension, { extractMermaidBlocks } from "../src/extensions/mermaid.ts";
import webSearchExtension, { webSearchTool } from "../src/extensions/websearch.ts";
import patchExtension from "../src/extensions/patch.ts";
import handoffExtension from "../src/extensions/handoff.ts";
import { createLiteLLMProviderRegistrations } from "../src/extensions/litellm.ts";
import { registerPiAiProvider } from "../src/extensions/pi-ai-models.ts";
import modesExtension, { createModesExtension } from "../src/extensions/modes.ts";
import { createModeStartupSelection } from "../src/extensions/modes/startup-selection.ts";
import interviewExtension from "../src/extensions/interview/index.ts";
import gsdExtension from "../src/extensions/gsd/index.ts";
import { bundledExtensionFactories } from "../src/extensions/index.ts";
import filesExtension from "../src/extensions/files.ts";
import executorExtension from "../src/extensions/executor/index.ts";
import { setExecutorSettingsForTests } from "../src/extensions/executor/settings.ts";
import {
  defineModesFile,
  registerBuiltInModes,
  unregisterBuiltInModes,
} from "../src/mode-utils.ts";
import { getModesSettingsPath } from "../src/extensions/modes/settings.ts";
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
import skillReadExtension from "../src/extensions/skill-read.ts";
import { createSubagentExtension } from "../src/extensions/subagent.ts";
import type { MuxAdapter, PaneSubmitMode } from "../src/subagent-sdk/mux.ts";
import {
  setRegisteredThemes,
  theme as activeTheme,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

process.env.OPENAI_API_KEY ??= "test-key";
process.env.TEST_KEY ??= "test-key";

const TEST_TIMEOUT_MS = 20_000;
const GITHUB_ACTIONS_TEST_TIMEOUT_MS = 30_000;
const TEST_MODE_SOURCE_NAMES = [
  "test-model-family",
  "test-handoff",
  "test-shared-selection",
  "test-cli-flags",
  "test-subagent-window-mode",
  "test-subagent-timeout-mode",
] as const;

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(
    name,
    {
      timeout:
        process.env.GITHUB_ACTIONS === "true" ? GITHUB_ACTIONS_TEST_TIMEOUT_MS : TEST_TIMEOUT_MS,
    },
    fn,
  )) as typeof test;

afterEach(() => {
  for (const sourceName of TEST_MODE_SOURCE_NAMES) {
    unregisterBuiltInModes(sourceName);
  }
});

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

function activateAllRegisteredToolsExtension(pi: ExtensionAPI) {
  const activateAllTools = () => {
    pi.setActiveTools(pi.getAllTools().map((tool) => tool.name));
  };

  pi.on("session_start", () => {
    activateAllTools();
  });

  pi.on("before_agent_start", () => {
    activateAllTools();
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

async function writeHandoffCommandSettings(agentDir: string): Promise<void> {
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ handoff: { command: { enabled: true } } }),
    "utf8",
  );
}

async function createExecutorProbeServer(): Promise<{
  mcpUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    if (request.url === "/api/integrations") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("[]");
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
    fauxProvider({
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
    fauxProvider({
      provider: "codex-openai",
      models: [
        {
          id: "gpt-5.5",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
        {
          id: "gpt-5.6-terra",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
        {
          id: "gpt-5.4-mini",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    }),
    fauxProvider({
      provider: "openai-codex",
      models: [
        {
          id: "gpt-5.5",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
        {
          id: "gpt-5.4-mini",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    }),
    fauxProvider({
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
    fauxProvider({
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
    Array.from({ length: 8 }, () => fauxAssistantMessage("openai-codex response")),
  );
  registrations[3].setResponses(
    Array.from({ length: 8 }, () => fauxAssistantMessage("mode-provider response")),
  );
  registrations[4].setResponses(
    Array.from({ length: 8 }, () => fauxAssistantMessage("override-provider response")),
  );
  const unregisterPiAiProviders = registrations.map((registration) =>
    registerPiAiProvider(registration.provider),
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
          streamSimple: registration.provider.streamSimple,
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
      for (const unregisterPiAiProvider of unregisterPiAiProviders) {
        unregisterPiAiProvider();
      }
    },
  };
}

function createModelFamilyTestProviders(): {
  extensionFactory: (pi: ExtensionAPI) => void;
  getModel: (id: string) => { provider: string; id: string } & Record<string, unknown>;
  setResponses: (
    response: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number],
  ) => void;
  dispose: () => void;
} {
  const registrations = [
    fauxProvider({
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
    fauxProvider({
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
    fauxProvider({
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
    fauxProvider({
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
    fauxProvider({
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
    fauxProvider({
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
  const unregisterPiAiProviders = registrations.map((registration) =>
    registerPiAiProvider(registration.provider),
  );

  return {
    extensionFactory(pi: ExtensionAPI) {
      for (const registration of registrations) {
        const model = registration.getModel();
        pi.registerProvider(model.provider, {
          baseUrl: model.baseUrl,
          apiKey: "TEST_KEY",
          api: registration.api,
          streamSimple: registration.provider.streamSimple,
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
      for (const unregisterPiAiProvider of unregisterPiAiProviders) {
        unregisterPiAiProvider();
      }
    },
  };
}

async function writeModelFamilyModesFile(cwd: string): Promise<void> {
  void cwd;
  registerBuiltInModes(
    "test-model-family",
    defineModesFile({
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
    }),
  );
}

async function writeHandoffModesFile(cwd: string): Promise<void> {
  void cwd;
  registerBuiltInModes(
    "test-handoff",
    defineModesFile({
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
    }),
  );
}

async function writeSharedSelectionModesFile(cwd: string): Promise<void> {
  void cwd;
  registerBuiltInModes(
    "test-shared-selection",
    defineModesFile({
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
    }),
  );
}

async function writeGsdEnabledConfig(cwd: string): Promise<void> {
  await mkdir(join(cwd, ".planning"), { recursive: true });
  await writeFile(
    join(cwd, ".planning", "config.json"),
    `${JSON.stringify(
      {
        model_profile: "balanced",
        commit_docs: true,
        parallelization: true,
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
  void cwd;
  registerBuiltInModes(
    "test-cli-flags",
    defineModesFile({
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
    }),
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

function hasRegisteredCommand(testSession: TestSession, commandName: string): boolean {
  const extensionRunner = (
    testSession.session as {
      extensionRunner: {
        getRegisteredCommands: () => Array<{ invocationName: string }>;
      };
    }
  ).extensionRunner;
  return extensionRunner
    .getRegisteredCommands()
    .some((registeredCommand) => registeredCommand.invocationName === commandName);
}

function getCurrentSystemPrompt(testSession: TestSession): string {
  return (testSession.session as { agent: { state: { systemPrompt: string } } }).agent.state
    .systemPrompt;
}

function estimatePromptTokenCount(prompt: string): number {
  const pieces = prompt.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
  return pieces.reduce(
    (total, piece) => total + 1 + Math.max(0, Math.ceil(piece.length / 12) - 1),
    0,
  );
}

function getPromptSectionBreakdown(prompt: string): Array<{
  name: string;
  chars: number;
  estimatedTokens: number;
}> {
  const positions = [
    { name: "core identity", index: 0 },
    { name: "tools inventory", index: prompt.indexOf("Available tools:\n") },
    { name: "agent/tool guidelines", index: prompt.indexOf("Guidelines:\n") },
    { name: "pi docs pointers", index: prompt.indexOf("Pi documentation") },
    { name: "project instructions", index: prompt.indexOf("<project_context>") },
    {
      name: "skills registry",
      index: prompt.indexOf("The following skills provide specialized instructions"),
    },
    { name: "runtime footer", index: prompt.indexOf("Current date:") },
  ]
    .filter((position) => position.index >= 0)
    .sort((left, right) => left.index - right.index);

  return positions.map((position, index) => {
    const end = positions[index + 1]?.index ?? prompt.length;
    const section = prompt.slice(position.index, end);
    return {
      name: position.name,
      chars: section.length,
      estimatedTokens: estimatePromptTokenCount(section),
    };
  });
}

function getPromptBlockBreakdown(
  prompt: string,
  pattern: RegExp,
  labelIndex: number,
): Array<{ name: string; chars: number; estimatedTokens: number }> {
  return [...prompt.matchAll(pattern)]
    .map((match) => ({
      name: match[labelIndex] ?? "unknown",
      chars: match[0].length,
      estimatedTokens: estimatePromptTokenCount(match[0]),
    }))
    .sort((left, right) => right.estimatedTokens - left.estimatedTokens);
}

function getPromptGuidelineBreakdown(
  prompt: string,
): Array<{ name: string; chars: number; estimatedTokens: number }> {
  const start = prompt.indexOf("Guidelines:\n");
  const end = prompt.indexOf("\n\nPi documentation");
  if (start < 0 || end < 0) return [];

  return prompt
    .slice(start + "Guidelines:\n".length, end)
    .split(/\n- /u)
    .map((item, index) => (index === 0 ? item.replace(/^- /u, "") : item))
    .filter((item) => item.trim().length > 0)
    .map((item) => ({
      name: item.split("\n", 1)[0]?.slice(0, 120) ?? "unknown",
      chars: item.length,
      estimatedTokens: estimatePromptTokenCount(item),
    }))
    .sort((left, right) => right.estimatedTokens - left.estimatedTokens);
}

function getPromptSkillBreakdown(
  prompt: string,
): Array<{ name: string; chars: number; estimatedTokens: number }> {
  const xmlSkills = getPromptBlockBreakdown(
    prompt,
    /<skill>\n    <name>(.*?)<\/name>\n[\s\S]*?\n  <\/skill>/gu,
    1,
  );
  if (xmlSkills.length > 0) return xmlSkills;

  const start = prompt.indexOf("Available skills:\n");
  const end = prompt.indexOf("\nCurrent date:");
  if (start < 0 || end < 0) return [];

  return getPromptBlockBreakdown(prompt.slice(start, end), /^- ([^:]+): .*$/gmu, 1);
}

function escapeMarkdownTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderPromptBenchmarkTable(input: {
  estimatedTokens: number;
  chars: number;
  activeToolCount?: number;
  activeTools?: string[];
  sections: Array<{ name: string; chars: number; estimatedTokens: number }>;
  projectInstructions: Array<{ name: string; chars: number; estimatedTokens: number }>;
  guidelines?: Array<{ name: string; chars: number; estimatedTokens: number }>;
  skills: Array<{ name: string; chars: number; estimatedTokens: number }>;
  tools: Array<{ name: string; chars: number; estimatedTokens: number }>;
}): string {
  const renderRows = (rows: Array<{ name: string; chars: number; estimatedTokens: number }>) =>
    rows
      .map(
        (row) =>
          `| ${escapeMarkdownTableCell(row.name)} | ${row.estimatedTokens} | ${row.chars} | ${((row.estimatedTokens / input.estimatedTokens) * 100).toFixed(1)}% |`,
      )
      .join("\n");

  return [
    `# System prompt benchmark`,
    "",
    `Estimated tokens: ${input.estimatedTokens}`,
    `Chars: ${input.chars}`,
    input.activeToolCount === undefined ? "" : `Active tools: ${input.activeToolCount}`,
    input.activeTools === undefined ? "" : `Active tool names: ${input.activeTools.join(", ")}`,
    "",
    "## Sections",
    "",
    "| Section | Estimated tokens | Chars | Share |",
    "| --- | ---: | ---: | ---: |",
    renderRows(input.sections),
    "",
    "## Project instructions",
    "",
    "| File | Estimated tokens | Chars | Share |",
    "| --- | ---: | ---: | ---: |",
    renderRows(input.projectInstructions),
    "",
    "## Guidelines",
    "",
    "| Guideline | Estimated tokens | Chars | Share |",
    "| --- | ---: | ---: | ---: |",
    renderRows(input.guidelines ?? []),
    "",
    "## Skills",
    "",
    "| Skill | Estimated tokens | Chars | Share |",
    "| --- | ---: | ---: | ---: |",
    renderRows(input.skills),
    "",
    "## Tools",
    "",
    "| Tool | Estimated tokens | Chars | Share |",
    "| --- | ---: | ---: | ---: |",
    renderRows(input.tools),
    "",
  ].join("\n");
}

function renderSessionChatLines(testSession: TestSession, width = 120): string[] {
  const mode = new InteractiveMode({
    session: testSession.session,
    dispose: async () => {},
    setBeforeSessionInvalidate: () => {},
    setRebindSession: () => {},
  } as never);

  try {
    const entries = (
      testSession.session as {
        sessionManager: {
          buildContextEntries: () => unknown[];
        };
      }
    ).sessionManager.buildContextEntries();

    (mode as any).renderSessionEntries(entries);
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
  const cwd = await createTempDir("agent-harness-");
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

    if (url.includes("/responses")) {
      expect(getHeader("authorization").length > 0).toBeTruthy();
      const text1 = JSON.stringify({ answer: "Next.js 16 released in October 2025." });
      const text2 = JSON.stringify({
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
        searchQueries: ["next.js 16 release date official", "next.js 16 upgrade guide"],
      });
      const events = [
        {
          type: "response.created",
          response: {
            id: "resp-test",
            created_at: Date.now(),
            status: "in_progress",
            model: "gemini-2.5-flash",
          },
        },
        {
          type: "response.output_item.added",
          item: {
            type: "message",
            id: "msg-test",
            role: "assistant",
            content: [],
            status: "in_progress",
          },
          output_index: 0,
        },
        {
          type: "response.content_part.added",
          part: { type: "output_text", text: "" },
          item_id: "msg-test",
          output_index: 0,
          content_index: 0,
        },
        {
          type: "response.output_text.delta",
          delta: text1,
          item_id: "msg-test",
          output_index: 0,
          content_index: 0,
        },
        {
          type: "response.output_text.delta",
          delta: "\n\n" + text2,
          item_id: "msg-test",
          output_index: 0,
          content_index: 0,
        },
        {
          type: "response.completed",
          response: {
            id: "resp-test",
            object: "response",
            created_at: Date.now(),
            status: "completed",
            model: "gemini-2.5-flash",
            output: [
              {
                type: "message",
                id: "msg-test",
                role: "assistant",
                content: [{ type: "output_text", text: text1 + "\n\n" + text2, annotations: [] }],
                status: "completed",
              },
            ],
            usage: { input_tokens: 10, output_tokens: 50, total_tokens: 60 },
          },
        },
      ];

      const stream = new ReadableStream({
        start(controller) {
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

  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: join(homedir(), ".pi", "agent"),
  });
  await loader.reload();

  const bundledThemes = loader.getThemes().themes;
  expect(bundledThemes.some((loadedTheme) => loadedTheme.name === "catppuccin-mocha")).toBeTruthy();

  setRegisteredThemes(bundledThemes);
  initTheme("catppuccin-mocha");

  expect(activeTheme.name).toBe("catppuccin-mocha");
});

timedTest("handoff command is hidden by default", async () => {
  const cwd = await createTempDir("agent-handoff-hidden-default-");
  let session: TestSession | undefined;
  const providers = createHandoffTestProviders("ok");

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [modesExtension, handoffExtension, providers.extensionFactory],
    });

    expect(hasRegisteredCommand(session, "handoff")).toBe(false);
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("handoff command starts the new session in the requested mode", async () => {
  const cwd = await createTempDir("agent-handoff-command-");
  let session: TestSession | undefined;
  const observedModeChanges: CapturedModeChange[] = [];
  const providers = createHandoffTestProviders(
    "## Context\nPrior decisions captured.\n\n## Task\nFinish the implementation.",
  );

  await writeHandoffModesFile(cwd);
  await writeHandoffCommandSettings(cwd);

  try {
    await withTempAgentDir(cwd, async () => {
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

timedTest("modes extension preserves an explicit startup model", async () => {
  const cwd = await createTempDir("agent-mode-explicit-startup-model-");
  let session: TestSession | undefined;
  const observedModeChanges: CapturedModeChange[] = [];
  const providers = createHandoffTestProviders("## Context\nCaptured.\n\n## Task\nContinue.");

  try {
    session = await createTestSession({
      cwd,
      initialModel: providers.getModel("override-model") as never,
      extensionFactories: [
        createModesExtension(
          createModeStartupSelection(
            parseArgs(["--provider", "override-provider", "--model", "override-model"]),
          ),
        ),
        createModeChangeCaptureExtension(observedModeChanges),
        providers.extensionFactory,
      ],
    });
    patchHarnessAgent(session);

    const model = session.session as {
      model: { provider: string; id: string };
      thinkingLevel: string;
    };
    expect(model.model.provider).toBe("override-provider");
    expect(model.model.id).toBe("override-model");
    expect(model.thinkingLevel).toBe("medium");
    expect(observedModeChanges.at(-1)?.mode).toBe("build");
    expect(observedModeChanges.at(-1)?.spec?.provider).toBe("override-provider");
    expect(observedModeChanges.at(-1)?.spec?.modelId).toBe("override-model");

    await session.run(when("Keep selected model", [says("Kept.")]));

    expect(model.model.provider).toBe("override-provider");
    expect(model.model.id).toBe("override-model");
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("handoff command with mode and model applies the startup selection once", async () => {
  const cwd = await createTempDir("agent-handoff-command-mixed-");
  let session: TestSession | undefined;
  const observedModeChanges: CapturedModeChange[] = [];
  const providers = createHandoffTestProviders(
    "## Context\nPrior decisions captured.\n\n## Task\nFinish the implementation.",
  );

  await writeHandoffModesFile(cwd);
  await writeHandoffCommandSettings(cwd);

  try {
    await withTempAgentDir(cwd, async () => {
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
  const cwd = await createTempDir("agent-handoff-autocomplete-");
  let session: TestSession | undefined;
  const providers = createHandoffTestProviders("## Context\nCaptured.\n\n## Task\nContinue.");

  await writeHandoffModesFile(cwd);
  await writeHandoffCommandSettings(cwd);

  try {
    await withTempAgentDir(cwd, async () => {
      session = await createTestSession({
        cwd,
        extensionFactories: [modesExtension, handoffExtension, providers.extensionFactory],
      });
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
  const cwd = await createTempDir("agent-executor-autocomplete-");
  let session: TestSession | undefined;
  const server = await createExecutorProbeServer();

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
    expect(rootCompletions?.map((item) => item.label)).toEqual(["on", "off", "status", "web"]);

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
  const cwd = await createTempDir("agent-executor-command-");
  let session: TestSession | undefined;
  const server = await createExecutorProbeServer();

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
    const cwd = await createTempDir("agent-handoff-modes-prompt-");
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
      expect(initialPrompt).toMatch(/- docs: Fast technical writing/);
      expect(initialPrompt).toMatch(/- smart/);

      await session.session.prompt("/mode store deep");
      await session.session.agent.waitForIdle();

      await waitForAssertion(() => {
        expect(getCurrentSystemPrompt(session)).toMatch(/- deep:/);
      });
    } finally {
      session?.dispose();
      providers.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest("modes extension registers CLI flags from discovered modes", async () => {
  const cwd = await createTempDir("agent-mode-flags-");
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
  const cwd = await createTempDir("agent-mode-flags-reload-");
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
  const cwd = await createTempDir("agent-mode-reload-state-");
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
  const cwd = await createTempDir("agent-mode-branch-dedupe-");
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
    const cwd = await createTempDir("agent-mode-flags-shared-selection-");
    const agentDir = await createTempDir("agent-mode-flags-shared-selection-agent-");
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

timedTest("modes extension skips mode-state persistence for ephemeral sessions", async () => {
  const cwd = await createTempDir("agent-mode-ephemeral-");
  let session: TestSession | undefined;
  const providers = createHandoffTestProviders("## Context\nCaptured.\n\n## Task\nContinue.");

  await writeHandoffModesFile(cwd);

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [modesExtension, providers.extensionFactory],
    });
    setSessionPersistence(session, false);

    await session.session.prompt("/mode docs");
    await session.session.agent.waitForIdle();

    expect(countModeStateEntries(session)).toBe(0);
    expect(getLatestModeState(session)).toBe(undefined);
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("mode command restores active mode from session state only", async () => {
  const cwd = await createTempDir("agent-mode-settings-persist-");
  const agentDir = await createTempDir("agent-mode-settings-agent-");
  let session: TestSession | undefined;
  const providers = createHandoffTestProviders("## Context\nCaptured.\n\n## Task\nContinue.");

  await writeHandoffModesFile(cwd);

  try {
    await withTempAgentDir(agentDir, async () => {
      session = await createTestSession({
        cwd,
        extensionFactories: [modesExtension, providers.extensionFactory],
      });
      setSessionPersistence(session!, true);

      await session.session.prompt("/mode docs");
      await session.session.agent.waitForIdle();

      await expect(readFile(getModesSettingsPath(), "utf8")).rejects.toThrow();

      await session.session.reload();

      const model = session.session as {
        model: { provider: string; id: string };
        thinkingLevel: string;
      };
      expect(model.model.provider).toBe("mode-provider");
      expect(model.model.id).toBe("mode-model");
      expect(model.thinkingLevel).toBe("high");
      expect(getLatestModeState(session)).toBe("docs");
    });
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(agentDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("mode CLI flag ignores saved settings mode on startup", async () => {
  const cwd = await createTempDir("agent-mode-flag-overrides-settings-");
  const agentDir = await createTempDir("agent-mode-flag-overrides-settings-agent-");
  let session: TestSession | undefined;
  const observedModeChanges: CapturedModeChange[] = [];
  const providers = createHandoffTestProviders("## Context\nCaptured.\n\n## Task\nContinue.");

  await writeSharedSelectionModesFile(cwd);

  try {
    await withTempAgentDir(agentDir, async () => {
      await writeFile(
        getModesSettingsPath(),
        `${JSON.stringify({ modes: { current: "deep" } }, null, 2)}\n`,
        "utf8",
      );

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
        expect(JSON.parse(await readFile(getModesSettingsPath(), "utf8"))).toEqual({
          modes: { current: "deep" },
        });

        const latestModeChange = observedModeChanges.at(-1);
        expect(latestModeChange?.mode).toBe("review");
        expect(latestModeChange?.reason).toBe("restore");
        expect(latestModeChange?.source).toBe("session_start");
      });
    });
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(agentDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest(
  "mode CLI flags keep explicit startup mode after other loaders register different flags",
  async () => {
    const sessionCwd = await createTempDir("agent-mode-flags-shared-selection-local-");
    const loaderCwd = await createTempDir("agent-mode-flags-overwrite-loader-");
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

timedTest("LiteLLM provider registrations route codex-openai via OpenAI Responses", () => {
  const registrations = createLiteLLMProviderRegistrations(
    {
      healthy: true,
      label: "public",
      origin: "https://litellm.example.test",
      baseUrl: "https://litellm.example.test/v1",
    },
    "TEST_KEY",
  );

  const codexRegistration = registrations.find(
    (registration) => registration.provider === "codex-openai",
  );

  expect(codexRegistration).toBeTruthy();
  expect(codexRegistration.provider).toBe("codex-openai");
  expect(codexRegistration.config.baseUrl).toBe("https://litellm.example.test/v1");
  expect(codexRegistration.config.apiKey).toBe("TEST_KEY");
  expect(codexRegistration.config.api).toBe("openai-responses");
  expect(
    codexRegistration.config.models!.every((model) => model.api === "openai-responses"),
  ).toBeTruthy();
});

timedTest("LiteLLM provider registrations route deepseek via LiteLLM v1", () => {
  const registrations = createLiteLLMProviderRegistrations(
    {
      healthy: true,
      label: "public",
      origin: "https://litellm.example.test",
      baseUrl: "https://litellm.example.test/v1",
    },
    "TEST_KEY",
  );

  const deepSeekRegistration = registrations.find(
    (registration) => registration.provider === "deepseek",
  );

  expect(deepSeekRegistration).toBeTruthy();
  expect(deepSeekRegistration.provider).toBe("deepseek");
  expect(deepSeekRegistration.config.baseUrl).toBe("https://litellm.example.test/v1");
  expect(deepSeekRegistration.config.apiKey).toBe("TEST_KEY");
  expect(deepSeekRegistration.config.api).toBe("openai-completions");
  expect(Array.isArray(deepSeekRegistration.config.models)).toBeTruthy();
  expect(
    deepSeekRegistration.config.models!.some((model) => model.id === "deepseek-v4-flash"),
  ).toBeTruthy();
});

timedTest("modes extension applies mode systemPrompt to active session on next turn", async () => {
  const cwd = await createTempDir("agent-mode-system-prompt-state-");
  let session: TestSession | undefined;
  const providers = createHandoffTestProviders("ok");

  await writeSharedSelectionModesFile(cwd);

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [modesExtension, providers.extensionFactory],
    });

    await session.session.prompt("/mode review");
    await session.session.agent.waitForIdle();
    await session.session.prompt("hello");
    await session.session.agent.waitForIdle();

    expect(getCurrentSystemPrompt(session)).toContain("Review mode");
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("modes extension injects selected mode systemPrompt into next agent turn", async () => {
  const cwd = await createTempDir("agent-mode-system-prompt-turn-");
  let session: TestSession | undefined;
  const providers = createHandoffTestProviders("ok");
  const seenSystemPrompts: string[] = [];
  const captureSystemPromptExtension = (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event) => {
      seenSystemPrompts.push(event.systemPrompt);
      return;
    });
  };

  await writeSharedSelectionModesFile(cwd);

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [
        modesExtension,
        captureSystemPromptExtension,
        providers.extensionFactory,
      ],
    });

    await session.session.prompt("/mode review");
    await session.session.agent.waitForIdle();
    await session.session.prompt("hello");
    await session.session.agent.waitForIdle();

    expect(seenSystemPrompts.at(-1)).toContain("Review mode");
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("interview tool is hidden by default and toggled by command", async () => {
  const cwd = await createTempDir("agent-interview-toggle-tools-");
  let session: TestSession | undefined;
  const providers = createHandoffTestProviders("ok");

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [interviewExtension, providers.extensionFactory],
    });

    await session.session.prompt("hello");
    await session.session.agent.waitForIdle();
    expect(getCurrentSystemPrompt(session)).not.toContain("- interview:");

    await session.session.prompt("/interview on");
    await session.session.agent.waitForIdle();
    await session.session.prompt("hello again");
    await session.session.agent.waitForIdle();
    expect(getCurrentSystemPrompt(session)).toContain("- interview:");

    await session.session.prompt("/interview off");
    await session.session.agent.waitForIdle();
    await session.session.prompt("hello after off");
    await session.session.agent.waitForIdle();
    expect(getCurrentSystemPrompt(session)).not.toContain("- interview:");

    const completions = await getCommandArgumentCompletions(session, "interview", "o");
    expect(completions?.map((item) => item.label)).toEqual(["on", "off"]);

    await session.session.prompt("/interview");
    await session.session.agent.waitForIdle();
    await session.session.prompt("hello after toggle on");
    await session.session.agent.waitForIdle();
    expect(getCurrentSystemPrompt(session)).toContain("- interview:");

    await session.session.prompt("/interview");
    await session.session.agent.waitForIdle();
    await session.session.prompt("hello after toggle off");
    await session.session.agent.waitForIdle();
    expect(getCurrentSystemPrompt(session)).not.toContain("- interview:");
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest(
  "gsd debug manager mode keeps interview hidden by default and activates subagent",
  async () => {
    const cwd = await createTempDir("agent-gsd-debug-mode-tools-");
    let session: TestSession | undefined;
    const providers = createHandoffTestProviders("ok");
    const capturedToolSets: string[][] = [];

    try {
      session = await createTestSession({
        cwd,
        extensionFactories: [
          modesExtension,
          interviewExtension,
          gsdExtension,
          createSubagentExtension(),
          createActiveToolsCaptureExtension(capturedToolSets),
          providers.extensionFactory,
        ],
      });

      await session.session.prompt("/mode gsd-debug-session-manager");
      await session.session.agent.waitForIdle();
      await waitForAssertion(() => {
        expect(capturedToolSets.length).toBeGreaterThan(0);
      });

      const activeTools = capturedToolSets.at(-1) ?? [];
      expect(activeTools.includes("interview")).toBe(false);
      expect(activeTools.includes("subagent")).toBe(true);
    } finally {
      session?.dispose();
      providers.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest(
  "gsd debug manager mode exposes subagent but keeps interview out of system prompt",
  async () => {
    const cwd = await createTempDir("agent-gsd-debug-mode-prompt-tools-");
    let session: TestSession | undefined;
    const providers = createHandoffTestProviders("ok");

    try {
      session = await createTestSession({
        cwd,
        extensionFactories: [
          modesExtension,
          interviewExtension,
          gsdExtension,
          createSubagentExtension(),
          providers.extensionFactory,
        ],
      });

      await session.session.prompt("/mode gsd-debug-session-manager");
      await session.session.agent.waitForIdle();
      await session.session.prompt("hello");
      await session.session.agent.waitForIdle();

      const systemPrompt = getCurrentSystemPrompt(session);
      expect(systemPrompt).not.toContain("- interview:");
      expect(systemPrompt).toContain("- subagent:");
    } finally {
      session?.dispose();
      providers.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest("/gsd debug launches replacement session without interview by default", async () => {
  const cwd = await createTempDir("agent-gsd-debug-launch-tools-");
  let session: TestSession | undefined;
  const providers = createHandoffTestProviders("ok");
  const capturedToolSets: string[][] = [];

  await writeGsdEnabledConfig(cwd);

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [
        modesExtension,
        interviewExtension,
        gsdExtension,
        createSubagentExtension(),
        createActiveToolsCaptureExtension(capturedToolSets),
        providers.extensionFactory,
      ],
    });

    await session.session.prompt("/gsd on");
    await session.session.agent.waitForIdle();
    await session.session.prompt("/gsd debug parser unstable");
    await session.session.agent.waitForIdle();
    await session.session.prompt("hello");
    await session.session.agent.waitForIdle();

    const systemPrompt = getCurrentSystemPrompt(session);
    expect(systemPrompt).not.toContain("- interview:");
    await waitForAssertion(() => {
      const activeTools = capturedToolSets.at(-1) ?? [];
      expect(activeTools.includes("interview")).toBe(false);
    });
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("bundled extension stack keeps interview hidden in gsd debug manager mode", async () => {
  const cwd = await createTempDir("agent-bundled-gsd-debug-mode-tools-");
  let session: TestSession | undefined;
  const providers = createHandoffTestProviders("ok");

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [...bundledExtensionFactories, providers.extensionFactory],
    });

    await session.session.prompt("/mode gsd-debug-session-manager");
    await session.session.agent.waitForIdle();
    await session.session.prompt("hello");
    await session.session.agent.waitForIdle();

    expect(getCurrentSystemPrompt(session)).not.toContain("- interview:");
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("benchmarks bundled system prompt token budget", async () => {
  const cwd = await createTempDir("agent-system-prompt-benchmark-");
  const agentDir = await createTempDir("agent-system-prompt-benchmark-global-");
  let session: TestSession | undefined;
  const providers = createHandoffTestProviders("ok");

  try {
    const defaultGlobalAgentsPath = join(process.cwd(), "..", "AI.md");
    const globalAgentsContent = await readFile(defaultGlobalAgentsPath, "utf8");
    const loadedGlobalAgentsPath = join(agentDir, "AGENTS.md");
    await writeFile(loadedGlobalAgentsPath, globalAgentsContent, "utf8");
    const projectAgentsPath = join(process.cwd(), "AGENTS.md");
    const loadedProjectAgentsPath = join(cwd, "AGENTS.md");
    await writeFile(loadedProjectAgentsPath, await readFile(projectAgentsPath, "utf8"), "utf8");

    session = await createTestSession({
      cwd,
      agentDir,
      extensionFactories: [
        ...bundledExtensionFactories,
        providers.extensionFactory,
        activateAllRegisteredToolsExtension,
      ],
    });

    await session.session.prompt("hello");
    await session.session.agent.waitForIdle();

    if (session === undefined) {
      throw new Error("benchmark session was not created");
    }
    const systemPrompt = getCurrentSystemPrompt(session);
    const activeTools = (
      session.session as { getActiveToolNames: () => string[] }
    ).getActiveToolNames();
    const tokenCount = estimatePromptTokenCount(systemPrompt);
    const benchmarkPath = join(process.cwd(), ".tmp", "system-prompt-benchmark.json");
    const benchmarkMarkdownPath = join(process.cwd(), ".tmp", "system-prompt-benchmark.md");
    const projectInstructionBreakdown = getPromptBlockBreakdown(
      systemPrompt,
      /<project_instructions path="([^"]+)">\n[\s\S]*?\n<\/project_instructions>/gu,
      1,
    );
    const skillBreakdown = getPromptSkillBreakdown(systemPrompt);
    const availableToolsSection = systemPrompt.slice(
      systemPrompt.indexOf("Available tools:\n"),
      systemPrompt.indexOf("\n\nIn addition"),
    );
    const toolBreakdown = getPromptBlockBreakdown(availableToolsSection, /^- ([^:]+): .*$/gmu, 1);
    const benchmark = {
      estimatedTokens: tokenCount,
      chars: systemPrompt.length,
      activeToolCount: activeTools.length,
      activeTools,
      defaultGlobalAgentsPath,
      loadedGlobalAgentsPath,
      projectAgentsPath,
      loadedProjectAgentsPath,
      sections: getPromptSectionBreakdown(systemPrompt),
      projectInstructions: projectInstructionBreakdown,
      guidelines: getPromptGuidelineBreakdown(systemPrompt),
      skills: skillBreakdown,
      tools: toolBreakdown,
    };

    await mkdir(join(process.cwd(), ".tmp"), { recursive: true });
    await writeFile(benchmarkPath, `${JSON.stringify(benchmark, null, 2)}\n`, "utf8");
    await writeFile(benchmarkMarkdownPath, renderPromptBenchmarkTable(benchmark), "utf8");

    expect(tokenCount).toBeLessThanOrEqual(7_500);
    expect(projectInstructionBreakdown.some((entry) => entry.name === loadedGlobalAgentsPath)).toBe(
      true,
    );
    expect(
      projectInstructionBreakdown.some((entry) => entry.name === loadedProjectAgentsPath),
    ).toBe(true);
    expect(systemPrompt).toContain(
      "- workflow: Run a deterministic JavaScript workflow. Before use, read dynamic-workflows skill.",
    );
    expect(systemPrompt).not.toContain("For workflow, route subagents with opts.mode.");
    expect(systemPrompt).not.toContain("For workflow, parallel() takes functions");
  } finally {
    session?.dispose();
    providers.dispose();
    await rm(cwd, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

timedTest(
  "modes extension scopes tools and restores the default toolset when leaving a scoped mode",
  async () => {
    const cwd = await createTempDir("agent-mode-tools-");
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

      const modeToolNames = capturedToolSets.at(-1) ?? [];
      expect(modeToolNames.includes("read")).toBeTruthy();
      expect(modeToolNames.includes("bash")).toBeFalsy();
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
    const cwd = await createTempDir("agent-agents-md-");
    const agentDir = await createTempDir("agent-agents-md-global-");
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
  const cwd = await createTempDir("agent-agents-md-skill-");
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

timedTest("skill reads return full content in one go", async () => {
  const cwd = await createTempDir("agent-skill-read-");
  const skillDir = join(cwd, ".agents", "skills", "demo-skill");
  const skillPath = join(skillDir, "SKILL.md");
  let session: TestSession | undefined;

  try {
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      skillPath,
      [
        "---",
        "name: demo-skill",
        "description: Demo skill",
        "---",
        "",
        ...Array.from({ length: 220 }, (_, index) => `line ${index + 1}`),
      ].join("\n"),
      "utf8",
    );

    session = await createTestSession({
      cwd,
      extensionFactories: [skillReadExtension],
    });
    patchHarnessAgent(session);

    await session.run(
      when("Read long skill with offset and limit", [
        calls("read", { path: skillPath, offset: 50, limit: 5 }),
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
    const effectiveInput = session.events.toolResultsFor("read")[0]?.input;

    expect(readResult).toContain("name: demo-skill");
    expect(readResult).toContain("line 1");
    expect(readResult).toContain("line 220");
    expect(readResult).not.toContain("Use offset=");
    expect(readResult).not.toContain("Showing lines");
    expect(effectiveInput?.offset).toBeUndefined();
    expect(effectiveInput?.limit).toBeUndefined();
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("skill reads ignore invalid offset and still return full content", async () => {
  const cwd = await createTempDir("agent-skill-read-offset-");
  const skillDir = join(cwd, ".agents", "skills", "demo-skill");
  const skillPath = join(skillDir, "SKILL.md");
  let session: TestSession | undefined;

  try {
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      skillPath,
      ["---", "name: demo-skill", "---", "", "full body"].join("\n"),
      "utf8",
    );

    session = await createTestSession({
      cwd,
      extensionFactories: [skillReadExtension],
    });
    patchHarnessAgent(session);

    await session.run(
      when("Read skill with impossible offset", [
        calls("read", { path: skillPath, offset: 9999, limit: 1 }),
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
    const effectiveInput = session.events.toolResultsFor("read")[0]?.input;

    expect(readResult).toContain("name: demo-skill");
    expect(readResult).toContain("full body");
    expect(readResult).not.toContain("Offset 9999 is beyond end of file");
    expect(effectiveInput?.offset).toBeUndefined();
    expect(effectiveInput?.limit).toBeUndefined();
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("non-skill reads still honor offset and limit", async () => {
  const cwd = await createTempDir("agent-skill-read-negative-");
  const filePath = join(cwd, "note.md");
  let session: TestSession | undefined;

  try {
    await writeFile(filePath, ["line 1", "line 2", "line 3"].join("\n"), "utf8");

    session = await createTestSession({
      cwd,
      extensionFactories: [skillReadExtension],
    });
    patchHarnessAgent(session);

    await session.run(
      when("Read non-skill with offset and limit", [
        calls("read", { path: filePath, offset: 2, limit: 1 }),
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

    const effectiveInput = session.events.toolResultsFor("read")[0]?.input;

    expect(readResult).toContain("line 2");
    expect(readResult).not.toContain("line 1");
    expect(readResult).toContain("[1 more lines in file. Use offset=3 to continue.]");
    expect(effectiveInput?.offset).toBe(2);
    expect(effectiveInput?.limit).toBe(1);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("agents-md extension loads AGENTS only within the session git root", async () => {
  const repoRoot = await createTempDir("agent-agents-md-repo-root-");
  const cwd = join(repoRoot, "apps", "cli");
  const externalDir = await createTempDir("agent-agents-md-external-", homedir());
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
        /running in the background.*return with a summary automatically/i,
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
      expect(executionEnds[4]?.result?.content?.[0]?.text ?? "").toMatch(/Resumed with new task/i);

      expect(mux.created.length).toBe(2);
      // sendText skipped on auto-resume (message already set as resume prompt)
      expect(mux.sent.length).toBe(1);
      expect(mux.killed.length).toBe(1);
      expect(mux.created[0]?.title).toBe("worker-one");
      expect(mux.created[1]?.title).toBe("worker-one");
      expect(mux.created[0]?.command ?? "").toMatch(/--session/);
      expect(mux.created[1]?.command ?? "").toMatch(/--session/);
      expect((mux.created[1]?.command ?? "").includes(sessionPath)).toBeTruthy();
      expect(
        readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
      ).toContain("Assigned task:\nInspect failing tests");
      expect(
        readLaunchFileBackedValue(mux.created[1]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
      ).toBe("Address review feedback");
      expect(
        readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_CHILD_STATE_FILE"),
      ).toMatch(/Assigned task:\\nInspect failing tests/);
      expect(
        readLaunchFileBackedValue(mux.created[1]?.command ?? "", "PI_SUBAGENT_CHILD_STATE_FILE"),
      ).toMatch(/"prompt":"Address review feedback"/);
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
        /worker-one · running · resumed · Address[\s\S]*review\s+feedback/i,
      );
    } finally {
      session?.dispose();
    }
  },
);

timedTest("subagent extension launches into a tmux window when the mode requests it", async () => {
  const cwd = await createTempDir("agent-subagent-window-mode-");
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();

  registerBuiltInModes(
    "test-subagent-window-mode",
    defineModesFile({
      version: 1,
      modes: {
        reviewer: {
          tools: ["read"],
          autoExit: true,
          tmuxTarget: "window",
        },
      },
    }),
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
    expect(
      readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
    ).toContain("Assigned task:\nInspect failing tests");
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest(
  "subagent extension propagates mode-specific idle timeout into the child bootstrap state",
  async () => {
    const cwd = await createTempDir("agent-subagent-timeout-mode-");
    let session: TestSession | undefined;
    const mux = new HarnessMuxAdapter();

    registerBuiltInModes(
      "test-subagent-timeout-mode",
      defineModesFile({
        version: 1,
        modes: {
          reviewer: {
            tools: ["read"],
            autoExit: true,
            autoExitTimeoutMs: 45,
          },
        },
      }),
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
      ).toMatch(/Assigned task:\\nInspect failing tests/);
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
  const cwd = await createTempDir("agent-prompt-stash-happy-");
  const agentDir = await createTempDir("agent-prompt-stash-agent-");
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
  const cwd = await createTempDir("agent-prompt-stash-heal-");
  const agentDir = await createTempDir("agent-prompt-stash-agent-");
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
  const cwd = await createTempDir("agent-prompt-stash-load-cap-");
  const agentDir = await createTempDir("agent-prompt-stash-agent-");
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
  const cwd = await createTempDir("agent-prompt-stash-cap-");
  const agentDir = await createTempDir("agent-prompt-stash-agent-");
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
  const cwd = await createTempDir("agent-prompt-stash-pop-");
  const agentDir = await createTempDir("agent-prompt-stash-agent-");
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

timedTest("pi-test-harness emits project_trust before final resources load", async () => {
  const cwd = await createTempDir("agent-harness-project-trust-");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "settings.json"), "{}\n");

  let projectTrustCalls = 0;
  let sessionStartCalls = 0;
  const trustExtension = (pi: ExtensionAPI) => {
    pi.on("project_trust", (event) => {
      projectTrustCalls += 1;
      expect(event.cwd).toBe(cwd);
      expect(sessionStartCalls).toBe(0);
      return { trusted: "yes", remember: true };
    });
    pi.on("session_start", () => {
      sessionStartCalls += 1;
    });
  };

  const harness = await createTestSession({ cwd, extensionFactories: [trustExtension] });
  try {
    expect(projectTrustCalls).toBe(1);
    expect(sessionStartCalls).toBe(1);
    expect(JSON.parse(readFileSync(join(cwd, "trust.json"), "utf8"))[cwd]).toBe(true);
  } finally {
    harness.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
