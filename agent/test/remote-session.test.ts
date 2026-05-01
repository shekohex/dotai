import { expect, test } from "vitest";
import { sign } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { parseSseStream } from "../src/remote/sse.ts";
import type {
  ExtensionFactory,
  ExtensionUIContext,
  LoadExtensionsResult,
  PromptTemplate,
  ResourceLoader,
  Skill,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { AuthService, createChallengePayload } from "../src/remote/auth.ts";
import { createRemoteApp } from "../src/remote/app.ts";
import { createV1Routes } from "../src/remote/routes.ts";
import { REMOTE_DEFAULT_CLIENT_CAPABILITIES } from "../src/remote/capabilities.ts";
import { SessionCatalogWatcher } from "../src/remote/session-catalog-watcher.ts";
import { cancelRemoteUiRequest, handleRemoteUiRequest } from "../src/remote/client/session-ui.ts";
import { InMemoryRemoteKvStore } from "../src/remote/kv/in-memory-store.ts";
import { RemoteApiClient } from "../src/remote/runtime-api/client.ts";
import { toRemoteSessionInfo } from "../src/remote/client/session-picker.ts";
import {
  hydrateExtensionStateFromKv,
  isKvManagedExtensionState,
  persistExtensionStateToKv,
  persistManagedExtensionState,
  type ExtensionStateKvClient,
} from "../src/remote/client/session/extension-state-kv.ts";
import { hasSessionPrimitiveCapability } from "../src/remote/session/capabilities.ts";
import { touchSessionPresence } from "../src/remote/session/presence-ops.ts";
import { createRemoteUiContext } from "../src/remote/session/ui-context.ts";
import {
  InMemoryPiRuntimeFactory,
  type RemoteRuntimeFactory,
} from "../src/remote/runtime-factory.ts";
import { createRemoteThemeFromContent } from "../src/remote/client/remote-theme.ts";
import { RemoteAgentSessionRuntime, createInProcessFetch } from "../src/remote/client-runtime.ts";
import { RemoteAgentSession } from "../src/remote/client/session.ts";
import {
  createRemoteRenameSessionHandler,
  parseRemoteArgs,
  resolveRemoteSessionId,
  resolveRemoteStartupSelection,
} from "../src/remote/client-interactive.ts";
import { loadThemeFromPath } from "../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {
  createBashToolOverrideDefinition,
  createReadToolOverrideDefinition,
} from "../src/extensions/coreui/tools.ts";
import { calculateTotalCost } from "../src/extensions/coreui/usage.ts";
import type { ClientCapabilities, Presence } from "../src/remote/schemas.ts";
import { SessionRegistry } from "../src/remote/session-registry.ts";
import { SessionCatalog } from "../src/remote/session-catalog.ts";
import { InMemoryDurableStreamStore, sessionEventsStreamId } from "../src/remote/streams.ts";
import { REMOTE_SESSION_VERSION_ENTRY } from "../src/remote/session/durable-runtime-state.ts";
import { assertType } from "../src/remote/typebox.ts";
import { createTempPersistedRuntimeHarness } from "./remote-runtime-test-helpers.ts";
import { TEST_ED25519_KEYS } from "./remote-test-keys.ts";

process.env.PI_REMOTE_ENABLE_LOGGER = "0";

const TEST_FAKE_RUNTIME_CWD = "/tmp/pi-remote-fake-runtime";

const TEST_TIMEOUT_MS = 15_000;

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

class FakeRuntimeFactory implements RemoteRuntimeFactory {
  async create() {
    return {
      cwd: TEST_FAKE_RUNTIME_CWD,
      dispose: async () => {},
    } as any;
  }

  async dispose(): Promise<void> {}
}

class SlowRuntimeFactory implements RemoteRuntimeFactory {
  readonly delayMs: number;
  createCalls = 0;

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  async create() {
    this.createCalls += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    return {
      cwd: TEST_FAKE_RUNTIME_CWD,
      dispose: async () => {},
    } as any;
  }

  async dispose(): Promise<void> {}
}

class CountingRuntimeFactory implements RemoteRuntimeFactory {
  readonly delegate: RemoteRuntimeFactory;
  createCalls = 0;
  loadCalls = 0;

  constructor(delegate: RemoteRuntimeFactory) {
    this.delegate = delegate;
  }

  async create(request?: { cwd?: string; persistence?: "persistent" | "ephemeral" }) {
    this.createCalls += 1;
    return this.delegate.create(request);
  }

  async load(input: { sessionId: string; sessionPath: string; cwd: string }) {
    this.loadCalls += 1;
    if (!this.delegate.load) {
      throw new Error("Delegate runtime factory cannot load sessions");
    }
    return this.delegate.load(input);
  }

  async dispose(): Promise<void> {
    await this.delegate.dispose();
  }

  getSessionCatalogRoot(): string | undefined {
    return this.delegate.getSessionCatalogRoot?.();
  }
}

class RecordingSession {
  cwd = "/tmp/pi-remote-recording-session";
  reloadCalls = 0;
  resourceReadCounts = {
    extensions: 0,
    skills: 0,
    prompts: 0,
    themes: 0,
    systemPrompt: 0,
    appendSystemPrompt: 0,
  };
  settingsStore: {
    global: Record<string, unknown>;
    project: Record<string, unknown>;
  } = {
    global: {},
    project: {},
  };
  private resourceMode: "empty" | "versioned" = "empty";
  private resourceVersion = 1;
  activeTools = ["read", "bash", "edit", "write"];
  model = {
    provider: "pi-remote-faux",
    id: "pi-remote-faux-1",
    name: "Pi Remote Faux 1",
    api: "responses",
    baseUrl: "http://localhost:0",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  thinkingLevel = "medium";
  isStreaming = false;
  isCompacting = false;
  isRetrying = false;
  autoCompactionEnabled = false;
  steeringMode: "all" | "one-at-a-time" = "all";
  followUpMode: "all" | "one-at-a-time" = "all";
  pendingMessageCount = 0;
  messages: unknown[] = [];
  sessionStats = {
    sessionFile: "/tmp/pi-remote-recording-session/session.jsonl",
    sessionId: "pi-remote-recording-session",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
    cost: 0,
    contextUsage: undefined as
      | { tokens: number | null; contextWindow: number; percent: number | null }
      | undefined,
  };
  state = {
    pendingToolCalls: new Set<string>(),
    errorMessage: undefined as string | undefined,
  };
  modelRegistry = {
    find: () => this.model,
    getAvailable: () => [this.model],
    getApiKeyAndHeaders: async () => ({
      ok: true as const,
      apiKey: "test-key",
      headers: undefined,
    }),
    isUsingOAuth: () => false,
  };
  promptCalls: Array<{ text: string; options?: Record<string, unknown> }> = [];
  promptError: Error | undefined;
  steerCalls: Array<{
    text: string;
    images?: Array<{ type: string; data: string; mimeType: string }>;
  }> = [];
  followUpCalls: Array<{
    text: string;
    images?: Array<{ type: string; data: string; mimeType: string }>;
  }> = [];
  queuedSteering: string[] = [];
  queuedFollowUp: string[] = [];
  clearQueueCalls = 0;
  compactCalls: string[] = [];
  navigateTreeCalls: Array<{
    targetId: string;
    summarize?: boolean;
    customInstructions?: string;
    replaceInstructions?: boolean;
    label?: string;
  }> = [];
  bashCalls: Array<{
    command: string;
    options?: { excludeFromContext?: boolean; operations?: unknown };
  }> = [];
  recordedBashResults: Array<{
    command: string;
    result: {
      output: string;
      exitCode: number | undefined;
      cancelled: boolean;
      truncated: boolean;
      fullOutputPath?: string;
    };
    options?: { excludeFromContext?: boolean };
  }> = [];
  pendingBashMessage:
    | {
        role: "bashExecution";
        command: string;
        output: string;
        exitCode: number | undefined;
        cancelled: boolean;
        truncated: boolean;
        fullOutputPath?: string;
        timestamp: number;
        excludeFromContext?: boolean;
      }
    | undefined;
  abortCompactionCalls = 0;
  abortBashCalls = 0;
  isBashRunning = false;
  hasPendingBashMessages = false;
  bindExtensionsError: Error | undefined;
  setModelError: Error | undefined;
  extensionRunner:
    | {
        getCommand: (name: string) => unknown;
        emit?: (event: unknown) => Promise<unknown>;
      }
    | undefined;
  remoteUiContext:
    | {
        input?: (title: string, placeholder?: string) => Promise<string | undefined>;
        setWorkingMessage?: (message?: string) => void;
        setHiddenThinkingLabel?: (label?: string) => void;
        setHeader?: (factory?: (...args: unknown[]) => unknown) => void;
        setFooter?: (factory?: (...args: unknown[]) => unknown) => void;
        setToolsExpanded?: (expanded: boolean) => void;
      }
    | undefined;
  sessionManager = {
    getCwd: () => this.cwd,
    getSessionId: () => this.sessionStats.sessionId,
    isPersisted: () => typeof this.sessionStats.sessionFile === "string",
    getSessionFile: () => this.sessionStats.sessionFile,
    getEntries: () => this.buildSessionEntries(),
    getLeafId: () => this.buildSessionEntries().at(-1)?.id ?? null,
  };
  settingsManager = {
    getDefaultProvider: () => this.defaultProvider,
    getDefaultModel: () => this.defaultModel,
    getDefaultThinkingLevel: () => this.defaultThinkingLevel,
    getEnabledModels: () => this.enabledModels,
    getTheme: () => this.readGlobalSetting<string>("theme"),
    getShowImages: () => this.readBooleanSetting("terminal", "showImages", true),
    getClearOnShrink: () => this.readBooleanSetting("terminal", "clearOnShrink", false),
    getEnableSkillCommands: () => this.readBooleanSetting("enableSkillCommands", undefined, true),
    getSteeringMode: () => this.readModeSetting("steeringMode"),
    getFollowUpMode: () => this.readModeSetting("followUpMode"),
    getCompactionEnabled: () => this.readNestedBooleanSetting("compaction", "enabled", false),
    getGlobalSettings: () => structuredClone(this.settingsStore.global),
    getProjectSettings: () => structuredClone(this.settingsStore.project),
    reload: async () => {},
    setDefaultProvider: (provider: string) => {
      this.defaultProvider = provider;
    },
    setDefaultModel: (modelId: string) => {
      this.defaultModel = modelId;
    },
    setDefaultModelAndProvider: (provider: string, modelId: string) => {
      this.defaultProvider = provider;
      this.defaultModel = modelId;
    },
    setDefaultThinkingLevel: (level: string) => {
      this.defaultThinkingLevel = level;
    },
    setEnabledModels: (patterns: string[] | undefined) => {
      this.enabledModels = patterns;
    },
    setTheme: (theme: string) => {
      this.writeGlobalSetting("theme", theme);
    },
    setShowImages: (show: boolean) => {
      this.writeNestedGlobalSetting("terminal", "showImages", show);
    },
    setClearOnShrink: (enabled: boolean) => {
      this.writeNestedGlobalSetting("terminal", "clearOnShrink", enabled);
    },
    setEnableSkillCommands: (enabled: boolean) => {
      this.writeGlobalSetting("enableSkillCommands", enabled);
    },
    setSteeringMode: (mode: "all" | "one-at-a-time") => {
      this.writeGlobalSetting("steeringMode", mode);
    },
    setFollowUpMode: (mode: "all" | "one-at-a-time") => {
      this.writeGlobalSetting("followUpMode", mode);
    },
    setCompactionEnabled: (enabled: boolean) => {
      this.writeNestedGlobalSetting("compaction", "enabled", enabled);
    },
  };
  resourceLoader: ResourceLoader = createRecordingResourceLoader(this);

  get defaultProvider(): string | undefined {
    return this.readGlobalSetting<string>("defaultProvider");
  }

  set defaultProvider(provider: string | undefined) {
    this.writeGlobalSetting("defaultProvider", provider);
  }

  get defaultModel(): string | undefined {
    return this.readGlobalSetting<string>("defaultModel");
  }

  set defaultModel(modelId: string | undefined) {
    this.writeGlobalSetting("defaultModel", modelId);
  }

  get defaultThinkingLevel(): string | undefined {
    return this.readGlobalSetting<string>("defaultThinkingLevel");
  }

  set defaultThinkingLevel(level: string | undefined) {
    this.writeGlobalSetting("defaultThinkingLevel", level);
  }

  get enabledModels(): string[] | undefined {
    const value = this.settingsStore.global.enabledModels;
    return Array.isArray(value) ? [...value] : undefined;
  }

  set enabledModels(patterns: string[] | undefined) {
    this.writeGlobalSetting("enabledModels", patterns ? [...patterns] : undefined);
  }

  enableVersionedResources(): void {
    this.resourceMode = "versioned";
    this.resourceVersion = 1;
  }

  getResourceVersion(): number {
    return this.resourceVersion;
  }

  getResourceMode(): "empty" | "versioned" {
    return this.resourceMode;
  }

  snapshotResourceReadCounts(): typeof this.resourceReadCounts {
    return { ...this.resourceReadCounts };
  }

  snapshotExpensiveResourceReadCounts(): Omit<typeof this.resourceReadCounts, "extensions"> {
    return {
      skills: this.resourceReadCounts.skills,
      prompts: this.resourceReadCounts.prompts,
      themes: this.resourceReadCounts.themes,
      systemPrompt: this.resourceReadCounts.systemPrompt,
      appendSystemPrompt: this.resourceReadCounts.appendSystemPrompt,
    };
  }

  buildSessionEntries(): Array<{
    type: "message";
    id: string;
    parentId: string | null;
    timestamp: string;
    message: (typeof this.messages)[number];
  }> {
    return this.messages.map((message, index) => ({
      type: "message",
      id: `message-${index + 1}`,
      parentId: index === 0 ? null : `message-${index}`,
      timestamp: new Date(index).toISOString(),
      message,
    }));
  }

  getActiveToolNames(): string[] {
    return [...this.activeTools];
  }

  getAllTools(): Array<{
    name: string;
    description: string;
    parameters: unknown;
    sourceInfo: unknown;
  }> {
    return this.activeTools.map((toolName) => ({
      name: toolName,
      description: `${toolName} tool`,
      parameters: {},
      sourceInfo: { source: "test" },
    }));
  }

  setActiveToolsByName(toolNames: string[]): void {
    this.activeTools = [...toolNames];
  }

  getToolDefinition(name: string) {
    if (name === "read") {
      return createReadToolOverrideDefinition();
    }
    if (name === "bash") {
      return createBashToolOverrideDefinition();
    }
    return {
      name,
      label: name,
      description: `${name} tool`,
      parameters: {},
      async execute() {
        return { content: [] };
      },
    };
  }

  async bindExtensions(bindings?: {
    uiContext?: {
      input: (title: string, placeholder?: string) => Promise<string | undefined>;
    };
  }): Promise<void> {
    if (this.bindExtensionsError) {
      throw this.bindExtensionsError;
    }
    this.remoteUiContext = bindings?.uiContext;
  }

  subscribe(): () => void {
    return () => {};
  }

  async prompt(text: string, options?: Record<string, unknown>): Promise<void> {
    if (this.promptError) {
      throw this.promptError;
    }
    if (this.pendingBashMessage) {
      this.messages.push(this.pendingBashMessage);
      this.sessionStats.totalMessages += 1;
      this.pendingBashMessage = undefined;
      this.hasPendingBashMessages = false;
    }
    this.promptCalls.push({ text, options });
    if (options?.streamingBehavior === "followUp") {
      this.queuedFollowUp.push(text);
      this.pendingMessageCount += 1;
    }
  }

  async steer(
    text: string,
    images?: Array<{ type: string; data: string; mimeType: string }>,
  ): Promise<void> {
    this.steerCalls.push({ text, images });
    this.queuedSteering.push(text);
    this.pendingMessageCount += 1;
  }

  async followUp(
    text: string,
    images?: Array<{ type: string; data: string; mimeType: string }>,
  ): Promise<void> {
    this.followUpCalls.push({ text, images });
    this.queuedFollowUp.push(text);
    this.pendingMessageCount += 1;
  }

  async reload(): Promise<void> {
    this.reloadCalls += 1;
    if (this.resourceMode === "versioned") {
      this.resourceVersion += 1;
    }
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    this.clearQueueCalls += 1;
    const steering = [...this.queuedSteering];
    const followUp = [...this.queuedFollowUp];
    this.queuedSteering = [];
    this.queuedFollowUp = [];
    this.pendingMessageCount = 0;
    return {
      steering,
      followUp,
    };
  }

  async abort(): Promise<void> {}

  async compact(customInstructions?: string): Promise<{
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
  }> {
    this.compactCalls.push(customInstructions ?? "");
    this.isCompacting = true;
    this.sessionStats.totalMessages += 1;
    this.isCompacting = false;
    return {
      summary: customInstructions ?? "compacted",
      firstKeptEntryId: "entry-1",
      tokensBefore: 42,
      details: { source: "test" },
    };
  }

  abortCompaction(): void {
    this.abortCompactionCalls += 1;
    this.isCompacting = false;
  }

  async navigateTree(
    targetId: string,
    options?: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    },
  ): Promise<{
    editorText?: string;
    cancelled: boolean;
    aborted?: boolean;
    summaryEntry?: unknown;
  }> {
    this.navigateTreeCalls.push({
      targetId,
      summarize: options?.summarize,
      customInstructions: options?.customInstructions,
      replaceInstructions: options?.replaceInstructions,
      label: options?.label,
    });
    return {
      editorText: `navigated:${targetId}`,
      cancelled: false,
      summaryEntry: options?.summarize
        ? {
            type: "branch_summary",
            id: "summary-1",
            parentId: targetId,
            timestamp: new Date(0).toISOString(),
            fromId: "from-1",
            summary: "summary-1",
          }
        : undefined,
    };
  }

  async executeBash(
    command: string,
    onChunk?: (chunk: string) => void,
    options?: { excludeFromContext?: boolean; operations?: unknown },
  ): Promise<{
    output: string;
    exitCode: number | undefined;
    cancelled: boolean;
    truncated: boolean;
    fullOutputPath?: string;
  }> {
    this.bashCalls.push({ command, options });
    this.isBashRunning = true;
    onChunk?.("ran:");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    onChunk?.(command);
    this.sessionStats.totalMessages += 1;
    this.messages.push({
      role: "bashExecution",
      command,
      output: `ran:${command}`,
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: Date.now(),
      excludeFromContext: options?.excludeFromContext,
    });
    this.isBashRunning = false;
    this.hasPendingBashMessages = false;
    return {
      output: `ran:${command}`,
      exitCode: 0,
      cancelled: false,
      truncated: false,
    };
  }

  abortBash(): void {
    this.abortBashCalls += 1;
    this.isBashRunning = false;
  }

  recordBashResult(
    command: string,
    result: {
      output: string;
      exitCode: number | undefined;
      cancelled: boolean;
      truncated: boolean;
      fullOutputPath?: string;
    },
    options?: { excludeFromContext?: boolean },
  ): void {
    this.recordedBashResults.push({ command, result, options });
    const bashMessage = {
      role: "bashExecution" as const,
      command,
      output: result.output,
      exitCode: result.exitCode,
      cancelled: result.cancelled,
      truncated: result.truncated,
      fullOutputPath: result.fullOutputPath,
      timestamp: Date.now(),
      excludeFromContext: options?.excludeFromContext,
    };
    if (this.isStreaming) {
      this.pendingBashMessage = bashMessage;
      this.hasPendingBashMessages = true;
      return;
    }

    this.messages.push(bashMessage);
    this.sessionStats.totalMessages += 1;
    this.hasPendingBashMessages = false;
  }

  async setModel(model: { provider: string; id: string }): Promise<void> {
    if (this.setModelError) {
      throw this.setModelError;
    }
    this.model = {
      ...this.model,
      ...model,
      name: `${model.provider}/${model.id}`,
    };
  }

  setThinkingLevel(level: string): void {
    this.thinkingLevel = level;
  }

  setSteeringMode(mode: "all" | "one-at-a-time"): void {
    this.steeringMode = mode;
    this.settingsManager.setSteeringMode(mode);
  }

  setFollowUpMode(mode: "all" | "one-at-a-time"): void {
    this.followUpMode = mode;
    this.settingsManager.setFollowUpMode(mode);
  }

  setAutoCompactionEnabled(enabled: boolean): void {
    this.autoCompactionEnabled = enabled;
    this.settingsManager.setCompactionEnabled(enabled);
  }

  getContextUsage() {
    return this.sessionStats.contextUsage;
  }

  getSessionStats() {
    return {
      ...this.sessionStats,
      tokens: {
        input: this.sessionStats.tokens.input,
        output: this.sessionStats.tokens.output,
        cacheRead: this.sessionStats.tokens.cacheRead,
        cacheWrite: this.sessionStats.tokens.cacheWrite,
        total: this.sessionStats.tokens.total,
      },
      ...(this.sessionStats.contextUsage
        ? { contextUsage: { ...this.sessionStats.contextUsage } }
        : {}),
    };
  }

  setSessionName(): void {}

  private readGlobalSetting<T>(key: string): T | undefined {
    const value = this.settingsStore.global[key];
    return value as T | undefined;
  }

  private readModeSetting(key: string): "all" | "one-at-a-time" {
    const value = this.settingsStore.global[key];
    return value === "one-at-a-time" ? "one-at-a-time" : "all";
  }

  private readBooleanSetting(
    key: string,
    nestedKey: string | undefined,
    fallback: boolean,
  ): boolean {
    if (nestedKey === undefined) {
      return typeof this.settingsStore.global[key] === "boolean"
        ? (this.settingsStore.global[key] as boolean)
        : fallback;
    }

    return this.readNestedBooleanSetting(key, nestedKey, fallback);
  }

  private readNestedBooleanSetting(key: string, nestedKey: string, fallback: boolean): boolean {
    const parent = this.settingsStore.global[key];
    if (parent && typeof parent === "object" && !Array.isArray(parent) && nestedKey in parent) {
      const value = (parent as Record<string, unknown>)[nestedKey];
      return typeof value === "boolean" ? value : fallback;
    }
    return fallback;
  }

  private writeGlobalSetting(key: string, value: unknown): void {
    if (value === undefined) {
      delete this.settingsStore.global[key];
      return;
    }
    this.settingsStore.global[key] = value;
  }

  private writeNestedGlobalSetting(key: string, nestedKey: string, value: unknown): void {
    const current = this.settingsStore.global[key];
    const parent = current && typeof current === "object" && !Array.isArray(current) ? current : {};
    this.settingsStore.global[key] = {
      ...parent,
      [nestedKey]: value,
    };
  }
}

class RacyPromptSession extends RecordingSession {
  private promptInFlight = false;
  private readonly startupTurns: number;

  constructor(startupTurns = 80) {
    super();
    this.startupTurns = startupTurns;
  }

  override async prompt(text: string, options?: Record<string, unknown>): Promise<void> {
    this.promptCalls.push({ text, options });

    if (this.isStreaming) {
      if (options?.streamingBehavior !== "followUp") {
        throw new Error("already processing");
      }
      this.pendingMessageCount += 1;
      return;
    }

    if (this.promptInFlight) {
      throw new Error("already processing");
    }

    this.promptInFlight = true;
    for (let turn = 0; turn < this.startupTurns; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.isStreaming = true;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    this.isStreaming = false;
    this.pendingMessageCount = 0;
    this.promptInFlight = false;
  }
}

class BlockingPromptSession extends RecordingSession {
  private releasePromptStart: (() => void) | undefined;
  abortCalls = 0;
  dispatchOrder: string[] = [];

  override async prompt(text: string, options?: Record<string, unknown>): Promise<void> {
    this.promptCalls.push({ text, options });
    this.dispatchOrder.push("prompt");
    await new Promise<void>((resolve) => {
      this.releasePromptStart = resolve;
    });
  }

  releasePrompt(): void {
    this.releasePromptStart?.();
    this.releasePromptStart = undefined;
  }

  override async abort(): Promise<void> {
    this.dispatchOrder.push("interrupt");
    this.abortCalls += 1;
  }

  override async steer(
    text: string,
    images?: Array<{ type: string; data: string; mimeType: string }>,
  ): Promise<void> {
    this.dispatchOrder.push("steer");
    await super.steer(text, images);
  }
}

class UiRequestPromptSession extends RecordingSession {
  uiAnswers: Array<string | undefined> = [];

  override async prompt(text: string, options?: Record<string, unknown>): Promise<void> {
    if (this.remoteUiContext?.input) {
      const answer = await this.remoteUiContext.input("Remote question", "type answer");
      this.uiAnswers.push(answer);
    }
    await super.prompt(text, options);
  }
}

class RuntimeExtensionEventsPromptSession extends RecordingSession {
  private readonly listeners = new Set<(event: unknown) => void>();

  override subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  override async prompt(text: string, options?: Record<string, unknown>): Promise<void> {
    await super.prompt(text, options);
    this.emit({
      type: "queue_update",
      steering: ["queued-steer"],
      followUp: ["queued-follow-up"],
    });
    this.emit({
      type: "compaction_start",
      reason: "manual",
    });
    this.emit({
      type: "compaction_end",
      reason: "manual",
      result: undefined,
      aborted: false,
      willRetry: false,
    });
    this.emit({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 100,
      errorMessage: "simulated retry",
    });
    this.emit({
      type: "auto_retry_end",
      success: false,
      attempt: 1,
      finalError: "simulated retry",
    });
  }
}

class AgentLifecyclePromptSession extends RecordingSession {
  private readonly listeners = new Set<(event: unknown) => void>();

  override subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  override async prompt(text: string, options?: Record<string, unknown>): Promise<void> {
    await super.prompt(text, options);
    this.emit({ type: "agent_start" });
    this.emit({ type: "agent_end", messages: [] });
  }
}

class ImmediateAssistantPromptSession extends RecordingSession {
  private readonly listeners = new Set<(event: unknown) => void>();

  override subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  override async prompt(text: string, options?: Record<string, unknown>): Promise<void> {
    await super.prompt(text, options);
    this.sessionStats.totalMessages += 1;
    this.messages.push({
      role: "assistant",
      content: [{ type: "text", text: `reply:${text}` }],
      timestamp: Date.now(),
    });
    this.emit({ type: "agent_start" });
    this.emit({ type: "agent_end", messages: [] });
  }
}

class PassiveExtensionEventsPromptSession extends RecordingSession {
  constructor() {
    super();
    this.modelRegistry = {
      ...this.modelRegistry,
      find: (provider: string, id: string) => ({
        ...this.model,
        provider,
        id,
        name: `${provider}/${id}`,
      }),
    };
    this.extensionRunner = {
      getCommand: () => undefined,
      emit: async () => undefined,
    };
  }

  override async prompt(text: string, options?: Record<string, unknown>): Promise<void> {
    await super.prompt(text, options);
    await this.extensionRunner?.emit?.({
      type: "session_compact",
      compactionEntry: {
        id: "compaction-1",
        type: "compaction",
        parentId: null,
        timestamp: Date.now(),
        summary: "summary",
        firstKeptEntryId: "message-1",
        tokensBefore: 42,
        details: undefined,
        fromExtension: false,
      },
      fromExtension: false,
    });
    await this.extensionRunner?.emit?.({
      type: "session_tree",
      newLeafId: "leaf-2",
      oldLeafId: "leaf-1",
      summaryEntry: undefined,
      fromExtension: false,
    });
  }

  override async setModel(model: { provider: string; id: string }): Promise<void> {
    const previousModel = this.model;
    await super.setModel(model);
    await this.extensionRunner?.emit?.({
      type: "model_select",
      model: this.model,
      previousModel,
      source: "set",
    });
  }
}

class UiPrimitivesPromptSession extends RecordingSession {
  headerError: string | undefined;
  footerError: string | undefined;

  override async prompt(text: string, options?: Record<string, unknown>): Promise<void> {
    this.remoteUiContext?.setWorkingMessage?.("remote-working");
    this.remoteUiContext?.setWorkingIndicator?.({
      frames: ["remote-indicator"],
      intervalMs: 321,
    });
    this.remoteUiContext?.setHiddenThinkingLabel?.("remote-hidden-thinking");
    this.remoteUiContext?.setToolsExpanded?.(false);
    try {
      this.remoteUiContext?.setHeader?.(() => ({
        render: () => ["remote-header"],
        invalidate: () => {},
      }));
    } catch (error) {
      this.headerError = error instanceof Error ? error.message : String(error);
    }
    try {
      this.remoteUiContext?.setFooter?.(() => ({
        render: () => ["remote-footer"],
        invalidate: () => {},
      }));
    } catch (error) {
      this.footerError = error instanceof Error ? error.message : String(error);
    }
    await super.prompt(text, options);
  }
}

function createRecordingResourceLoader(session: RecordingSession): ResourceLoader {
  return {
    getExtensions: (): LoadExtensionsResult => {
      session.resourceReadCounts.extensions += 1;
      return {
        extensions:
          session.getResourceMode() === "versioned" ? [buildRecordingExtension(session)] : [],
        errors: [],
        runtime: createRecordingExtensionRuntime(),
      };
    },
    getSkills: () => {
      session.resourceReadCounts.skills += 1;
      return {
        skills: session.getResourceMode() === "versioned" ? [buildRecordingSkill(session)] : [],
        diagnostics: [],
      };
    },
    getPrompts: () => {
      session.resourceReadCounts.prompts += 1;
      return {
        prompts: session.getResourceMode() === "versioned" ? [buildRecordingPrompt(session)] : [],
        diagnostics: [],
      };
    },
    getThemes: () => {
      session.resourceReadCounts.themes += 1;
      return {
        themes: session.getResourceMode() === "versioned" ? [buildRecordingTheme(session)] : [],
        diagnostics: [],
      };
    },
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => {
      session.resourceReadCounts.systemPrompt += 1;
      return session.getResourceMode() === "versioned"
        ? `system-${session.getResourceVersion()}`
        : undefined;
    },
    getAppendSystemPrompt: () => {
      session.resourceReadCounts.appendSystemPrompt += 1;
      return session.getResourceMode() === "versioned"
        ? [`append-${session.getResourceVersion()}`]
        : [];
    },
    extendResources: () => {},
    reload: async () => {
      await session.reload();
    },
  };
}

function createRecordingExtensionRuntime(): LoadExtensionsResult["runtime"] {
  return {
    flagValues: new Map(),
    pendingProviderRegistrations: [],
    registerProvider: () => {},
    unregisterProvider: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    refreshTools: () => {},
    getCommands: () => [],
    setModel: async () => false,
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
  };
}

function buildRecordingExtension(
  session: RecordingSession,
): LoadExtensionsResult["extensions"][number] {
  const version = session.getResourceVersion();
  return {
    path: `extension-v${version}`,
    resolvedPath: `extension-v${version}`,
    sourceInfo: {
      path: `extension-v${version}`,
      source: "test",
      scope: "temporary",
      origin: "top-level",
    },
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

function buildRecordingSkill(session: RecordingSession): Skill {
  const version = session.getResourceVersion();
  return {
    name: `skill-v${version}`,
    description: `skill version ${version}`,
    filePath: `/tmp/skill-v${version}/SKILL.md`,
    baseDir: `/tmp/skill-v${version}`,
    sourceInfo: {
      path: `/tmp/skill-v${version}/SKILL.md`,
      source: "test",
      scope: "temporary",
      origin: "top-level",
    },
    disableModelInvocation: false,
  };
}

function buildRecordingPrompt(session: RecordingSession): PromptTemplate {
  const version = session.getResourceVersion();
  return {
    name: `prompt-v${version}`,
    description: `prompt version ${version}`,
    filePath: `/tmp/prompt-v${version}.md`,
    content: `prompt version ${version}`,
    sourceInfo: {
      path: `/tmp/prompt-v${version}.md`,
      source: "test",
      scope: "temporary",
      origin: "top-level",
    },
  };
}

function buildRecordingTheme(session: RecordingSession): Theme {
  const themePath =
    session.getResourceVersion() % 2 === 0
      ? join(
          process.cwd(),
          "node_modules",
          "@mariozechner",
          "pi-coding-agent",
          "dist",
          "modes",
          "interactive",
          "theme",
          "light.json",
        )
      : join(
          process.cwd(),
          "node_modules",
          "@mariozechner",
          "pi-coding-agent",
          "dist",
          "modes",
          "interactive",
          "theme",
          "dark.json",
        );
  return loadThemeFromPath(themePath);
}

class RecordingRuntimeFactory implements RemoteRuntimeFactory {
  readonly session: RecordingSession;
  runtimeDisposeCalls = 0;
  loadCalls = 0;

  constructor(session: RecordingSession) {
    this.session = session;
  }

  async create(request?: { cwd?: string; persistence?: "persistent" | "ephemeral" }) {
    if (request?.cwd) {
      this.session.cwd = request.cwd;
    }
    return {
      session: this.session,
      dispose: async () => {
        this.runtimeDisposeCalls += 1;
      },
    } as any;
  }

  async load() {
    this.loadCalls += 1;
    return {
      session: this.session,
      dispose: async () => {
        this.runtimeDisposeCalls += 1;
      },
    } as any;
  }

  async dispose(): Promise<void> {}
}

class NoLoadRecordingRuntimeFactory implements RemoteRuntimeFactory {
  readonly session: RecordingSession;
  runtimeDisposeCalls = 0;

  constructor(session: RecordingSession) {
    this.session = session;
  }

  async create(request?: { cwd?: string; persistence?: "persistent" | "ephemeral" }) {
    if (request?.cwd) {
      this.session.cwd = request.cwd;
    }
    return {
      session: this.session,
      dispose: async () => {
        this.runtimeDisposeCalls += 1;
      },
    } as any;
  }

  async dispose(): Promise<void> {}
}

class SequencedRecordingRuntimeFactory implements RemoteRuntimeFactory {
  readonly sessions: RecordingSession[];
  runtimeDisposeCalls = 0;
  createCalls = 0;

  constructor(sessions: RecordingSession[]) {
    this.sessions = sessions;
  }

  async create(request?: { cwd?: string; persistence?: "persistent" | "ephemeral" }) {
    const session = this.sessions[this.createCalls] ?? this.sessions[this.sessions.length - 1];
    this.createCalls += 1;
    if (request?.cwd) {
      session.cwd = request.cwd;
    }
    return {
      session,
      dispose: async () => {
        this.runtimeDisposeCalls += 1;
      },
    } as any;
  }

  async dispose(): Promise<void> {}
}

class FailingDisposeRuntimeFactory implements RemoteRuntimeFactory {
  async create(request?: { cwd?: string; persistence?: "persistent" | "ephemeral" }) {
    const session = new RecordingSession();
    if (request?.cwd) {
      session.cwd = request.cwd;
    }
    return {
      session,
      dispose: async () => {
        throw new Error("dispose failed");
      },
    } as any;
  }

  async dispose(): Promise<void> {}
}

class ThrowingAppEventStreamStore extends InMemoryDurableStreamStore {
  override append(streamId: string, input: Parameters<InMemoryDurableStreamStore["append"]>[1]) {
    if (streamId === "app-events" && input.kind === "session_closed") {
      throw new Error("append failed");
    }
    return super.append(streamId, input);
  }
}

function testAuthSession() {
  return {
    token: "token-dev",
    clientId: "dev",
    keyId: "dev",
    expiresAt: Date.now() + 60_000,
  };
}

async function createRemoteRuntime(
  app: ReturnType<typeof createRemoteApp>["app"],
  options: {
    privateKeyPem: string;
    sessionId?: string;
    cwd?: string;
    workspaceCwd?: string;
    clientExtensionMetadata?: Array<{ id: string; runtime: "client"; path: string }>;
    clientExtensionFactories?: ExtensionFactory[];
  },
) {
  const workspaceCwd = options.workspaceCwd ?? (options.sessionId ? undefined : options.cwd);
  return RemoteAgentSessionRuntime.create({
    origin: "http://localhost:3000",
    auth: {
      keyId: "dev",
      privateKey: options.privateKeyPem,
    },
    clientCapabilities: REMOTE_DEFAULT_CLIENT_CAPABILITIES,
    ...(options.sessionId ? {} : { createNewSession: true }),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(workspaceCwd ? { workspaceCwd } : {}),
    ...(options.clientExtensionMetadata
      ? { clientExtensionMetadata: options.clientExtensionMetadata }
      : {}),
    ...(options.clientExtensionFactories
      ? { clientExtensionFactories: options.clientExtensionFactories }
      : {}),
    fetchImpl: createInProcessFetch(app),
  });
}

async function authenticate(
  app: ReturnType<typeof createRemoteApp>["app"],
  privateKey: string,
  keyId = "dev",
) {
  const challengeResponse = await app.request("/v1/auth/challenge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ keyId }),
  });
  expect(challengeResponse.status).toBe(200);
  const challenge = (await challengeResponse.json()) as {
    challengeId: string;
    nonce: string;
    origin: string;
    expiresAt: number;
  };

  const signature = sign(
    null,
    Buffer.from(
      createChallengePayload({
        challengeId: challenge.challengeId,
        keyId,
        nonce: challenge.nonce,
        origin: challenge.origin,
        expiresAt: challenge.expiresAt,
      }),
    ),
    privateKey,
  ).toString("base64");

  const verifyResponse = await app.request("/v1/auth/verify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      keyId,
      signature,
    }),
  });

  expect(verifyResponse.status).toBe(200);
  const verified = (await verifyResponse.json()) as { token: string };
  return verified.token;
}

async function postSessionCommand(
  app: ReturnType<typeof createRemoteApp>["app"],
  path: string,
  token: string,
  body: unknown,
) {
  const response = await app.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return response;
}

async function writeRemoteKvValue(input: {
  app: ReturnType<typeof createRemoteApp>["app"];
  token: string;
  scope: "global" | "user";
  namespace: string;
  key: string;
  value: unknown;
}): Promise<{ value: unknown; updatedAt: number }> {
  const response = await input.app.request(
    `/v1/kv/${input.scope}/${encodeURIComponent(input.namespace)}/${encodeURIComponent(input.key)}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ value: input.value }),
    },
  );

  expect(response.status).toBe(200);
  return (await response.json()) as { value: unknown; updatedAt: number };
}

async function readRemoteKvValue(input: {
  app: ReturnType<typeof createRemoteApp>["app"];
  token: string;
  scope: "global" | "user";
  namespace: string;
  key: string;
}): Promise<{ found: boolean; value?: unknown; updatedAt?: number }> {
  const response = await input.app.request(
    `/v1/kv/${input.scope}/${encodeURIComponent(input.namespace)}/${encodeURIComponent(input.key)}`,
    {
      headers: {
        authorization: `Bearer ${input.token}`,
      },
    },
  );

  expect(response.status).toBe(200);
  return (await response.json()) as { found: boolean; value?: unknown; updatedAt?: number };
}

async function readSessionEvents(
  app: ReturnType<typeof createRemoteApp>["app"],
  token: string,
  sessionId: string,
  offset: string,
  timeoutMs = 250,
): Promise<{
  events: Array<{ kind: string; payload: any; streamOffset: string }>;
  nextOffset: string;
}> {
  const response = await app.request(`/v1/sessions/${sessionId}/sync`, {
    headers: { authorization: `Bearer ${token}` },
  });

  expect(response.status).toBe(200);
  const stream = response.body;
  expect(stream).toBeTruthy();
  if (!stream) {
    return { events: [], nextOffset: offset };
  }

  const events: Array<{ kind: string; payload: any; streamOffset: string }> = [];
  let nextOffset = offset;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for await (const event of parseSseStream(stream, controller.signal)) {
      if (event.type !== "data") {
        continue;
      }
      const payload = JSON.parse(event.data) as {
        type: string;
        version?: string;
        patch?: { patchType: string; payload: unknown };
      };
      if (
        payload.type !== "patch" ||
        payload.version === undefined ||
        compareDurableVersions(payload.version, offset) <= 0
      ) {
        continue;
      }
      nextOffset = payload.version;
      const mapped = mapSyncPatchToEnvelope(payload.version, payload.patch);
      if (mapped !== undefined) {
        events.push(mapped);
      }
    }
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "AbortError") {
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }

  return { events, nextOffset };
}

async function waitForSessionEvent(
  app: ReturnType<typeof createRemoteApp>["app"],
  token: string,
  sessionId: string,
  offset: string,
  predicate: (event: { kind: string; payload: any; streamOffset: string }) => boolean,
): Promise<{
  event: { kind: string; payload: any; streamOffset: string };
  nextOffset: string;
}> {
  let nextOffset = offset;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const read = await readSessionEvents(app, token, sessionId, nextOffset, 250);
    nextOffset = read.nextOffset;
    const matched = read.events.find(predicate);
    if (matched) {
      return {
        event: matched,
        nextOffset,
      };
    }
  }
  throw new Error("Timed out waiting for session event");
}

async function waitForValue<T>(
  read: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  attempts = 30,
  delayMs = 10,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read();
    if (predicate(value)) {
      return value;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error("Timed out waiting for value");
}

function mapSyncPatchToEnvelope(
  streamOffset: string,
  patch: { patchType: string; payload: unknown } | undefined,
): { kind: string; payload: any; streamOffset: string } | undefined {
  if (patch === undefined) {
    return undefined;
  }

  switch (patch.patchType) {
    case "agent.lifecycle":
    case "assistant.message":
    case "tool.execution":
    case "queue.update":
    case "retry.status":
      return { kind: "agent_session_event", payload: patch.payload, streamOffset };
    case "session.state":
      return { kind: "session_state_patch", payload: patch.payload, streamOffset };
    case "extension.custom":
      return { kind: "extension_custom_event", payload: patch.payload, streamOffset };
    case "extension.event":
      return { kind: "extension_event", payload: patch.payload, streamOffset };
    case "extension.ui.request":
      return { kind: "extension_ui_request", payload: patch.payload, streamOffset };
    case "extension.ui.resolved":
      return { kind: "extension_ui_resolved", payload: patch.payload, streamOffset };
    case "command.accepted":
      return { kind: "command_accepted", payload: patch.payload, streamOffset };
    case "bash.start":
      return { kind: "bash_start", payload: patch.payload, streamOffset };
    case "bash.chunk":
      return { kind: "bash_chunk", payload: patch.payload, streamOffset };
    case "bash.end":
      return { kind: "bash_end", payload: patch.payload, streamOffset };
    case "bash.flush":
      return { kind: "bash_flush", payload: patch.payload, streamOffset };
    case "extension.error":
      return { kind: "extension_error", payload: patch.payload, streamOffset };
    default:
      return undefined;
  }
}

async function writeSessionFile(input: {
  sessionPath: string;
  sessionId: string;
  cwd: string;
  sessionName?: string;
  firstUserMessage?: string;
  parentSessionPath?: string;
  durableVersion?: number;
}): Promise<void> {
  await mkdir(dirname(input.sessionPath), { recursive: true });
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: input.sessionId,
      timestamp: new Date().toISOString(),
      cwd: input.cwd,
      ...(input.parentSessionPath ? { parentSession: input.parentSessionPath } : {}),
    }),
    JSON.stringify({
      type: "session_info",
      name: input.sessionName ?? input.sessionId,
    }),
  ];
  if (input.firstUserMessage !== undefined) {
    lines.push(
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: input.firstUserMessage }],
        },
      }),
    );
  }
  if (input.durableVersion !== undefined) {
    lines.push(
      JSON.stringify({
        type: "custom",
        id: `${input.sessionId}-version`,
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: REMOTE_SESSION_VERSION_ENTRY,
        data: {
          version: input.durableVersion,
          updatedAt: Date.now(),
        },
      }),
    );
  }
  await writeFile(input.sessionPath, [...lines, ""].join("\n"));
}

function compareDurableVersions(left: string, right: string | undefined): number {
  if (right === undefined) {
    return 1;
  }
  const leftVersion = BigInt(left);
  const rightVersion = BigInt(right);
  if (leftVersion < rightVersion) {
    return -1;
  }
  if (leftVersion > rightVersion) {
    return 1;
  }
  return 0;
}

timedTest("archive and delete updates are visible to multiple remote clients", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const originalCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "pi-remote-multi-client-lifecycle-"));
  const agentDir = join(root, "agent");
  const workspaceDir = join(root, "workspace");

  await mkdir(workspaceDir, { recursive: true });

  try {
    const remote = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: InMemoryPiRuntimeFactory({
        cwd: workspaceDir,
        agentDir,
        persistSessions: true,
      }),
    });

    try {
      const tokenA = await authenticate(remote.app, privateKeyPem);
      const tokenB = await authenticate(remote.app, privateKeyPem);

      const createResponse = await remote.app.request("/v1/sessions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenA}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionName: "Shared Session" }),
      });
      expect(createResponse.status).toBe(201);
      const sessionId = ((await createResponse.json()) as { sessionId: string }).sessionId;

      const apiClient = new RemoteApiClient({
        origin: "http://localhost:3000",
        auth: {
          keyId: "dev",
          privateKey: privateKeyPem,
        },
        fetchImpl: createInProcessFetch(remote.app),
      });
      await apiClient.authenticate();

      const promptResponse = await remote.app.request(`/v1/sessions/${sessionId}/prompt`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenA}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "Persist before archive" }),
      });
      expect(promptResponse.status).toBe(202);
      await waitForRemoteSessionMessageCount(apiClient, sessionId, 2);

      const archiveResponse = await remote.app.request(`/v1/sessions/${sessionId}/archive`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(archiveResponse.status).toBe(200);

      const archivedSnapshotA = await remote.app.request("/v1/app/snapshot", {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      const archivedSnapshotB = await remote.app.request("/v1/app/snapshot", {
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(archivedSnapshotA.status).toBe(200);
      expect(archivedSnapshotB.status).toBe(200);
      expect(
        (
          (await archivedSnapshotA.json()) as {
            sessionSummaries: Array<{ lifecycle: { state: string } }>;
          }
        ).sessionSummaries[0]?.lifecycle.state,
      ).toBe("archived");
      expect(
        (
          (await archivedSnapshotB.json()) as {
            sessionSummaries: Array<{ lifecycle: { state: string } }>;
          }
        ).sessionSummaries[0]?.lifecycle.state,
      ).toBe("archived");

      const deleteResponse = await remote.app.request(`/v1/sessions/${sessionId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(deleteResponse.status).toBe(200);

      const deletedSnapshotA = await remote.app.request("/v1/app/snapshot", {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      const deletedSnapshotB = await remote.app.request("/v1/app/snapshot", {
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(deletedSnapshotA.status).toBe(200);
      expect(deletedSnapshotB.status).toBe(200);
      expect(
        ((await deletedSnapshotA.json()) as { sessionSummaries: Array<{ sessionId: string }> })
          .sessionSummaries,
      ).toEqual([]);
      expect(
        ((await deletedSnapshotB.json()) as { sessionSummaries: Array<{ sessionId: string }> })
          .sessionSummaries,
      ).toEqual([]);
    } finally {
      await remote.dispose();
    }
  } finally {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

timedTest("session registry reloads idle runtime after external file change", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-idle-reload-"));
  const catalogRoot = join(root, "sessions");
  const session = new RecordingSession();
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const catalog = new SessionCatalog({ rootDir: catalogRoot });
  const registry = new SessionRegistry({
    streams: new InMemoryDurableStreamStore(),
    runtimeFactory,
    catalog,
  });
  const auth = testAuthSession();
  const sessionPath = join(catalogRoot, "idle-session.jsonl");

  session.sessionStats.sessionId = "idle-session";
  session.sessionStats.sessionFile = sessionPath;
  session.sessionManager = {
    ...session.sessionManager,
    getSessionId: () => "idle-session",
    getSessionFile: () => sessionPath,
  };
  session.enableVersionedResources();

  try {
    await writeSessionFile({
      sessionPath,
      sessionId: "idle-session",
      cwd: "/srv/idle-v1",
      sessionName: "Idle Session",
    });

    const created = await registry.createSession(
      { workspaceCwd: "/srv/idle-v1", sessionName: "Idle Session" },
      auth,
      "conn-a",
    );

    expect(created.sessionId).toBe("idle-session");
    expect(session.reloadCalls).toBe(0);

    await writeSessionFile({
      sessionPath,
      sessionId: "idle-session",
      cwd: "/srv/idle-v2",
      sessionName: "Idle Session Updated",
    });
    session.cwd = "/srv/idle-v2";

    await registry.reconcileCatalogFromDisk();

    const summary = registry.getSessionSummary("idle-session");
    expect(session.reloadCalls).toBe(1);
    expect(summary.sessionName).toBe("Idle Session Updated");
    expect(summary.cwd).toBe("/srv/idle-v2");
  } finally {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

timedTest("session registry evicts idle persistent runtime and reloads on demand", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-idle-evict-"));
  const catalogRoot = join(root, "sessions");
  const session = new RecordingSession();
  const runtimeFactory = new RecordingRuntimeFactory(session);
  let currentTime = 1_000;
  const registry = new SessionRegistry({
    streams: new InMemoryDurableStreamStore(),
    runtimeFactory,
    catalog: new SessionCatalog({ rootDir: catalogRoot }),
    now: () => currentTime,
    runtimeIdleTtlMs: 10,
  });
  const auth = testAuthSession();
  const sessionPath = join(catalogRoot, "evict-session.jsonl");

  session.sessionStats.sessionId = "evict-session";
  session.sessionStats.sessionFile = sessionPath;
  session.sessionStats.userMessages = 1;
  session.sessionStats.assistantMessages = 1;
  session.sessionStats.totalMessages = 2;
  session.sessionManager = {
    ...session.sessionManager,
    getSessionId: () => "evict-session",
    getSessionFile: () => sessionPath,
  };

  try {
    await writeSessionFile({
      sessionPath,
      sessionId: "evict-session",
      cwd: "/srv/evict",
      sessionName: "Evict Session",
    });

    const created = await registry.createSession(
      { workspaceCwd: "/srv/evict", sessionName: "Evict Session" },
      auth,
      "conn-a",
    );
    expect(created.sessionId).toBe("evict-session");

    registry.detachPresence("evict-session", "conn-a");
    currentTime += 25;

    const evicted = await registry.evictIdleRuntimes();
    expect(evicted).toEqual(["evict-session"]);
    expect(runtimeFactory.runtimeDisposeCalls).toBe(1);
    expect(registry.getSessionSummary("evict-session").lifecycle.loaded).toBe(false);

    const snapshot = await registry.loadSessionSnapshot("evict-session", auth, "conn-b");
    expect(snapshot.sessionId).toBe("evict-session");
    expect(runtimeFactory.loadCalls).toBe(1);
    expect(registry.getSessionSummary("evict-session").lifecycle.loaded).toBe(true);
  } finally {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

timedTest("session summary version stays durable across unloaded and loaded views", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-summary-version-"));
  const catalogRoot = join(root, "sessions");
  const sessionPath = join(catalogRoot, "versioned-session.jsonl");
  const session = new RecordingSession();
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams: new InMemoryDurableStreamStore(),
    runtimeFactory,
    catalog: new SessionCatalog({ rootDir: catalogRoot }),
  });
  const auth = testAuthSession();

  session.sessionStats.sessionId = "versioned-session";
  session.sessionStats.sessionFile = sessionPath;
  session.sessionManager = {
    ...session.sessionManager,
    getSessionId: () => "versioned-session",
    getSessionFile: () => sessionPath,
    getEntries: () => [
      {
        type: "custom" as const,
        id: "versioned-session-version",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: REMOTE_SESSION_VERSION_ENTRY,
        data: {
          version: 42,
          updatedAt: Date.now(),
        },
      },
    ],
  };

  try {
    await writeSessionFile({
      sessionPath,
      sessionId: "versioned-session",
      cwd: "/srv/versioned",
      sessionName: "Versioned Session",
      durableVersion: 42,
    });

    await registry.reconcileCatalogFromDisk();

    const unloadedSummary = registry.getSessionSummary("versioned-session");
    expect(unloadedSummary.version).toBe("42");
    expect(unloadedSummary.lifecycle.loaded).toBe(false);

    await registry.loadSessionSnapshot("versioned-session", auth, "conn-version");

    const loadedSummary = registry.getSessionSummary("versioned-session");
    expect(loadedSummary.version).toBe("42");
    expect(loadedSummary.lifecycle.loaded).toBe(true);
  } finally {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

timedTest("session registry collects detached phantom persistent session", async () => {
  const harness = await createTempPersistedRuntimeHarness({
    prefix: "remote-phantom-gc-",
  });
  const registry = new SessionRegistry({
    streams: new InMemoryDurableStreamStore(),
    runtimeFactory: harness.runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession(
      { workspaceCwd: harness.workspaceDir, sessionName: "Phantom Session" },
      auth,
      "conn-gc",
    );

    registry.detachPresence(created.sessionId, "conn-gc");

    const collected = await registry.evictIdleRuntimes();

    expect(collected).toEqual([created.sessionId]);
    expect(registry.getAppSnapshot(auth).sessionSummaries).toEqual([]);
    await expectNoPersistedSessionFile(harness.sessionDir, created.sessionId);
  } finally {
    await registry.dispose();
    await harness.cleanup();
  }
});

timedTest("session registry deletes detached empty persisted session file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-empty-persisted-gc-"));
  const catalogRoot = join(root, "sessions");
  const sessionPath = join(catalogRoot, "empty-persisted-session.jsonl");
  const session = new RecordingSession();
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams: new InMemoryDurableStreamStore(),
    runtimeFactory,
    catalog: new SessionCatalog({ rootDir: catalogRoot }),
  });
  const auth = testAuthSession();

  session.sessionStats.sessionId = "empty-persisted-session";
  session.sessionStats.sessionFile = sessionPath;
  session.sessionManager = {
    ...session.sessionManager,
    getSessionId: () => "empty-persisted-session",
    getSessionFile: () => sessionPath,
  };

  try {
    await mkdir(catalogRoot, { recursive: true });
    await writeSessionFile({
      sessionPath,
      sessionId: "empty-persisted-session",
      cwd: "/srv/empty-persisted",
      sessionName: "Empty Persisted Session",
    });

    const created = await registry.createSession(
      { workspaceCwd: "/srv/empty-persisted", sessionName: "Empty Persisted Session" },
      auth,
      "conn-empty",
    );
    expect(created.sessionId).toBe("empty-persisted-session");

    registry.detachPresence("empty-persisted-session", "conn-empty");

    const collected = await registry.evictIdleRuntimes();

    expect(collected).toEqual(["empty-persisted-session"]);
    expect(registry.getAppSnapshot(auth).sessionSummaries).toEqual([]);
    await expect(access(sessionPath)).rejects.toThrow();
  } finally {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

timedTest(
  "session registry keeps idle persistent runtime loaded when factory cannot reload",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-remote-idle-no-reload-"));
    const catalogRoot = join(root, "sessions");
    const session = new RecordingSession();
    const runtimeFactory = new NoLoadRecordingRuntimeFactory(session);
    let currentTime = 1_000;
    const registry = new SessionRegistry({
      streams: new InMemoryDurableStreamStore(),
      runtimeFactory,
      catalog: new SessionCatalog({ rootDir: catalogRoot }),
      now: () => currentTime,
      runtimeIdleTtlMs: 10,
    });
    const auth = testAuthSession();
    const sessionPath = join(catalogRoot, "no-reload-session.jsonl");

    session.sessionStats.sessionId = "no-reload-session";
    session.sessionStats.sessionFile = sessionPath;
    session.sessionStats.userMessages = 1;
    session.sessionStats.assistantMessages = 1;
    session.sessionStats.totalMessages = 2;
    session.sessionManager = {
      ...session.sessionManager,
      getSessionId: () => "no-reload-session",
      getSessionFile: () => sessionPath,
    };

    try {
      await writeSessionFile({
        sessionPath,
        sessionId: "no-reload-session",
        cwd: "/srv/no-reload",
        sessionName: "No Reload Session",
      });

      const created = await registry.createSession(
        { workspaceCwd: "/srv/no-reload", sessionName: "No Reload Session" },
        auth,
        "conn-a",
      );
      expect(created.sessionId).toBe("no-reload-session");

      registry.detachPresence("no-reload-session", "conn-a");
      currentTime += 25;

      const evicted = await registry.evictIdleRuntimes();
      expect(evicted).toEqual([]);
      expect(runtimeFactory.runtimeDisposeCalls).toBe(0);
      expect(registry.getSessionSummary("no-reload-session").lifecycle.loaded).toBe(true);
    } finally {
      await registry.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

timedTest("session registry marks running runtime conflicted on external file change", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-busy-conflict-"));
  const catalogRoot = join(root, "sessions");
  const catalog = new SessionCatalog({ rootDir: catalogRoot });
  const session = new RecordingSession();
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams: new InMemoryDurableStreamStore(),
    runtimeFactory,
    catalog,
  });
  const auth = testAuthSession();
  const sessionPath = join(catalogRoot, "busy-session.jsonl");

  session.sessionStats.sessionId = "busy-session";
  session.sessionStats.sessionFile = sessionPath;
  session.sessionManager = {
    ...session.sessionManager,
    getSessionId: () => "busy-session",
    getSessionFile: () => sessionPath,
  };
  session.isStreaming = true;

  try {
    await writeSessionFile({
      sessionPath,
      sessionId: "busy-session",
      cwd: "/srv/busy-v1",
      sessionName: "Busy Session",
    });

    const created = await registry.createSession(
      { workspaceCwd: "/srv/busy-v1", sessionName: "Busy Session" },
      auth,
      "conn-a",
    );

    expect(created.sessionId).toBe("busy-session");

    await writeSessionFile({
      sessionPath,
      sessionId: "busy-session",
      cwd: "/srv/busy-v2",
      sessionName: "Busy Session Updated",
    });

    await registry.reconcileCatalogFromDisk();

    const snapshot = registry.getSessionSnapshot("busy-session", auth, "conn-a");
    expect(session.reloadCalls).toBe(0);
    expect(snapshot.errorMessage).toBe(
      "Session changed externally while runtime active. Reload required.",
    );
  } finally {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

timedTest(
  "session registry preserves busy runtime when durable file disappears externally",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-remote-busy-delete-conflict-"));
    const catalogRoot = join(root, "sessions");
    const catalog = new SessionCatalog({ rootDir: catalogRoot });
    const session = new RecordingSession();
    const runtimeFactory = new RecordingRuntimeFactory(session);
    const registry = new SessionRegistry({
      streams: new InMemoryDurableStreamStore(),
      runtimeFactory,
      catalog,
    });
    const auth = testAuthSession();
    const sessionPath = join(catalogRoot, "busy-delete-session.jsonl");

    session.sessionStats.sessionId = "busy-delete-session";
    session.sessionStats.sessionFile = sessionPath;
    session.sessionManager = {
      ...session.sessionManager,
      getSessionId: () => "busy-delete-session",
      getSessionFile: () => sessionPath,
    };
    session.isStreaming = true;

    try {
      await writeSessionFile({
        sessionPath,
        sessionId: "busy-delete-session",
        cwd: "/srv/busy-delete",
        sessionName: "Busy Delete Session",
      });

      const created = await registry.createSession(
        { workspaceCwd: "/srv/busy-delete", sessionName: "Busy Delete Session" },
        auth,
        "conn-a",
      );

      expect(created.sessionId).toBe("busy-delete-session");

      await rm(sessionPath, { force: true });
      await registry.reconcileCatalogFromDisk();

      const snapshot = registry.getSessionSnapshot("busy-delete-session", auth, "conn-a");
      expect(runtimeFactory.runtimeDisposeCalls).toBe(0);
      expect(snapshot.sessionId).toBe("busy-delete-session");
      expect(snapshot.errorMessage).toBe(
        "Session changed externally while runtime active. Reload required.",
      );
    } finally {
      await registry.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

timedTest("session catalog watcher rethrows non-transient directory read errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-watcher-errors-"));
  const blockedDir = join(root, "blocked");

  await mkdir(blockedDir, { recursive: true });
  await chmod(blockedDir, 0o000);

  try {
    const watcher = new SessionCatalogWatcher({
      rootDir: root,
      onChange: () => {},
    });

    expect(() => watcher.start()).toThrow();
  } finally {
    await chmod(blockedDir, 0o755);
    await rm(root, { recursive: true, force: true });
  }
});

timedTest(
  "custom runtime factory without catalog root does not expose cwd fallback sessions",
  async () => {
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
    const originalCwd = process.cwd();
    const root = await mkdtemp(join(tmpdir(), "pi-remote-custom-factory-"));
    const catalogDir = join(root, ".pi", "remote-sessions");

    await mkdir(catalogDir, { recursive: true });
    await writeFile(
      join(catalogDir, "orphan.jsonl"),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "orphan-session",
        timestamp: new Date().toISOString(),
        cwd: "/srv/orphan",
      })}\n`,
    );

    process.chdir(root);

    try {
      const remote = createRemoteApp({
        origin: "http://localhost:3000",
        allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
        runtimeFactory: new FakeRuntimeFactory(),
      });

      try {
        const token = await authenticate(remote.app, privateKeyPem);
        const snapshotResponse = await remote.app.request("/v1/app/snapshot", {
          headers: { authorization: `Bearer ${token}` },
        });

        expect(snapshotResponse.status).toBe(200);
        const snapshot = (await snapshotResponse.json()) as {
          sessionSummaries: Array<{ sessionId: string }>;
        };

        expect(snapshot.sessionSummaries).toEqual([]);
      } finally {
        await remote.dispose();
      }
    } finally {
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
  },
);

timedTest("runtime api client exposes kv read write delete methods", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
    kvStore: new InMemoryRemoteKvStore(),
  });

  try {
    const client = new RemoteApiClient({
      origin: "http://localhost:3000",
      auth: {
        keyId: "dev",
        privateKey: privateKeyPem,
      },
      fetchImpl: createInProcessFetch(remote.app),
    });
    await client.authenticate();

    const write = await client.writeKv("user", "review", "state", { active: true });
    expect(write.value).toEqual({ active: true });

    const read = await client.readKv("user", "review", "state");
    expect(read.found).toBe(true);
    expect(read.value).toEqual({ active: true });

    const deleted = await client.deleteKv("user", "review", "state");
    expect(deleted.deleted).toBe(true);

    const readAfterDelete = await client.readKv("user", "review", "state");
    expect(readAfterDelete.found).toBe(false);
  } finally {
    await remote.dispose();
  }
});

timedTest("remote runtime exposes fork messages and can fork persisted session", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const harness = await createTempPersistedRuntimeHarness({
    prefix: "remote-fork-persisted-session-",
  });
  const workspaceCwd = await mkdtemp(join(tmpdir(), "remote-fork-workspace-"));

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: harness.runtimeFactory,
  });

  try {
    const runtime = await RemoteAgentSessionRuntime.create({
      origin: "http://localhost:3000",
      auth: {
        keyId: "dev",
        privateKey: privateKeyPem,
      },
      createNewSession: true,
      workspaceCwd,
      fetchImpl: createInProcessFetch(remote.app),
    });

    try {
      const appClient = new RemoteApiClient({
        origin: "http://localhost:3000",
        auth: {
          keyId: "dev",
          privateKey: privateKeyPem,
        },
        fetchImpl: createInProcessFetch(remote.app),
      });
      await appClient.authenticate();
      await appClient.prompt(runtime.session.sessionManager.getSessionId(), { text: "Say hello" });
      await waitForRemoteSessionMessageCount(
        appClient,
        runtime.session.sessionManager.getSessionId(),
        2,
      );
      await runtime.session.reload();

      const remoteForkMessages = await waitForRemoteForkMessages(
        appClient,
        runtime.session.sessionManager.getSessionId(),
      );
      expect(remoteForkMessages.messages.length).toBe(1);
      expect(remoteForkMessages.messages[0]?.text).toBe("Say hello");

      const forkMessages = runtime.session.getUserMessagesForForking();
      expect(forkMessages.length).toBe(1);
      expect(forkMessages[0]?.text).toBe("Say hello");

      const originalSessionId = runtime.session.sessionManager.getSessionId();
      const result = await runtime.fork(remoteForkMessages.messages[0]!.entryId);
      expect(result.cancelled).toBe(false);
      expect(result.selectedText).toBe("Say hello");
      expect(runtime.session.sessionManager.getSessionId()).not.toBe(originalSessionId);
      const snapshot = await waitForAppSessionSummaryCount(appClient, 2);
      expect(snapshot.sessionSummaries.length).toBe(2);
    } finally {
      await runtime.dispose();
    }
  } finally {
    await remote.dispose();
    await harness.cleanup();
    await rm(workspaceCwd, { recursive: true, force: true });
  }
});

timedTest("extension state kv hydration restores managed custom entries", async () => {
  const sessionManager = SessionManager.inMemory("/tmp/pi-remote-kv-hydration");
  sessionManager.newSession({ id: "kv-hydration" });

  const readCalls: Array<{ scope: string; namespace: string; key: string }> = [];
  const client: ExtensionStateKvClient = {
    readKv: async (scope, namespace, key) => {
      readCalls.push({ scope, namespace, key });
      if (namespace !== "openusage") {
        return { found: false };
      }
      return {
        found: true,
        value: {
          resetTimeFormat: "absolute",
          selectedAccounts: { codex: "cliproxy:work" },
        },
        updatedAt: 1,
      };
    },
    writeKv: async (_scope, _namespace, _key, value) => ({ value, updatedAt: 1 }),
  };

  await hydrateExtensionStateFromKv({ client, sessionManager });

  expect(readCalls).toEqual([
    { scope: "user", namespace: "openusage", key: "state" },
    { scope: "user", namespace: "prompt-stash", key: "state" },
  ]);
  const restored = sessionManager
    .getBranch()
    .find((entry) => entry.type === "custom" && entry.customType === "openusage-state");
  expect(restored).toBeTruthy();
  if (restored?.type === "custom") {
    expect(restored.data).toEqual({
      resetTimeFormat: "absolute",
      selectedAccounts: { codex: "cliproxy:work" },
    });
  }
});

timedTest("extension state kv persistence writes managed state only", async () => {
  const writes: Array<{ scope: string; namespace: string; key: string; value: unknown }> = [];
  const client: ExtensionStateKvClient = {
    readKv: async () => ({ found: false }),
    writeKv: async (scope, namespace, key, value) => {
      writes.push({ scope, namespace, key, value });
      return { value, updatedAt: 1 };
    },
  };

  expect(isKvManagedExtensionState("openusage-state")).toBe(true);
  expect(isKvManagedExtensionState("prompt-stash-state")).toBe(true);
  expect(isKvManagedExtensionState("review-settings")).toBe(false);

  await persistExtensionStateToKv({
    client,
    customType: "openusage-state",
    value: { resetTimeFormat: "relative" },
  });
  await persistExtensionStateToKv({
    client,
    customType: "prompt-stash-state",
    value: {
      entries: [
        {
          version: 1,
          id: "stash-id",
          text: "saved prompt",
          createdAt: 123,
        },
      ],
    },
  });
  await persistExtensionStateToKv({
    client,
    customType: "review-settings",
    value: { mode: "quick" },
  });

  expect(writes).toEqual([
    {
      scope: "user",
      namespace: "openusage",
      key: "state",
      value: { resetTimeFormat: "relative" },
    },
    {
      scope: "user",
      namespace: "prompt-stash",
      key: "state",
      value: {
        entries: [
          {
            version: 1,
            id: "stash-id",
            text: "saved prompt",
            createdAt: 123,
          },
        ],
      },
    },
  ]);
});

timedTest("remote CLI parser accepts standalone session UX flags", async () => {
  process.env.PI_REMOTE_ORIGIN = "http://localhost:3000";
  process.env.PI_REMOTE_KEY_ID = "dev";

  try {
    expect(() => parseRemoteArgs(["--session", "session-123", "--resume"])).toThrow(
      /mutually exclusive/,
    );
  } catch (error) {
    expect.unreachable(String(error));
  } finally {
    delete process.env.PI_REMOTE_ORIGIN;
    delete process.env.PI_REMOTE_KEY_ID;
  }
});

timedTest("remote CLI parser accepts explicit workspace target", async () => {
  process.env.PI_REMOTE_ORIGIN = "http://localhost:3000";
  process.env.PI_REMOTE_KEY_ID = "dev";

  try {
    const parsed = parseRemoteArgs(["--workspace-cwd", "/srv/workspace"]);
    expect(parsed.workspaceCwd).toBe("/srv/workspace");
  } finally {
    delete process.env.PI_REMOTE_ORIGIN;
    delete process.env.PI_REMOTE_KEY_ID;
  }
});

timedTest("remote CLI parser accepts session snapshot window flags", async () => {
  process.env.PI_REMOTE_ORIGIN = "http://localhost:3000";
  process.env.PI_REMOTE_KEY_ID = "dev";

  try {
    const parsed = parseRemoteArgs([
      "--session-entries-limit",
      "25",
      "--session-entries-offset",
      "5",
    ]);
    expect(parsed.sessionEntriesLimit).toBe(25);
    expect(parsed.sessionEntriesOffset).toBe(5);
  } finally {
    delete process.env.PI_REMOTE_ORIGIN;
    delete process.env.PI_REMOTE_KEY_ID;
  }
});

timedTest("remote CLI parser reads session snapshot window from env", async () => {
  process.env.PI_REMOTE_ORIGIN = "http://localhost:3000";
  process.env.PI_REMOTE_KEY_ID = "dev";
  process.env.PI_REMOTE_SESSION_ENTRIES_LIMIT = "15";
  process.env.PI_REMOTE_SESSION_ENTRIES_OFFSET = "3";

  try {
    const parsed = parseRemoteArgs([]);
    expect(parsed.sessionEntriesLimit).toBe(15);
    expect(parsed.sessionEntriesOffset).toBe(3);
  } finally {
    delete process.env.PI_REMOTE_ORIGIN;
    delete process.env.PI_REMOTE_KEY_ID;
    delete process.env.PI_REMOTE_SESSION_ENTRIES_LIMIT;
    delete process.env.PI_REMOTE_SESSION_ENTRIES_OFFSET;
  }
});

timedTest("remote CLI parser accepts short resume flag", async () => {
  process.env.PI_REMOTE_ORIGIN = "http://localhost:3000";
  process.env.PI_REMOTE_KEY_ID = "dev";

  try {
    const parsed = parseRemoteArgs(["-r"]);
    expect(parsed.resume).toBe(true);
  } finally {
    delete process.env.PI_REMOTE_ORIGIN;
    delete process.env.PI_REMOTE_KEY_ID;
  }
});

timedTest("remote CLI parser accepts fork flag", async () => {
  process.env.PI_REMOTE_ORIGIN = "http://localhost:3000";
  process.env.PI_REMOTE_KEY_ID = "dev";

  try {
    const parsed = parseRemoteArgs(["--fork", "session-123"]);
    expect(parsed.forkSessionId).toBe("session-123");
  } finally {
    delete process.env.PI_REMOTE_ORIGIN;
    delete process.env.PI_REMOTE_KEY_ID;
  }
});

timedTest("remote CLI parser rejects unsupported remote session-dir and export flags", async () => {
  process.env.PI_REMOTE_ORIGIN = "http://localhost:3000";
  process.env.PI_REMOTE_KEY_ID = "dev";

  try {
    expect(() => parseRemoteArgs(["--session-dir", "/tmp/sessions"])).toThrow(/--session-dir/);
    expect(() => parseRemoteArgs(["--export", "session.jsonl"])).toThrow(/--export/);
  } finally {
    delete process.env.PI_REMOTE_ORIGIN;
    delete process.env.PI_REMOTE_KEY_ID;
  }
});

timedTest(
  "remote session resolution supports session query resume continue and no-session",
  async () => {
    const snapshot = {
      serverInfo: {
        name: "pi-remote",
        version: "0.1.0",
        now: 100,
      },
      currentClientAuthInfo: {
        clientId: "client-1",
        keyId: "dev",
        tokenExpiresAt: 200,
      },
      sessionSummaries: [
        {
          sessionId: "session-a",
          sessionName: "Alpha",
          messageCount: 1,
          status: "idle",
          cwd: "/workspace/a",
          createdAt: 10,
          updatedAt: 20,
          parentSessionId: null,
          lifecycle: { persistence: "persistent", loaded: false, state: "active" },
          lastSessionStreamOffset: "1-0",
        },
        {
          sessionId: "session-b",
          sessionName: "Beta",
          messageCount: 2,
          status: "idle",
          cwd: "/workspace/b",
          createdAt: 30,
          updatedAt: 40,
          parentSessionId: null,
          lifecycle: { persistence: "persistent", loaded: true, state: "active" },
          lastSessionStreamOffset: "2-0",
        },
        {
          sessionId: "session-c",
          sessionName: "Gamma",
          messageCount: 3,
          status: "idle",
          cwd: "/workspace/a",
          createdAt: 50,
          updatedAt: 60,
          parentSessionId: null,
          lifecycle: { persistence: "persistent", loaded: false, state: "active" },
          lastSessionStreamOffset: "3-0",
        },
      ],
      recentNotices: [],
      defaultAttachSessionId: "session-b",
    } as const;

    expect(
      resolveRemoteSessionId({
        snapshot,
        parsed: {
          remoteOrigin: "http://localhost:3000",
          keyId: "dev",
          sessionId: "Gamma",
          privateKey: undefined,
          privateKeyPath: undefined,
          resume: false,
          continueSession: false,
          forkSessionId: undefined,
          noSession: false,
          exportPath: undefined,
          sessionDir: undefined,
          sessionName: undefined,
          workspaceCwd: "/workspace/a",
          verbose: false,
          initialMessage: undefined,
          initialMessages: [],
        },
        cwd: "/workspace/a",
      }),
    ).toEqual({ sessionId: "session-c", createNewSession: false });

    expect(
      resolveRemoteSessionId({
        snapshot,
        parsed: {
          remoteOrigin: "http://localhost:3000",
          keyId: "dev",
          sessionId: "Gamma",
          privateKey: undefined,
          privateKeyPath: undefined,
          resume: false,
          continueSession: false,
          forkSessionId: undefined,
          noSession: false,
          exportPath: undefined,
          sessionDir: undefined,
          sessionName: undefined,
          workspaceCwd: undefined,
          verbose: false,
          initialMessage: undefined,
          initialMessages: [],
        },
        cwd: undefined,
      }),
    ).toEqual({ sessionId: "session-c", createNewSession: false });

    expect(
      resolveRemoteSessionId({
        snapshot,
        parsed: {
          remoteOrigin: "http://localhost:3000",
          keyId: "dev",
          sessionId: undefined,
          privateKey: undefined,
          privateKeyPath: undefined,
          resume: false,
          continueSession: false,
          forkSessionId: undefined,
          noSession: false,
          exportPath: undefined,
          sessionDir: undefined,
          sessionName: undefined,
          workspaceCwd: "/workspace/a",
          verbose: false,
          initialMessage: undefined,
          initialMessages: [],
        },
        cwd: "/workspace/a",
      }),
    ).toEqual({ createNewSession: true });

    expect(() =>
      resolveRemoteSessionId({
        snapshot,
        parsed: {
          remoteOrigin: "http://localhost:3000",
          keyId: "dev",
          sessionId: undefined,
          privateKey: undefined,
          privateKeyPath: undefined,
          resume: true,
          continueSession: false,
          forkSessionId: undefined,
          noSession: false,
          exportPath: undefined,
          sessionDir: undefined,
          sessionName: undefined,
          verbose: false,
          initialMessage: undefined,
          initialMessages: [],
        },
        cwd: "/workspace/a",
      }),
    ).toThrow(/explicit session selection/);

    expect(
      resolveRemoteSessionId({
        snapshot,
        parsed: {
          remoteOrigin: "http://localhost:3000",
          keyId: "dev",
          sessionId: undefined,
          privateKey: undefined,
          privateKeyPath: undefined,
          resume: false,
          continueSession: true,
          forkSessionId: undefined,
          noSession: false,
          exportPath: undefined,
          sessionDir: undefined,
          sessionName: undefined,
          workspaceCwd: "/workspace/a",
          verbose: false,
          initialMessage: undefined,
          initialMessages: [],
        },
        cwd: undefined,
      }),
    ).toEqual({ sessionId: "session-c", createNewSession: false });

    expect(
      resolveRemoteSessionId({
        snapshot,
        parsed: {
          remoteOrigin: "http://localhost:3000",
          keyId: "dev",
          sessionId: undefined,
          privateKey: undefined,
          privateKeyPath: undefined,
          resume: false,
          continueSession: false,
          forkSessionId: undefined,
          noSession: true,
          exportPath: undefined,
          sessionDir: undefined,
          sessionName: undefined,
          workspaceCwd: "/workspace/a",
          verbose: false,
          initialMessage: undefined,
          initialMessages: [],
        },
        cwd: undefined,
      }),
    ).toEqual({ createNewSession: true });

    expect(
      resolveRemoteSessionId({
        snapshot,
        parsed: {
          remoteOrigin: "http://localhost:3000",
          keyId: "dev",
          sessionId: undefined,
          privateKey: undefined,
          privateKeyPath: undefined,
          resume: false,
          continueSession: false,
          forkSessionId: "Alpha",
          noSession: false,
          exportPath: undefined,
          sessionDir: undefined,
          sessionName: undefined,
          workspaceCwd: "/workspace/a",
          verbose: false,
          initialMessage: undefined,
          initialMessages: [],
        },
        cwd: undefined,
      }),
    ).toEqual({ sessionId: "session-a", createNewSession: false });

    expect(
      resolveRemoteSessionId({
        snapshot,
        parsed: {
          remoteOrigin: "http://localhost:3000",
          keyId: "dev",
          sessionId: undefined,
          privateKey: undefined,
          privateKeyPath: undefined,
          resume: false,
          continueSession: false,
          forkSessionId: "Alpha",
          noSession: false,
          exportPath: undefined,
          sessionDir: undefined,
          sessionName: undefined,
          verbose: false,
          initialMessage: undefined,
          initialMessages: [],
        },
        cwd: undefined,
      }),
    ).toEqual({ sessionId: "session-a", createNewSession: false });
  },
);

timedTest("remote session resolution prefers exact session id over fuzzy matches", async () => {
  const snapshot = {
    serverInfo: {
      name: "pi-remote",
      version: "0.1.0",
      now: 100,
    },
    currentClientAuthInfo: {
      clientId: "client-1",
      keyId: "dev",
      tokenExpiresAt: 200,
    },
    sessionSummaries: [
      {
        sessionId: "019dd960-82a8-70ee-8988-9a030be2becd",
        sessionName: undefined,
        messageCount: 1,
        status: "idle",
        cwd: "/workspace/a",
        createdAt: 10,
        updatedAt: 20,
        parentSessionId: null,
        lifecycle: { persistence: "persistent", loaded: false, state: "active" },
        lastSessionStreamOffset: "1-0",
      },
      {
        sessionId: "80201b01-9672-4c43-a302-228f2e602fe7",
        sessionName: "[review] 019dd960-82a8-70ee-8988-9a030be2becd",
        messageCount: 1,
        status: "idle",
        cwd: "/workspace/a",
        createdAt: 30,
        updatedAt: 40,
        parentSessionId: null,
        lifecycle: { persistence: "persistent", loaded: false, state: "active" },
        lastSessionStreamOffset: "2-0",
      },
    ],
    recentNotices: [],
    defaultAttachSessionId: undefined,
  } as const;

  expect(
    resolveRemoteSessionId({
      snapshot,
      parsed: {
        remoteOrigin: "http://localhost:3000",
        keyId: "dev",
        sessionId: "019dd960-82a8-70ee-8988-9a030be2becd",
        privateKey: undefined,
        privateKeyPath: undefined,
        resume: false,
        continueSession: false,
        forkSessionId: undefined,
        noSession: false,
        exportPath: undefined,
        sessionDir: undefined,
        sessionName: undefined,
        workspaceCwd: "/workspace/a",
        verbose: false,
        initialMessage: undefined,
        initialMessages: [],
      },
    }),
  ).toEqual({
    sessionId: "019dd960-82a8-70ee-8988-9a030be2becd",
    createNewSession: false,
  });
});

timedTest("remote session resolution normalizes workspace cwd for continue", async () => {
  const snapshot = {
    serverInfo: {
      name: "pi-remote",
      version: "0.1.0",
      now: 100,
    },
    currentClientAuthInfo: {
      clientId: "client-1",
      keyId: "dev",
      tokenExpiresAt: 200,
    },
    sessionSummaries: [
      {
        sessionId: "session-a",
        sessionName: "Alpha",
        messageCount: 1,
        status: "idle",
        cwd: "/workspace/a",
        createdAt: 10,
        updatedAt: 20,
        parentSessionId: null,
        lifecycle: { persistence: "persistent", loaded: false, state: "active" },
        lastSessionStreamOffset: "1-0",
      },
    ],
    recentNotices: [],
    defaultAttachSessionId: undefined,
  } as const;

  expect(
    resolveRemoteSessionId({
      snapshot,
      parsed: {
        remoteOrigin: "http://localhost:3000",
        keyId: "dev",
        sessionId: undefined,
        privateKey: undefined,
        privateKeyPath: undefined,
        resume: false,
        continueSession: true,
        forkSessionId: undefined,
        noSession: false,
        exportPath: undefined,
        sessionDir: undefined,
        sessionName: undefined,
        workspaceCwd: "/workspace/a/",
        verbose: false,
        initialMessage: undefined,
        initialMessages: [],
      },
      cwd: undefined,
    }),
  ).toEqual({ sessionId: "session-a", createNewSession: false });
});

timedTest("remote startup selection uses resume picker choice", async () => {
  const snapshot = {
    serverInfo: {
      name: "pi-remote",
      version: "0.1.0",
      now: 100,
    },
    currentClientAuthInfo: {
      clientId: "client-1",
      keyId: "dev",
      tokenExpiresAt: 200,
    },
    sessionSummaries: [
      {
        sessionId: "session-a",
        sessionName: "Alpha",
        messageCount: 1,
        status: "idle",
        cwd: "/workspace/a",
        createdAt: 10,
        updatedAt: 20,
        parentSessionId: null,
        lifecycle: { persistence: "persistent", loaded: false, state: "active" },
        lastSessionStreamOffset: "1-0",
      },
      {
        sessionId: "session-b",
        sessionName: "Beta",
        messageCount: 2,
        status: "idle",
        cwd: "/workspace/b",
        createdAt: 30,
        updatedAt: 40,
        parentSessionId: null,
        lifecycle: { persistence: "persistent", loaded: true, state: "active" },
        lastSessionStreamOffset: "2-0",
      },
    ],
    recentNotices: [],
    defaultAttachSessionId: "session-b",
  } as const;

  let selectedWorkspaceCwd: string | undefined;
  const selection = await resolveRemoteStartupSelection({
    snapshot,
    parsed: {
      remoteOrigin: "http://localhost:3000",
      keyId: "dev",
      sessionId: undefined,
      privateKey: undefined,
      privateKeyPath: undefined,
      resume: true,
      continueSession: false,
      forkSessionId: undefined,
      noSession: false,
      exportPath: undefined,
      sessionDir: undefined,
      sessionName: undefined,
      workspaceCwd: "/workspace/a",
      verbose: false,
      initialMessage: undefined,
      initialMessages: [],
    },
    selectSessionId: async (_appSnapshot, workspaceCwd) => {
      selectedWorkspaceCwd = workspaceCwd;
      return "session-a";
    },
  });

  expect(selectedWorkspaceCwd).toBe("/workspace/a");
  expect(selection).toEqual({ sessionId: "session-a", createNewSession: false });
});

timedTest("remote startup selection requires workspace cwd for resume picker", async () => {
  const snapshot = {
    serverInfo: {
      name: "pi-remote",
      version: "0.1.0",
      now: 100,
    },
    currentClientAuthInfo: {
      clientId: "client-1",
      keyId: "dev",
      tokenExpiresAt: 200,
    },
    sessionSummaries: [
      {
        sessionId: "session-a",
        sessionName: "Alpha",
        messageCount: 1,
        status: "idle",
        cwd: "/workspace/a",
        createdAt: 10,
        updatedAt: 20,
        parentSessionId: null,
        lifecycle: { persistence: "persistent", loaded: false, state: "active" },
        lastSessionStreamOffset: "1-0",
      },
    ],
    recentNotices: [],
    defaultAttachSessionId: undefined,
  } as const;

  await expect(
    resolveRemoteStartupSelection({
      snapshot,
      parsed: {
        remoteOrigin: "http://localhost:3000",
        keyId: "dev",
        sessionId: undefined,
        privateKey: undefined,
        privateKeyPath: undefined,
        resume: true,
        continueSession: false,
        forkSessionId: undefined,
        noSession: false,
        exportPath: undefined,
        sessionDir: undefined,
        sessionName: undefined,
        workspaceCwd: undefined,
        verbose: false,
        initialMessage: undefined,
        initialMessages: [],
      },
      selectSessionId: async () => "session-a",
    }),
  ).rejects.toThrow(/--workspace-cwd/);
});

timedTest("remote startup selection requires workspace cwd for startup fork", async () => {
  const snapshot = {
    serverInfo: {
      name: "pi-remote",
      version: "0.1.0",
      now: 100,
    },
    currentClientAuthInfo: {
      clientId: "client-1",
      keyId: "dev",
      tokenExpiresAt: 200,
    },
    sessionSummaries: [
      {
        sessionId: "session-a",
        sessionName: "Alpha",
        messageCount: 1,
        status: "idle",
        cwd: "/workspace/a",
        createdAt: 10,
        updatedAt: 20,
        parentSessionId: null,
        lifecycle: { persistence: "persistent", loaded: false, state: "active" },
        lastSessionStreamOffset: "1-0",
      },
    ],
    recentNotices: [],
    defaultAttachSessionId: undefined,
  } as const;

  await expect(
    resolveRemoteStartupSelection({
      snapshot,
      parsed: {
        remoteOrigin: "http://localhost:3000",
        keyId: "dev",
        sessionId: undefined,
        privateKey: undefined,
        privateKeyPath: undefined,
        resume: false,
        continueSession: false,
        forkSessionId: "Alpha",
        noSession: false,
        exportPath: undefined,
        sessionDir: undefined,
        sessionName: undefined,
        workspaceCwd: undefined,
        verbose: false,
        initialMessage: undefined,
        initialMessages: [],
      },
    }),
  ).rejects.toThrow(/--workspace-cwd/);
});

timedTest(
  "remote startup selection allows explicit session attach without workspace cwd",
  async () => {
    const snapshot = {
      serverInfo: {
        name: "pi-remote",
        version: "0.1.0",
        now: 100,
      },
      currentClientAuthInfo: {
        clientId: "client-1",
        keyId: "dev",
        tokenExpiresAt: 200,
      },
      sessionSummaries: [
        {
          sessionId: "session-a",
          sessionName: "Alpha",
          messageCount: 1,
          status: "idle",
          cwd: "/workspace/a",
          createdAt: 10,
          updatedAt: 20,
          parentSessionId: null,
          lifecycle: { persistence: "persistent", loaded: false, state: "active" },
          lastSessionStreamOffset: "1-0",
        },
      ],
      recentNotices: [],
      defaultAttachSessionId: undefined,
    } as const;

    await expect(
      resolveRemoteStartupSelection({
        snapshot,
        parsed: {
          remoteOrigin: "http://localhost:3000",
          keyId: "dev",
          sessionId: "Alpha",
          privateKey: undefined,
          privateKeyPath: undefined,
          resume: false,
          continueSession: false,
          forkSessionId: undefined,
          noSession: false,
          exportPath: undefined,
          sessionDir: undefined,
          sessionName: undefined,
          workspaceCwd: undefined,
          verbose: false,
          initialMessage: undefined,
          initialMessages: [],
        },
      }),
    ).resolves.toEqual({ sessionId: "session-a", createNewSession: false });
  },
);

timedTest("remote picker session info prefers firstUserMessage for firstMessage", async () => {
  const sessionInfo = toRemoteSessionInfo({
    sessionId: "session-a",
    sessionName: "Session 1",
    firstUserMessage: "Inspect failing remote picker",
    messageCount: 1,
    status: "idle",
    cwd: "/workspace/a",
    createdAt: 1,
    updatedAt: 2,
    parentSessionId: null,
    lifecycle: {
      persistence: "persistent",
      loaded: true,
      state: "active",
    },
    lastSessionStreamOffset: "1-0",
  });

  expect(sessionInfo.name).toBe("Session 1");
  expect(sessionInfo.firstMessage).toBe("Inspect failing remote picker");
});

timedTest(
  "remote picker session info hides fallback id name so first message renders",
  async () => {
    const sessionInfo = toRemoteSessionInfo({
      sessionId: "019dced9-0684-755e-868c-92603fabb984",
      sessionName: "019dced9-0684-755e-868c-92603fabb984",
      firstUserMessage: "Investigate resume picker label",
      messageCount: 1,
      status: "idle",
      cwd: "/workspace/a",
      createdAt: 1,
      updatedAt: 2,
      parentSessionId: null,
      lifecycle: {
        persistence: "persistent",
        loaded: true,
        state: "active",
      },
      lastSessionStreamOffset: "1-0",
    });

    expect(sessionInfo.name).toBeUndefined();
    expect(sessionInfo.firstMessage).toBe("Investigate resume picker label");
  },
);

timedTest(
  "remote picker session info shows no-messages label for empty unnamed session",
  async () => {
    const sessionInfo = toRemoteSessionInfo({
      sessionId: "019dced9-0684-755e-868c-92603fabb984",
      sessionName: "019dced9-0684-755e-868c-92603fabb984",
      messageCount: 0,
      status: "idle",
      cwd: "/workspace/a",
      createdAt: 1,
      updatedAt: 2,
      parentSessionId: null,
      lifecycle: {
        persistence: "persistent",
        loaded: true,
        state: "active",
      },
      lastSessionStreamOffset: "1-0",
    });

    expect(sessionInfo.name).toBeUndefined();
    expect(sessionInfo.firstMessage).toBe("(no messages)");
  },
);

timedTest("remote picker session info preserves name over first user message", async () => {
  const sessionInfo = toRemoteSessionInfo({
    sessionId: "session-a",
    sessionName: "Named Session",
    firstUserMessage: "First user message",
    messageCount: 1,
    status: "idle",
    cwd: "/workspace/a",
    createdAt: 1,
    updatedAt: 2,
    parentSessionId: null,
    lifecycle: {
      persistence: "persistent",
      loaded: true,
      state: "active",
    },
    lastSessionStreamOffset: "1-0",
  });

  expect(sessionInfo.name).toBe("Named Session");
  expect(sessionInfo.firstMessage).toBe("First user message");
});

timedTest("remote picker session info prefers first user message when name hidden", async () => {
  const sessionInfo = toRemoteSessionInfo({
    sessionId: "019dced9-0684-755e-868c-92603fabb984",
    sessionName: "019dced9-0684-755e-868c-92603fabb984",
    firstUserMessage: "Visible first user message",
    messageCount: 1,
    status: "idle",
    cwd: "/workspace/a",
    createdAt: 1,
    updatedAt: 2,
    parentSessionId: null,
    lifecycle: {
      persistence: "persistent",
      loaded: true,
      state: "active",
    },
    lastSessionStreamOffset: "1-0",
  });

  expect(sessionInfo.name).toBeUndefined();
  expect(sessionInfo.firstMessage).toBe("Visible first user message");
});

timedTest("remote picker session info maps parentSessionId for threaded rendering", async () => {
  const sessionInfo = toRemoteSessionInfo({
    sessionId: "child-session",
    sessionName: "Child",
    messageCount: 1,
    status: "idle",
    cwd: "/workspace/a",
    createdAt: 1,
    updatedAt: 2,
    parentSessionId: "parent-session",
    lifecycle: {
      persistence: "persistent",
      loaded: true,
      state: "active",
    },
    lastSessionStreamOffset: "1-0",
  });

  expect(sessionInfo.path).toBe("child-session");
  expect(sessionInfo.parentSessionPath).toBe("parent-session");
});

timedTest(
  "remote interactive rename handler resolves session file path to session id",
  async () => {
    let renamedSession: { sessionId: string; sessionName: string } | undefined;
    const renameSession = createRemoteRenameSessionHandler({
      renameSession: async (sessionId: string, sessionName: string) => {
        renamedSession = { sessionId, sessionName };
      },
    });

    await renameSession(
      "/tmp/pi-remote-tests/sessions/workspace/2026-04-24T23-41-56-774Z_019dc1df-18a5-727a-a0e4-4ec70d65b0b2.jsonl",
      "  renamed session  ",
    );

    expect(renamedSession).toEqual({
      sessionId: "019dc1df-18a5-727a-a0e4-4ec70d65b0b2",
      sessionName: "renamed session",
    });
  },
);

timedTest(
  "remote session resolution requires explicit workspace target for continue and new",
  async () => {
    const snapshot = {
      serverInfo: {
        name: "pi-remote",
        version: "0.1.0",
        now: 100,
      },
      currentClientAuthInfo: {
        clientId: "client-1",
        keyId: "dev",
        tokenExpiresAt: 200,
      },
      sessionSummaries: [],
      recentNotices: [],
      defaultAttachSessionId: undefined,
    } as const;

    expect(() =>
      resolveRemoteSessionId({
        snapshot,
        parsed: {
          remoteOrigin: "http://localhost:3000",
          keyId: "dev",
          sessionId: undefined,
          privateKey: undefined,
          privateKeyPath: undefined,
          resume: false,
          continueSession: true,
          forkSessionId: undefined,
          noSession: false,
          exportPath: undefined,
          sessionDir: undefined,
          sessionName: undefined,
          workspaceCwd: undefined,
          verbose: false,
          initialMessage: undefined,
          initialMessages: [],
        },
        cwd: undefined,
      }),
    ).toThrow(/--workspace-cwd/);

    expect(() =>
      resolveRemoteSessionId({
        snapshot,
        parsed: {
          remoteOrigin: "http://localhost:3000",
          keyId: "dev",
          sessionId: undefined,
          privateKey: undefined,
          privateKeyPath: undefined,
          resume: false,
          continueSession: false,
          forkSessionId: undefined,
          noSession: true,
          exportPath: undefined,
          sessionDir: undefined,
          sessionName: undefined,
          workspaceCwd: undefined,
          verbose: false,
          initialMessage: undefined,
          initialMessages: [],
        },
        cwd: undefined,
      }),
    ).toThrow(/--workspace-cwd/);

    expect(() =>
      resolveRemoteSessionId({
        snapshot,
        parsed: {
          remoteOrigin: "http://localhost:3000",
          keyId: "dev",
          sessionId: undefined,
          privateKey: undefined,
          privateKeyPath: undefined,
          resume: true,
          continueSession: false,
          forkSessionId: undefined,
          noSession: false,
          exportPath: undefined,
          sessionDir: undefined,
          sessionName: undefined,
          workspaceCwd: undefined,
          verbose: false,
          initialMessage: undefined,
          initialMessages: [],
        },
        cwd: undefined,
      }),
    ).toThrow(/--workspace-cwd/);
  },
);

timedTest("remote no-session creates ephemeral session summary", async () => {
  const harness = await createTempPersistedRuntimeHarness({
    prefix: "remote-no-session-summary-",
  });
  const registry = new SessionRegistry({
    streams: new InMemoryDurableStreamStore(),
    runtimeFactory: harness.runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession(
      {
        workspaceCwd: "/workspace/ephemeral",
        persistence: "ephemeral",
      },
      auth,
      "conn-ephemeral",
    );

    const summary = registry.getSessionSummary(created.sessionId);
    expect(summary.lifecycle.persistence).toBe("ephemeral");
    expect(summary.lifecycle.loaded).toBe(true);

    const appSnapshot = registry.getAppSnapshot(auth);
    expect(appSnapshot.sessionSummaries.length).toBe(1);
    expect(appSnapshot.sessionSummaries[0]?.lifecycle.persistence).toBe("ephemeral");
  } finally {
    await registry.dispose();
    await harness.cleanup();
  }
});

timedTest("loaded phantom persistent session can be archived", async () => {
  const harness = await createTempPersistedRuntimeHarness({
    prefix: "remote-phantom-archive-",
  });
  const registry = new SessionRegistry({
    streams: new InMemoryDurableStreamStore(),
    catalog: new SessionCatalog({ rootDir: harness.sessionDir }),
    runtimeFactory: harness.runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession(
      {
        workspaceCwd: harness.workspaceDir,
        sessionName: "Archive phantom",
      },
      auth,
      "conn-archive",
    );

    await expectNoPersistedSessionFile(harness.sessionDir, created.sessionId);

    const archived = await registry.archiveSession(created.sessionId);

    expect(archived.sessionId).toBe(created.sessionId);
    expect(archived.lifecycle.state).toBe("archived");
    expect(archived.lifecycle.loaded).toBe(false);

    const archivedCatalog = new SessionCatalog({ rootDir: harness.sessionDir });
    expect(archivedCatalog.get(created.sessionId)?.sessionPath ?? "").toContain(".archive");
  } finally {
    await registry.dispose();
    await harness.cleanup();
  }
});

timedTest("loaded phantom persistent session supports full-session fork", async () => {
  const harness = await createTempPersistedRuntimeHarness({
    prefix: "remote-phantom-full-fork-",
  });
  const registry = new SessionRegistry({
    streams: new InMemoryDurableStreamStore(),
    catalog: new SessionCatalog({ rootDir: harness.sessionDir }),
    runtimeFactory: harness.runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession(
      {
        workspaceCwd: harness.workspaceDir,
        sessionName: "Fork phantom",
      },
      auth,
      "conn-fork",
    );

    await expectNoPersistedSessionFile(harness.sessionDir, created.sessionId);

    const forked = await registry.forkSession(
      created.sessionId,
      {
        workspaceCwd: harness.workspaceDir,
      },
      auth,
      "conn-fork",
    );

    expect(forked.sessionId).not.toBe(created.sessionId);
    expect(forked.status).toBe("idle");
  } finally {
    await registry.dispose();
    await harness.cleanup();
  }
});

timedTest("loaded phantom persistent session does not persist on failed entry fork", async () => {
  const harness = await createTempPersistedRuntimeHarness({
    prefix: "remote-phantom-failed-fork-",
  });
  const registry = new SessionRegistry({
    streams: new InMemoryDurableStreamStore(),
    catalog: new SessionCatalog({ rootDir: harness.sessionDir }),
    runtimeFactory: harness.runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession(
      {
        workspaceCwd: harness.workspaceDir,
        sessionName: "Fork phantom fail",
      },
      auth,
      "conn-fork",
    );

    await expectNoPersistedSessionFile(harness.sessionDir, created.sessionId);

    await expect(
      registry.forkSession(
        created.sessionId,
        {
          entryId: "missing-entry-id",
          workspaceCwd: harness.workspaceDir,
        },
        auth,
        "conn-fork",
      ),
    ).rejects.toThrow(/Entry .* not found|Invalid entry ID for forking/);

    await expectNoPersistedSessionFile(harness.sessionDir, created.sessionId);
  } finally {
    await registry.dispose();
    await harness.cleanup();
  }
});

timedTest(
  "persistent remote session file is not duplicated before first assistant flush",
  async () => {
    const harness = await createTempPersistedRuntimeHarness({
      prefix: "remote-persistent-session-flush-",
    });
    const registry = new SessionRegistry({
      streams: new InMemoryDurableStreamStore(),
      runtimeFactory: harness.runtimeFactory,
    });
    const auth = testAuthSession();

    try {
      const created = await registry.createSession(
        {
          workspaceCwd: harness.workspaceDir,
          sessionName: "Initial name",
        },
        auth,
        "conn-a",
      );

      await expectNoPersistedSessionFile(harness.sessionDir, created.sessionId);

      await registry.updateSessionName(
        created.sessionId,
        {
          sessionName: "Renamed before first reply",
        },
        auth,
        "conn-a",
      );

      await expectNoPersistedSessionFile(harness.sessionDir, created.sessionId);

      await registry.prompt(
        created.sessionId,
        {
          text: "Say hello",
        },
        auth,
        "conn-a",
      );

      await waitForSessionToBecomeIdle(registry, created.sessionId, auth);

      const sessionFileAfterFirstAssistant = await waitForPersistedSessionFile(
        harness.sessionDir,
        created.sessionId,
      );

      await expectSingleSessionHeaderFile(sessionFileAfterFirstAssistant);
    } finally {
      await registry.dispose();
      await harness.cleanup();
    }
  },
);

timedTest("ephemeral remote session cleans up after last detach", async () => {
  const harness = await createTempPersistedRuntimeHarness({
    prefix: "remote-ephemeral-cleanup-",
  });
  const registry = new SessionRegistry({
    streams: new InMemoryDurableStreamStore(),
    runtimeFactory: harness.runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession(
      {
        workspaceCwd: "/workspace/ephemeral-cleanup",
        persistence: "ephemeral",
      },
      auth,
      "conn-cleanup",
    );

    registry.detachPresence(created.sessionId, "conn-cleanup");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(() => registry.getSessionSummary(created.sessionId)).toThrow(/Session not found/);
    expect(registry.getAppSnapshot(auth).sessionSummaries.length).toBe(0);
  } finally {
    await registry.dispose();
    await harness.cleanup();
  }
});

timedTest("ephemeral cleanup failure is contained and surfaces session error", async () => {
  const registry = new SessionRegistry({
    streams: new InMemoryDurableStreamStore(),
    runtimeFactory: new FailingDisposeRuntimeFactory(),
  });
  const auth = testAuthSession();
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (error: unknown) => {
    unhandledRejections.push(error);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    const created = await registry.createSession(
      {
        workspaceCwd: "/workspace/ephemeral-dispose-failure",
        persistence: "ephemeral",
      },
      auth,
      "conn-cleanup-error",
    );

    registry.detachPresence(created.sessionId, "conn-cleanup-error");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unhandledRejections).toEqual([]);

    const snapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-recover");
    expect(snapshot.errorMessage).toBe("Failed to clean up ephemeral session: dispose failed");
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    await registry.dispose().catch(() => {});
  }
});

timedTest("session snapshot version resumes from durable state after restart", async () => {
  const harness = await createTempPersistedRuntimeHarness({
    prefix: "remote-session-version-restart-",
  });
  const auth = testAuthSession();

  let registry = new SessionRegistry({
    streams: new InMemoryDurableStreamStore(),
    runtimeFactory: harness.runtimeFactory,
    catalog: new SessionCatalog({ rootDir: harness.sessionDir }),
  });

  try {
    const created = await registry.createSession(
      {
        workspaceCwd: harness.workspaceDir,
      },
      auth,
      "conn-a",
    );

    await registry.updateSessionName(
      created.sessionId,
      {
        sessionName: "restart-version",
      },
      auth,
      "conn-a",
    );

    await registry.prompt(
      created.sessionId,
      {
        text: "persist durable version",
      },
      auth,
      "conn-a",
    );

    await waitForSessionToBecomeIdle(registry, created.sessionId, auth);
    await waitForPersistedSessionFile(harness.sessionDir, created.sessionId);

    const beforeRestart = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    expect(Number(beforeRestart.version)).toBeGreaterThan(0);

    await registry.dispose();

    registry = new SessionRegistry({
      streams: new InMemoryDurableStreamStore(),
      runtimeFactory: harness.runtimeFactory,
      catalog: new SessionCatalog({ rootDir: harness.sessionDir }),
    });

    await registry.ensureLoaded(created.sessionId);
    const afterRestart = registry.getSessionSnapshot(created.sessionId, auth, "conn-b");
    expect(afterRestart.version).toBe(beforeRestart.version);

    await registry.updateSessionName(
      created.sessionId,
      {
        sessionName: "restart-version-next",
      },
      auth,
      "conn-b",
    );

    const afterNextDurableChange = registry.getSessionSnapshot(created.sessionId, auth, "conn-b");
    expect(Number(afterNextDurableChange.version)).toBe(Number(beforeRestart.version) + 1);
  } finally {
    await registry.dispose();
    await harness.cleanup();
  }
});

timedTest("durable extension sync stays authoritative across reconnect and restart", async () => {
  const harness = await createTempPersistedRuntimeHarness({
    prefix: "remote-extension-durable-restart-",
  });
  const auth = testAuthSession();

  let registry = new SessionRegistry({
    streams: new InMemoryDurableStreamStore(),
    runtimeFactory: harness.runtimeFactory,
    catalog: new SessionCatalog({ rootDir: harness.sessionDir }),
  });

  try {
    const created = await registry.createSession(
      {
        workspaceCwd: harness.workspaceDir,
        persistence: "persistent",
      },
      auth,
      "conn-a",
    );

    await registry.updateSessionName(
      created.sessionId,
      { sessionName: "durable-extension-session" },
      auth,
      "conn-a",
    );
    await registry.prompt(
      created.sessionId,
      { text: "persist durable extension state" },
      auth,
      "conn-a",
    );
    await waitForSessionToBecomeIdle(registry, created.sessionId, auth);

    await registry.emitSessionExtensionCustomEvent(
      created.sessionId,
      {
        channel: "demo:durable",
        data: { sync: "durable", replaceKey: "slot", value: 1 },
      },
      auth,
      "conn-a",
    );
    await registry.emitSessionExtensionCustomEvent(
      created.sessionId,
      {
        channel: "demo:durable",
        data: { sync: "durable", replaceKey: "slot", value: 2 },
      },
      auth,
      "conn-a",
    );

    let snapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    expect(snapshot.durableExtensionState).toEqual([
      { channel: "demo:durable", data: { sync: "durable", replaceKey: "slot", value: 2 } },
    ]);

    await registry.emitSessionExtensionCustomEvent(
      created.sessionId,
      {
        channel: "demo:durable",
        data: { sync: "durable", replaceKey: "slot", deleted: true },
      },
      auth,
      "conn-a",
    );

    snapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-b");
    expect(snapshot.durableExtensionState).toEqual([]);

    await waitForPersistedSessionFile(harness.sessionDir, created.sessionId);
    await registry.reconcileCatalogFromDisk();

    await registry.dispose();
    registry = new SessionRegistry({
      streams: new InMemoryDurableStreamStore(),
      runtimeFactory: harness.runtimeFactory,
      catalog: new SessionCatalog({ rootDir: harness.sessionDir }),
    });
    const restartedSnapshot = await registry.loadSessionSnapshot(created.sessionId, auth, "conn-c");
    expect(restartedSnapshot.durableExtensionState).toEqual([]);
  } finally {
    await registry.dispose();
    await harness.cleanup();
  }
});

timedTest("two clients converge after snapshot-based reconnect", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const harness = await createTempPersistedRuntimeHarness({
    prefix: "remote-two-client-converge-",
  });

  const streams = new InMemoryDurableStreamStore();
  const sessions = new SessionRegistry({
    streams,
    runtimeFactory: harness.runtimeFactory,
    catalog: new SessionCatalog({ rootDir: harness.sessionDir }),
  });
  const app = new Hono();
  app.route(
    "/v1",
    createV1Routes({
      auth: new AuthService({
        origin: "http://localhost:3000",
        allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      }),
      sessions,
      kv: new InMemoryRemoteKvStore(),
      streams,
    }),
  );

  let runtimeA: RemoteAgentSessionRuntime | undefined;
  let clientA: RemoteApiClient | undefined;
  let clientB: RemoteApiClient | undefined;
  try {
    runtimeA = await createRemoteRuntime(app, {
      privateKeyPem,
      cwd: harness.workspaceDir,
      persistence: "persistent",
    });
    const sessionId = runtimeA.session.sessionManager.getSessionId();
    clientA = new RemoteApiClient({
      origin: "http://localhost:3000",
      auth: { keyId: "dev", privateKey: privateKeyPem },
      fetchImpl: createInProcessFetch(app),
    });
    clientB = new RemoteApiClient({
      origin: "http://localhost:3000",
      auth: { keyId: "dev", privateKey: privateKeyPem },
      fetchImpl: createInProcessFetch(app),
    });
    await clientA.authenticate();
    await clientB.authenticate();

    await runtimeA.session.prompt("client convergence one");
    await waitForValue(
      async () => (await clientB?.getSessionSnapshot(sessionId))?.transcript.length,
      (messageCount) => typeof messageCount === "number" && messageCount >= 2,
    );
    await waitForValue(
      () => runtimeA?.session.isStreaming,
      (isStreaming) => isStreaming === false,
    );

    clientB = new RemoteApiClient({
      origin: "http://localhost:3000",
      auth: { keyId: "dev", privateKey: privateKeyPem },
      fetchImpl: createInProcessFetch(app),
    });
    await clientB.authenticate();

    await runtimeA.session.prompt("client convergence two");
    await waitForValue(
      async () => (await clientB?.getSessionSnapshot(sessionId))?.transcript.length,
      (messageCount) => typeof messageCount === "number" && messageCount >= 4,
    );
    await waitForValue(
      () => runtimeA?.session.isStreaming,
      (isStreaming) => isStreaming === false,
    );

    const snapshotA = await clientA.getSessionSnapshot(sessionId);
    const snapshotB = await clientB.getSessionSnapshot(sessionId);
    expect(snapshotB.version).toBe(snapshotA.version);
    expect(snapshotB.transcript).toEqual(snapshotA.transcript);
    expect(snapshotB.durableExtensionState).toEqual(snapshotA.durableExtensionState);
  } finally {
    await runtimeA?.dispose();
    await sessions.dispose();
    await harness.cleanup();
  }
});

timedTest("touchSessionPresence reports prune-to-zero transitions", async () => {
  const session = new RecordingSession();
  const runtime = {
    session,
    dispose: async () => {},
  } as any;
  const record = {
    sessionId: "ephemeral-prune",
    sessionName: "ephemeral-prune",
    persistence: "ephemeral",
    status: "idle",
    cwd: session.cwd,
    model: "pi-remote-faux/pi-remote-faux-1",
    thinkingLevel: "medium",
    activeTools: [],
    extensions: [],
    resources: { skills: [], prompts: [], themes: [], systemPrompt: null, appendSystemPrompt: [] },
    settings: {} as any,
    availableModels: [],
    modelSettings: {
      defaultProvider: null,
      defaultModel: null,
      defaultThinkingLevel: null,
      enabledModels: null,
    },
    contextUsage: undefined,
    usageCost: 0,
    sessionStats: {
      sessionFile: undefined,
      sessionId: "ephemeral-prune",
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      contextUsage: undefined,
    },
    autoCompactionEnabled: false,
    steeringMode: "all",
    followUpMode: "all",
    transcript: [],
    queue: { depth: 0, nextSequence: 1 },
    retry: { status: "idle" },
    compaction: { status: "idle" },
    activeRun: null,
    streamingState: "idle",
    pendingToolCalls: [],
    errorMessage: null,
    createdAt: 0,
    updatedAt: 0,
    presence: new Map([
      [
        "stale-conn",
        {
          clientId: "dev",
          connectionId: "stale-conn",
          connectedAt: 0,
          lastSeenAt: 0,
          lastSeenAppOffset: "0",
          lastSeenSessionOffset: "0",
        },
      ],
    ]),
    runtime,
    commandAcceptanceQueue: Promise.resolve(),
    runtimeDispatchQueue: Promise.resolve(),
    runtimeUndispatchedCommandCount: 0,
    hasLocalCommandError: false,
    pendingUiRequests: new Map(),
  } as const;
  const prunedToZero: string[] = [];

  touchSessionPresence({
    record: record as any,
    client: testAuthSession(),
    connectionId: "fresh-conn",
    now: 100,
    createConnectionId: () => "generated",
    pruneExpiredPresence: (targetRecord) => {
      targetRecord.presence.clear();
    },
    onPresencePrunedToZero: (targetRecord) => {
      prunedToZero.push(targetRecord.sessionId);
    },
    readConnectionCapabilities: () => undefined,
    getLastAppOffset: () => "1",
    getLastSessionOffset: () => "1",
  });

  expect(prunedToZero).toEqual(["ephemeral-prune"]);
  expect(record.presence.has("fresh-conn")).toBe(true);
});

timedTest("ephemeral cleanup surfaces app stream append failures", async () => {
  const harness = await createTempPersistedRuntimeHarness({
    prefix: "remote-ephemeral-append-failure-",
  });
  const registry = new SessionRegistry({
    streams: new ThrowingAppEventStreamStore(),
    runtimeFactory: harness.runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession(
      {
        workspaceCwd: "/workspace/ephemeral-append-failure",
        persistence: "ephemeral",
      },
      auth,
      "conn-append-error",
    );

    registry.detachPresence(created.sessionId, "conn-append-error");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const snapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-append-recover");
    expect(snapshot.errorMessage).toBe("Failed to clean up ephemeral session: append failed");
  } finally {
    await registry.dispose().catch(() => {});
    await harness.cleanup();
  }
});

timedTest("remote runtime create requires explicit workspace for new session", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(new RecordingSession()),
  });

  try {
    await expect(
      RemoteAgentSessionRuntime.create({
        origin: "http://localhost:3000",
        auth: {
          keyId: "dev",
          privateKey: privateKeyPem,
        },
        clientCapabilities: REMOTE_DEFAULT_CLIENT_CAPABILITIES,
        createNewSession: true,
        fetchImpl: createInProcessFetch(remote.app),
      }),
    ).rejects.toThrow(/workspaceCwd/);

    await expect(
      RemoteAgentSessionRuntime.create({
        origin: "http://localhost:3000",
        auth: {
          keyId: "dev",
          privateKey: privateKeyPem,
        },
        clientCapabilities: REMOTE_DEFAULT_CLIENT_CAPABILITIES,
        fetchImpl: createInProcessFetch(remote.app),
      }),
    ).rejects.toThrow(/workspaceCwd/);
  } finally {
    await remote.dispose();
  }
});

timedTest("remote client bootstrap resolves snapshot model from available models", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-bootstrap-model-"));
  const agentDir = join(root, "agent");
  const workspaceDir = join(root, "workspace");
  let session: RemoteAgentSession | undefined;

  await mkdir(agentDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const snapshot = {
    sessionId: "session-bootstrap-model",
    status: "idle",
    cwd: workspaceDir,
    model: "codex-openai/gpt-5.5",
    thinkingLevel: "low",
    activeTools: ["read", "bash", "edit", "write"],
    extensions: [],
    resources: {
      skills: [],
      prompts: [],
      themes: [],
      systemPrompt: null,
      appendSystemPrompt: [],
    },
    settings: undefined,
    availableModels: [
      {
        provider: "codex-openai",
        id: "gpt-5.5",
        name: "GPT 5.5",
        baseUrl: "https://example.invalid",
        api: "responses",
        reasoning: true,
        input: ["text"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ],
    modelSettings: {
      defaultProvider: "codex-openai",
      defaultModel: "gpt-5.5",
      defaultThinkingLevel: "low",
      enabledModels: null,
    },
    sessionStats: {
      sessionFile: undefined,
      sessionId: "session-bootstrap-model",
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
      cost: 0,
      contextUsage: undefined,
    },
    contextUsage: undefined,
    usageCost: 0,
    autoCompactionEnabled: false,
    steeringMode: "all",
    followUpMode: "all",
    entries: [],
    leafId: null,
    transcript: [],
    queue: {
      depth: 0,
      nextSequence: 1,
    },
    retry: {
      status: "idle",
    },
    compaction: {
      status: "idle",
    },
    presence: [],
    activeRun: null,
    lastSessionStreamOffset: "0",
    streamingState: "idle",
    isBashRunning: false,
    hasPendingBashMessages: false,
    pendingToolCalls: [],
    errorMessage: null,
    createdAt: 0,
    updatedAt: 0,
  };

  const readSessionEvents = ({ signal }: { signal?: AbortSignal }) => {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  };

  try {
    session = await RemoteAgentSession.create(
      {
        getSessionForkMessages: async () => ({ messages: [] }),
        readSessionEvents: async (
          _sessionId: string,
          _offset: string | undefined,
          options: { signal?: AbortSignal },
        ) => readSessionEvents(options),
        readKv: async () => ({ found: false }),
        reauthenticate: async () => {},
      } as never,
      snapshot.sessionId,
      {
        snapshot,
        agentDir,
      },
    );

    expect(session.thinkingLevel).toBe("low");
    expect(session.model?.reasoning).toBe(true);
    expect(session.getAvailableThinkingLevels()).toContain("low");
    expect(session.getAvailableThinkingLevels()).not.toEqual(["off"]);
  } finally {
    await session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

timedTest("session registry createSession uses requested workspace cwd", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const registryAny = registry as any;
  const auth = testAuthSession();

  try {
    const created = await registry.createSession(
      { workspaceCwd: "/srv/workspace-a" },
      auth,
      "conn-a",
    );
    const snapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    expect(snapshot.cwd).toBe("/srv/workspace-a");
    expect(session.cwd).toBe("/srv/workspace-a");
  } finally {
    await registry.dispose();
  }
});

timedTest("remote snapshot and adapter expose runtime context usage", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const usage = {
    tokens: 1234,
    contextWindow: 128_000,
    percent: 0.96,
  };
  const session = new RecordingSession();
  session.sessionStats = {
    ...session.sessionStats,
    sessionFile: "/tmp/pi-remote-recording-session/authoritative.jsonl",
    contextUsage: usage,
    cost: 12.34,
  };
  session.autoCompactionEnabled = true;
  session.steeringMode = "one-at-a-time";
  session.followUpMode = "all";

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    const snapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as {
      contextUsage?: typeof usage;
      usageCost: number;
      sessionStats: {
        sessionFile?: string;
        cost: number;
        contextUsage?: typeof usage;
      };
      autoCompactionEnabled: boolean;
      steeringMode: "all" | "one-at-a-time";
      followUpMode: "all" | "one-at-a-time";
    };
    expect(snapshot.contextUsage).toEqual(usage);
    expect(snapshot.usageCost).toBe(12.34);
    expect(snapshot.sessionStats.sessionFile).toBe(
      "/tmp/pi-remote-recording-session/authoritative.jsonl",
    );
    expect(snapshot.sessionStats.cost).toBe(12.34);
    expect(snapshot.sessionStats.contextUsage).toEqual(usage);
    expect(snapshot.autoCompactionEnabled).toBe(true);
    expect(snapshot.steeringMode).toBe("one-at-a-time");
    expect(snapshot.followUpMode).toBe("all");

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });
    expect(runtime.session.getContextUsage()).toEqual(usage);
    expect(runtime.session.getSessionStats().cost).toBe(12.34);
    expect(runtime.session.getSessionStats().sessionFile).toBe(
      "/tmp/pi-remote-recording-session/authoritative.jsonl",
    );
    expect(runtime.session.autoCompactionEnabled).toBe(true);
    expect(runtime.session.steeringMode).toBe("one-at-a-time");
    expect(runtime.session.followUpMode).toBe("all");
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote adapter mirrors snapshot entries into session manager", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const session = new RecordingSession();
  session.messages = [
    {
      role: "assistant",
      content: [{ type: "text", text: "pong" }],
      usage: {
        input: 2,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 5,
        cost: {
          input: 0.01,
          output: 0.02,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.03,
        },
      },
      api: "responses",
      provider: "pi-remote-faux",
      model: "pi-remote-faux-1",
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ];

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    const messageEntries = runtime.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "message");

    expect(messageEntries.length).toBe(1);
    expect(messageEntries[0]?.message.role).toBe("assistant");
    expect(
      calculateTotalCost({ sessionManager: runtime.session.sessionManager } as ExtensionContext),
    ).toBe(0.03);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote adapter preserves snapshot entries after authoritative cwd update", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const session = new RecordingSession();
  session.cwd = "/srv/remote-workspace";
  session.messages = [
    {
      role: "assistant",
      content: [{ type: "text", text: "restored after cwd sync" }],
      api: "responses",
      provider: "pi-remote-faux",
      model: "pi-remote-faux-1",
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ];

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
      cwd: "/tmp/local-client-cwd",
    });

    const messageEntries = runtime.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "message");

    expect(runtime.session.sessionManager.getCwd()).toBe("/srv/remote-workspace");
    expect(messageEntries.length).toBe(1);
    expect(messageEntries[0]?.message.role).toBe("assistant");
    expect(runtime.session.messages[0]?.role).toBe("assistant");
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote adapter mirrors live message events into session entries", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const session = new RecordingSession();
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    const sessionAny = runtime.session as {
      applyAgentSessionEvent: (event: {
        type: "message_start" | "message_end";
        message: Record<string, unknown>;
      }) => void;
    };

    sessionAny.applyAgentSessionEvent({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "ping" }],
        timestamp: Date.now(),
      },
    });
    sessionAny.applyAgentSessionEvent({
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "ping" }],
        timestamp: Date.now(),
      },
    });
    sessionAny.applyAgentSessionEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "pong" }],
        usage: {
          input: 2,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 5,
          cost: {
            input: 0.01,
            output: 0.02,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.03,
          },
        },
        api: "responses",
        provider: "pi-remote-faux",
        model: "pi-remote-faux-1",
        stopReason: "stop",
        timestamp: Date.now(),
      },
    });

    const messageEntries = runtime.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "message");

    expect(messageEntries.length).toBe(2);
    expect(messageEntries[0]?.message.role).toBe("user");
    expect(messageEntries[1]?.message.role).toBe("assistant");
    expect(
      calculateTotalCost({ sessionManager: runtime.session.sessionManager } as ExtensionContext),
    ).toBe(0.03);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest(
  "remote adapter getSessionStats uses server-authoritative stats instead of transcript",
  async () => {
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

    const session = new RecordingSession();
    session.messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage: {
          input: 999,
          output: 999,
          cacheRead: 999,
          cacheWrite: 999,
          totalTokens: 3996,
          cost: {
            input: 9,
            output: 9,
            cacheRead: 9,
            cacheWrite: 9,
            total: 36,
          },
        },
        api: "responses",
        provider: "pi-remote-faux",
        model: "pi-remote-faux-1",
        stopReason: "stop",
        timestamp: Date.now(),
      },
    ];
    session.sessionStats = {
      ...session.sessionStats,
      sessionFile: "/tmp/pi-remote-recording-session/authoritative-stats.jsonl",
      userMessages: 1,
      assistantMessages: 1,
      totalMessages: 2,
      tokens: {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        total: 10,
      },
      cost: 1.23,
    };

    const remote = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: new RecordingRuntimeFactory(session),
    });

    let runtime: RemoteAgentSessionRuntime | undefined;
    try {
      const token = await authenticate(remote.app, privateKeyPem);
      const createResponse = await remote.app.request("/v1/sessions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as { sessionId: string };

      runtime = await createRemoteRuntime(remote.app, {
        privateKeyPem,
        sessionId: created.sessionId,
      });

      const stats = runtime.session.getSessionStats();
      expect(stats.cost).toBe(1.23);
      expect(stats.tokens.total).toBe(10);
      expect(stats.sessionFile).toBe("/tmp/pi-remote-recording-session/authoritative-stats.jsonl");
    } finally {
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

test(
  "session state patch carries server stats and client cache updates",
  { timeout: 20_000 },
  async () => {
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

    const remote = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: new RecordingRuntimeFactory(new ImmediateAssistantPromptSession()),
    });

    let runtime: RemoteAgentSessionRuntime | undefined;
    try {
      const token = await authenticate(remote.app, privateKeyPem);
      const createResponse = await remote.app.request("/v1/sessions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as { sessionId: string };

      const snapshotResponse = await remote.app.request(
        `/v1/sessions/${created.sessionId}/snapshot`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      expect(snapshotResponse.status).toBe(200);
      const snapshot = (await snapshotResponse.json()) as {
        lastSessionStreamOffset: string;
        sessionStats: { totalMessages: number };
      };

      runtime = await createRemoteRuntime(remote.app, {
        privateKeyPem,
        sessionId: created.sessionId,
      });

      const initialStats = runtime.session.getSessionStats();

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          unsubscribe();
          reject(new Error("Timed out waiting for agent_end"));
        }, 14_000);

        const unsubscribe = runtime!.session.subscribe((event) => {
          if (event.type !== "agent_end") {
            return;
          }
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        });

        void runtime!.session.prompt("report a short status line");
      });

      const updatedStats = runtime.session.getSessionStats();
      expect(updatedStats.totalMessages > initialStats.totalMessages).toBeTruthy();

      const updatedSnapshot = await waitForValue(
        async () => {
          const updatedSnapshotResponse = await remote.app.request(
            `/v1/sessions/${created.sessionId}/snapshot`,
            {
              headers: { authorization: `Bearer ${token}` },
            },
          );
          expect(updatedSnapshotResponse.status).toBe(200);
          return (await updatedSnapshotResponse.json()) as {
            sessionStats: { totalMessages: number };
          };
        },
        (value) => value.sessionStats.totalMessages > snapshot.sessionStats.totalMessages,
      );
      expect(updatedSnapshot.sessionStats.totalMessages).toBeGreaterThan(
        snapshot.sessionStats.totalMessages,
      );
    } finally {
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

timedTest(
  "managed extension state persistence does not fallback to local entry on kv failure",
  async () => {
    const sessionManager = SessionManager.inMemory("/tmp/pi-remote-kv-persist-failure");
    sessionManager.newSession({ id: "kv-persist-failure" });

    const client: ExtensionStateKvClient = {
      readKv: async () => ({ found: false }),
      writeKv: async () => {
        throw new Error("kv write failed");
      },
    };

    await expect(
      persistManagedExtensionState({
        client,
        sessionManager,
        customType: "openusage-state",
        value: { resetTimeFormat: "absolute" },
      }),
    ).rejects.toThrow(/kv write failed/u);

    const restored = sessionManager
      .getBranch()
      .find((entry) => entry.type === "custom" && entry.customType === "openusage-state");
    expect(restored).toBe(undefined);
  },
);

async function waitForPersistedSessionFile(sessionDir: string, sessionId: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const entries = await readdir(sessionDir);
    const match = entries.find((entry) => entry.endsWith(`${sessionId}.jsonl`));
    if (match !== undefined) {
      return join(sessionDir, match);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for persisted session file for ${sessionId}`);
}

async function expectNoPersistedSessionFile(sessionDir: string, sessionId: string): Promise<void> {
  const entries = await readdir(sessionDir);
  const match = entries.find((entry) => entry.endsWith(`${sessionId}.jsonl`));
  expect(match).toBeUndefined();
}

async function expectSingleSessionHeaderFile(sessionFile: string): Promise<void> {
  const lines = (await readFile(sessionFile, "utf8"))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { type: string; id?: string });
  const headerCount = lines.filter((line) => line.type === "session").length;
  const entryIds = lines.flatMap((line) => (typeof line.id === "string" ? [line.id] : []));

  expect(headerCount).toBe(1);
  expect(new Set(entryIds).size).toBe(entryIds.length);
}

async function waitForSessionToBecomeIdle(
  registry: SessionRegistry,
  sessionId: string,
  auth: ReturnType<typeof testAuthSession>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const snapshot = registry.getSessionSnapshot(sessionId, auth, "conn-a");
    if (snapshot.status === "idle") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for session ${sessionId} to become idle`);
}

async function waitForAppSessionSummaryCount(
  client: RemoteApiClient,
  expectedCount: number,
): Promise<Awaited<ReturnType<RemoteApiClient["getAppSnapshot"]>>> {
  const deadline = Date.now() + 10_000;
  let lastSnapshot: Awaited<ReturnType<RemoteApiClient["getAppSnapshot"]>> | undefined;
  while (Date.now() < deadline) {
    const snapshot = await client.getAppSnapshot();
    lastSnapshot = snapshot;
    if (snapshot.sessionSummaries.length === expectedCount) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const labels =
    lastSnapshot?.sessionSummaries.map(
      (summary) => `${summary.sessionId}:${summary.lifecycle.status}`,
    ) ?? [];
  throw new Error(
    `Timed out waiting for app snapshot summary count ${expectedCount}. Last summaries: ${labels.join(", ")}`,
  );
}

async function waitForRemoteSessionIdle(client: RemoteApiClient, sessionId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const snapshot = await client.getSessionSnapshot(sessionId);
    if (snapshot.status === "idle") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for remote session ${sessionId} to become idle`);
}

async function waitForRemoteSessionMessageCount(
  client: RemoteApiClient,
  sessionId: string,
  expectedCount: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const snapshot = await client.getSessionSnapshot(sessionId);
    if (snapshot.status === "idle" && snapshot.sessionStats.totalMessages >= expectedCount) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(
    `Timed out waiting for remote session ${sessionId} to reach ${expectedCount} messages`,
  );
}

async function waitForRemoteForkMessages(
  client: RemoteApiClient,
  sessionId: string,
): Promise<Awaited<ReturnType<RemoteApiClient["getSessionForkMessages"]>>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const messages = await client.getSessionForkMessages(sessionId);
    if (messages.messages.length > 0) {
      return messages;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for remote fork messages for ${sessionId}`);
}
