import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
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
import { REMOTE_DEFAULT_CLIENT_CAPABILITIES } from "../src/remote/capabilities.ts";
import { SessionCatalogWatcher } from "../src/remote/session-catalog-watcher.ts";
import { cancelRemoteUiRequest, handleRemoteUiRequest } from "../src/remote/client/session-ui.ts";
import { InMemoryRemoteKvStore } from "../src/remote/kv/in-memory-store.ts";
import { RemoteApiClient } from "../src/remote/runtime-api/client.ts";
import {
  hydrateExtensionStateFromKv,
  isKvManagedExtensionState,
  persistExtensionStateToKv,
  persistManagedExtensionState,
  type ExtensionStateKvClient,
} from "../src/remote/client/session/extension-state-kv.ts";
import { hasSessionPrimitiveCapability } from "../src/remote/session/capabilities.ts";
import { createRemoteUiContext } from "../src/remote/session/ui-context.ts";
import {
  InMemoryPiRuntimeFactory,
  type RemoteRuntimeFactory,
} from "../src/remote/runtime-factory.ts";
import { createRemoteThemeFromContent } from "../src/remote/client/remote-theme.ts";
import { RemoteAgentSessionRuntime, createInProcessFetch } from "../src/remote/client-runtime.ts";
import { parseRemoteArgs, resolveRemoteSessionId } from "../src/remote/client-interactive.ts";
import { loadThemeFromPath } from "../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { calculateTotalCost } from "../src/extensions/coreui/usage.ts";
import type { ClientCapabilities, Presence } from "../src/remote/schemas.ts";
import { StreamReadResponseSchema } from "../src/remote/schemas.ts";
import { SessionRegistry } from "../src/remote/session-registry.ts";
import { SessionCatalog } from "../src/remote/session-catalog.ts";
import { InMemoryDurableStreamStore, sessionEventsStreamId } from "../src/remote/streams.ts";
import { assertType } from "../src/remote/typebox.ts";

process.env.PI_REMOTE_ENABLE_LOGGER = "0";

const TEST_TIMEOUT_MS = 15_000;

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

class FakeRuntimeFactory implements RemoteRuntimeFactory {
  async create() {
    return {
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

  async create(request?: { cwd?: string }) {
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

  async create(request?: { cwd?: string }) {
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

class SequencedRecordingRuntimeFactory implements RemoteRuntimeFactory {
  readonly sessions: RecordingSession[];
  runtimeDisposeCalls = 0;
  createCalls = 0;

  constructor(sessions: RecordingSession[]) {
    this.sessions = sessions;
  }

  async create(request?: { cwd?: string }) {
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
    clientExtensionMetadata?: Array<{ id: string; runtime: "client"; path: string }>;
    clientExtensionFactories?: ExtensionFactory[];
  },
) {
  return RemoteAgentSessionRuntime.create({
    origin: "http://localhost:3000",
    auth: {
      keyId: "dev",
      privateKey: options.privateKeyPem,
    },
    clientCapabilities: REMOTE_DEFAULT_CLIENT_CAPABILITIES,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.cwd ? { workspaceCwd: options.cwd } : {}),
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
  assert.equal(challengeResponse.status, 200);
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

  assert.equal(verifyResponse.status, 200);
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

  assert.equal(response.status, 200);
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

  assert.equal(response.status, 200);
  return (await response.json()) as { found: boolean; value?: unknown; updatedAt?: number };
}

async function readSessionEvents(
  app: ReturnType<typeof createRemoteApp>["app"],
  token: string,
  sessionId: string,
  offset: string,
  timeoutMs = 1_000,
): Promise<{
  events: Array<{ kind: string; payload: any; streamOffset: string }>;
  nextOffset: string;
}> {
  const response = await app.request(
    `/v1/streams/sessions/${sessionId}/events?live=long-poll&offset=${encodeURIComponent(offset)}&timeoutMs=${timeoutMs}`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );

  if (response.status === 204) {
    return {
      events: [],
      nextOffset: response.headers.get("Stream-Next-Offset") ?? offset,
    };
  }

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    events: Array<{ kind: string; payload: any; streamOffset: string }>;
    nextOffset: string;
  };
  return {
    events: body.events,
    nextOffset: body.nextOffset,
  };
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
    const read = await readSessionEvents(app, token, sessionId, nextOffset, 1_000);
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
  delayMs = 50,
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

async function writeSessionFile(input: {
  sessionPath: string;
  sessionId: string;
  cwd: string;
  sessionName?: string;
  parentSessionPath?: string;
}): Promise<void> {
  await mkdir(dirname(input.sessionPath), { recursive: true });
  await writeFile(
    input.sessionPath,
    [
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
      "",
    ].join("\n"),
  );
}

timedTest("milestone 1 flow works end to end", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const authHeaders = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ sessionName: "Milestone Session" }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };
    assert.ok(created.sessionId);

    const snapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    assert.equal(snapshotResponse.status, 200);
    const snapshot = (await snapshotResponse.json()) as {
      sessionId: string;
      lastSessionStreamOffset: string;
    };
    assert.equal(snapshot.sessionId, created.sessionId);

    const firstAttach = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    assert.equal(firstAttach.status, 200);
    const firstAttachBody = (await firstAttach.json()) as {
      events: unknown[];
      nextOffset: string;
      streamClosed: boolean;
    };
    assert.deepEqual(firstAttachBody.events, []);
    assert.equal(firstAttachBody.nextOffset, "0000000000000000_0000000000000000");
    assert.equal(firstAttachBody.streamClosed, false);

    const reconnect = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=${encodeURIComponent(firstAttachBody.nextOffset)}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    assert.equal(reconnect.status, 200);
    const reconnectBody = (await reconnect.json()) as {
      events: unknown[];
      nextOffset: string;
      streamClosed: boolean;
    };
    assert.deepEqual(reconnectBody.events, []);
    assert.equal(reconnectBody.nextOffset, firstAttachBody.nextOffset);
    assert.equal(reconnectBody.streamClosed, false);

    const appStream = await remote.app.request("/v1/streams/app-events", {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(appStream.status, 200);
    const appStreamBody = (await appStream.json()) as {
      events: Array<{ kind: string }>;
      nextOffset: string;
      streamClosed: boolean;
    };
    assert.equal(appStreamBody.events.length, 1);
    assert.equal(appStreamBody.events[0]?.kind, "session_created");
    assert.equal(appStreamBody.nextOffset, "0000000000000000_0000000000000001");
    assert.equal(appStreamBody.streamClosed, false);

    const appReconnect = await remote.app.request(
      `/v1/streams/app-events?offset=${encodeURIComponent(appStreamBody.nextOffset)}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    assert.equal(appReconnect.status, 200);
    const appReconnectBody = (await appReconnect.json()) as {
      events: unknown[];
      streamClosed: boolean;
    };
    assert.deepEqual(appReconnectBody.events, []);
    assert.equal(appReconnectBody.streamClosed, false);

    const openApiResponse = await remote.app.request("/openapi.json");
    assert.equal(openApiResponse.status, 200);
    const openApi = (await openApiResponse.json()) as { paths: Record<string, unknown> };
    assert.ok(openApi.paths["/v1/auth/challenge"]);
    assert.ok(openApi.paths["/v1/auth/verify"]);
    assert.ok(openApi.paths["/v1/app/snapshot"]);
    assert.ok(openApi.paths["/v1/sessions"]);
    assert.ok(openApi.paths["/v1/sessions/{sessionId}/snapshot"]);
    assert.ok(openApi.paths["/v1/sessions/{sessionId}/prompt"]);
    assert.ok(openApi.paths["/v1/sessions/{sessionId}/steer"]);
    assert.ok(openApi.paths["/v1/sessions/{sessionId}/follow-up"]);
    assert.ok(openApi.paths["/v1/sessions/{sessionId}/interrupt"]);
    assert.ok(openApi.paths["/v1/sessions/{sessionId}/model"]);
    assert.ok(openApi.paths["/v1/sessions/{sessionId}/session-name"]);
    assert.ok(openApi.paths["/v1/sessions/{sessionId}/ui-response"]);
    assert.ok(openApi.paths["/v1/sessions/{sessionId}/clear-queue"]);
    const appStreamResponses = (openApi.paths["/v1/streams/app-events"] as any)?.get?.responses;
    assert.ok(appStreamResponses?.["200"]?.content?.["application/json"]);
    assert.ok(appStreamResponses?.["200"]?.content?.["text/event-stream"]);
  } finally {
    await remote.dispose();
  }
});

timedTest("health endpoint reports ready status", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

  try {
    const response = await remote.app.request("/health", {
      method: "GET",
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      ok: boolean;
      service: string;
    };
    assert.equal(body.ok, true);
    assert.equal(body.service, "pi-remote");
  } finally {
    await remote.dispose();
  }
});

timedTest("stream endpoints reject malformed offsets", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

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
    const created = (await createResponse.json()) as { sessionId: string };

    const appStream = await remote.app.request("/v1/streams/app-events?offset=bad-offset", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(appStream.status, 400);

    const sessionStream = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=bad-offset`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    assert.equal(sessionStream.status, 400);
  } finally {
    await remote.dispose();
  }
});

timedTest("readAndSubscribe includes replay and post-subscribe events", () => {
  const streams = new InMemoryDurableStreamStore();
  const streamId = "app-events";
  streams.ensureStream(streamId);

  const first = streams.append(streamId, {
    sessionId: null,
    kind: "server_notice",
    payload: { message: "first" },
  });

  const seen: string[] = [];
  const subscription = streams.readAndSubscribe(streamId, first.streamOffset, (event) => {
    seen.push(event.kind);
  });

  const second = streams.append(streamId, {
    sessionId: null,
    kind: "auth_notice",
    payload: { message: "second" },
  });

  assert.equal(subscription.read.events.length, 0);
  assert.equal(subscription.read.nextOffset, first.streamOffset);
  assert.deepEqual(seen, ["auth_notice"]);
  assert.equal(second.kind, "auth_notice");
  subscription.unsubscribe();
});

timedTest("stream endpoints accept durable protocol sentinel offsets", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

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
    assert.equal(createResponse.status, 201);

    const fromStart = await remote.app.request("/v1/streams/app-events?offset=-1", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(fromStart.status, 200);
    const fromStartBody = (await fromStart.json()) as {
      events: Array<{ kind: string }>;
      fromOffset: string;
    };
    assert.equal(fromStartBody.fromOffset, "-1");
    assert.equal(fromStartBody.events.length, 1);
    assert.equal(fromStartBody.events[0]?.kind, "session_created");

    const fromNow = await remote.app.request("/v1/streams/app-events?offset=now", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(fromNow.status, 200);
    const fromNowBody = (await fromNow.json()) as {
      events: unknown[];
      fromOffset: string;
      nextOffset: string;
    };
    assert.deepEqual(fromNowBody.events, []);
    assert.equal(fromNowBody.fromOffset, fromNowBody.nextOffset);
  } finally {
    await remote.dispose();
  }
});

timedTest("live stream modes require offset", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

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
    const created = (await createResponse.json()) as { sessionId: string };

    const appSse = await remote.app.request("/v1/streams/app-events?live=sse", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(appSse.status, 400);

    const sessionLongPoll = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?live=long-poll`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    assert.equal(sessionLongPoll.status, 400);
  } finally {
    await remote.dispose();
  }
});

timedTest("long-poll timeout returns 204 with stream headers", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

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
    const created = (await createResponse.json()) as { sessionId: string };

    const longPoll = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?live=long-poll&offset=${encodeURIComponent("0000000000000000_0000000000000000")}&timeoutMs=250`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );

    assert.equal(longPoll.status, 204);
    assert.equal(longPoll.headers.get("Stream-Next-Offset"), "0000000000000000_0000000000000000");
    assert.equal(longPoll.headers.get("Stream-Up-To-Date"), "true");
    assert.equal(longPoll.headers.get("Stream-Closed"), null);
    assert.match(longPoll.headers.get("Stream-Cursor") ?? "", /^\d+$/);
  } finally {
    await remote.dispose();
  }
});

timedTest("long-poll with offset=now returns newly appended events", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const headers = { authorization: `Bearer ${token}` };

    const longPollPromise = remote.app.request(
      "/v1/streams/app-events?live=long-poll&offset=now&timeoutMs=1000",
      {
        headers,
      },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(createResponse.status, 201);

    const longPoll = await longPollPromise;
    assert.equal(longPoll.status, 200);
    const body = (await longPoll.json()) as {
      events: Array<{ kind: string }>;
      timedOut?: boolean;
    };

    assert.equal(body.events.length, 1);
    assert.equal(body.events[0]?.kind, "session_created");
  } finally {
    await remote.dispose();
  }
});

timedTest("sse uses data and control events", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

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
    assert.equal(createResponse.status, 201);

    const sse = await remote.app.request(
      "/v1/streams/app-events?live=sse&offset=0000000000000000_0000000000000000",
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );

    assert.equal(sse.status, 200);
    assert.equal(sse.headers.get("content-type"), "text/event-stream");
    assert.equal(sse.headers.get("Stream-Next-Offset"), "0000000000000000_0000000000000001");
    assert.match(sse.headers.get("Stream-Cursor") ?? "", /^\d+$/);

    const reader = sse.body?.getReader();
    assert.ok(reader);
    let payload = "";
    for (let index = 0; index < 4; index += 1) {
      const chunk = await reader!.read();
      if (chunk.done) {
        break;
      }
      payload += new TextDecoder().decode(chunk.value);
      if (payload.includes("event: control")) {
        break;
      }
    }

    await reader?.cancel();
    assert.match(payload, /event: data/);
    assert.match(payload, /event: control/);
    assert.match(payload, /"streamNextOffset":"0000000000000000_0000000000000001"/);
    assert.match(payload, /"streamCursor":"\d+"/);
    assert.doesNotMatch(payload, /event: ready/);
  } finally {
    await remote.dispose();
  }
});

timedTest("auth service prunes expired and consumed records", () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  let now = 0;
  const auth = new AuthService({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    challengeTtlMs: 10,
    tokenTtlMs: 10,
    now: () => now,
  });

  const challenge = auth.createChallenge("dev");
  const signature = sign(
    null,
    Buffer.from(
      createChallengePayload({
        challengeId: challenge.challengeId,
        keyId: "dev",
        nonce: challenge.nonce,
        origin: challenge.origin,
        expiresAt: challenge.expiresAt,
      }),
    ),
    privateKeyPem,
  ).toString("base64");

  auth.verifyChallenge({
    challengeId: challenge.challengeId,
    keyId: "dev",
    signature,
  });

  assert.equal((auth as any).challenges.size, 0);
  assert.equal((auth as any).tokens.size, 1);

  now = 100;
  auth.createChallenge("dev");
  assert.equal((auth as any).tokens.size, 0);
  assert.equal((auth as any).challenges.size, 1);
});

timedTest("auth service rejects non-ed25519 public keys", () => {
  const rsaKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaPublicKeyPem = rsaKeys.publicKey.export({ type: "spki", format: "pem" }).toString();

  assert.throws(
    () =>
      new AuthService({
        origin: "http://localhost:3000",
        allowedKeys: [{ keyId: "rsa", publicKey: rsaPublicKeyPem }],
      }),
    /ed25519/,
  );

  const ed25519Keys = generateKeyPairSync("ed25519");
  const ed25519PublicKeyPem = ed25519Keys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();

  const auth = new AuthService({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "ed", publicKey: ed25519PublicKeyPem }],
  });
  const challenge = auth.createChallenge("ed");
  assert.equal(challenge.algorithm, "ed25519");
});

timedTest("session creation remains stable under concurrent requests", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const runtimeFactory = new SlowRuntimeFactory(75);
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory,
  });

  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    const [first, second] = await Promise.all([
      remote.app.request("/v1/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({ sessionName: "one" }),
      }),
      remote.app.request("/v1/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({ sessionName: "two" }),
      }),
    ]);

    const statuses = [first.status, second.status].toSorted((a, b) => a - b);
    assert.deepEqual(statuses, [201, 201]);
    assert.equal(runtimeFactory.createCalls, 2);

    const snapshotResponse = await remote.app.request("/v1/app/snapshot", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(snapshotResponse.status, 200);
    const snapshot = (await snapshotResponse.json()) as {
      sessionSummaries: Array<{ sessionId: string }>;
    };
    assert.equal(snapshot.sessionSummaries.length, 2);
  } finally {
    await remote.dispose();
  }
});

timedTest("presence tracks concurrent tokens independently", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
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
      body: JSON.stringify({}),
    });
    const created = (await createResponse.json()) as { sessionId: string };

    const snapshotB = await remote.app.request(`/v1/sessions/${created.sessionId}/snapshot`, {
      headers: { authorization: `Bearer ${tokenB}` },
    });

    assert.equal(snapshotB.status, 200);
    const snapshot = (await snapshotB.json()) as {
      presence: Array<{ clientId: string; connectionId: string }>;
    };
    assert.equal(snapshot.presence.length, 2);
    assert.equal(snapshot.presence[0]?.clientId, "dev");
    assert.equal(snapshot.presence[1]?.clientId, "dev");
    assert.notEqual(snapshot.presence[0]?.connectionId, snapshot.presence[1]?.connectionId);
  } finally {
    await remote.dispose();
  }
});

timedTest("connection capabilities endpoint stores flags and snapshots expose them", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const capabilitiesResponse = await remote.app.request("/v1/connections/conn-a/capabilities", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocolVersion: "1.0",
        primitives: {
          select: true,
          confirm: true,
          input: true,
          editor: true,
          custom: false,
          setWidget: true,
          setHeader: false,
          setFooter: false,
          setEditorComponent: false,
          onTerminalInput: false,
        },
      }),
    });

    assert.equal(capabilitiesResponse.status, 200);

    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-pi-connection-id": "conn-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    const snapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          "x-pi-connection-id": "conn-a",
        },
      },
    );
    assert.equal(snapshotResponse.status, 200);

    const snapshot = (await snapshotResponse.json()) as {
      presence: Array<{
        connectionId: string;
        clientCapabilities?: {
          protocolVersion: string;
          primitives: { custom: boolean; setHeader: boolean; setFooter: boolean };
        };
      }>;
    };

    assert.equal(snapshot.presence[0]?.connectionId, "conn-a");
    assert.equal(snapshot.presence[0]?.clientCapabilities?.protocolVersion, "1.0");
    assert.equal(snapshot.presence[0]?.clientCapabilities?.primitives.custom, false);
    assert.equal(snapshot.presence[0]?.clientCapabilities?.primitives.setHeader, false);
    assert.equal(snapshot.presence[0]?.clientCapabilities?.primitives.setFooter, false);
  } finally {
    await remote.dispose();
  }
});

timedTest(
  "connection capabilities are isolated per authenticated client for shared connection ids",
  async () => {
    const keysA = generateKeyPairSync("ed25519");
    const publicKeyPemA = keysA.publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPemA = keysA.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const keysB = generateKeyPairSync("ed25519");
    const publicKeyPemB = keysB.publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPemB = keysB.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    const remote = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [
        { keyId: "dev-a", publicKey: publicKeyPemA },
        { keyId: "dev-b", publicKey: publicKeyPemB },
      ],
      runtimeFactory: new FakeRuntimeFactory(),
    });

    try {
      const tokenA = await authenticate(remote.app, privateKeyPemA, "dev-a");
      const tokenB = await authenticate(remote.app, privateKeyPemB, "dev-b");

      const capabilitiesA = await remote.app.request("/v1/connections/conn-shared/capabilities", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenA}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocolVersion: "1.0",
          primitives: {
            select: true,
            confirm: true,
            input: true,
            editor: true,
            custom: false,
            setWidget: true,
            setHeader: false,
            setFooter: false,
            setEditorComponent: false,
            onTerminalInput: false,
          },
        }),
      });
      assert.equal(capabilitiesA.status, 200);

      const capabilitiesB = await remote.app.request("/v1/connections/conn-shared/capabilities", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenB}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocolVersion: "1.0",
          primitives: {
            select: true,
            confirm: true,
            input: true,
            editor: true,
            custom: true,
            setWidget: true,
            setHeader: true,
            setFooter: true,
            setEditorComponent: true,
            onTerminalInput: true,
          },
        }),
      });
      assert.equal(capabilitiesB.status, 200);

      const createResponse = await remote.app.request("/v1/sessions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenA}`,
          "x-pi-connection-id": "conn-shared",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      assert.equal(createResponse.status, 201);
      const created = (await createResponse.json()) as { sessionId: string };

      const snapshotA = await remote.app.request(`/v1/sessions/${created.sessionId}/snapshot`, {
        headers: {
          authorization: `Bearer ${tokenA}`,
          "x-pi-connection-id": "conn-shared",
        },
      });
      assert.equal(snapshotA.status, 200);
      const bodyA = (await snapshotA.json()) as {
        presence: Array<{
          connectionId: string;
          clientCapabilities?: { primitives: { custom: boolean; setHeader: boolean } };
        }>;
      };
      assert.equal(bodyA.presence[0]?.connectionId, "conn-shared");
      assert.equal(bodyA.presence[0]?.clientCapabilities?.primitives.custom, false);
      assert.equal(bodyA.presence[0]?.clientCapabilities?.primitives.setHeader, false);

      const snapshotB = await remote.app.request(`/v1/sessions/${created.sessionId}/snapshot`, {
        headers: {
          authorization: `Bearer ${tokenB}`,
          "x-pi-connection-id": "conn-shared",
        },
      });
      assert.equal(snapshotB.status, 200);
      const bodyB = (await snapshotB.json()) as {
        presence: Array<{
          connectionId: string;
          clientCapabilities?: { primitives: { custom: boolean; setHeader: boolean } };
        }>;
      };
      assert.equal(bodyB.presence[0]?.connectionId, "conn-shared");
      assert.equal(bodyB.presence[0]?.clientCapabilities?.primitives.custom, true);
      assert.equal(bodyB.presence[0]?.clientCapabilities?.primitives.setHeader, true);
    } finally {
      await remote.dispose();
    }
  },
);

timedTest("remote kv store backend is pluggable", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const kvStore = new InMemoryRemoteKvStore({ now: () => 1_700_000_000_000 });

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
    kvStore,
  });

  try {
    const token = await authenticate(remote.app, privateKeyPem);

    await writeRemoteKvValue({
      app: remote.app,
      token,
      scope: "user",
      namespace: "review",
      key: "state",
      value: { active: true },
    });

    const read = await readRemoteKvValue({
      app: remote.app,
      token,
      scope: "user",
      namespace: "review",
      key: "state",
    });

    assert.equal(read.found, true);
    assert.deepEqual(read.value, { active: true });
    assert.equal(read.updatedAt, 1_700_000_000_000);
  } finally {
    await remote.dispose();
  }
});

timedTest("default json-file kv backend persists global and user namespaces", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const kvRoot = await mkdtemp(join(tmpdir(), "pi-remote-kv-"));
  const kvFilePath = join(kvRoot, "kv.json");

  try {
    const remoteA = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: new FakeRuntimeFactory(),
      kvFilePath,
    });

    try {
      const token = await authenticate(remoteA.app, privateKeyPem);

      const globalWrite = await writeRemoteKvValue({
        app: remoteA.app,
        token,
        scope: "global",
        namespace: "openusage",
        key: "selected-account",
        value: "host",
      });
      const userWrite = await writeRemoteKvValue({
        app: remoteA.app,
        token,
        scope: "user",
        namespace: "openusage",
        key: "selected-account",
        value: "cliproxy:work",
      });

      assert.equal(typeof globalWrite.updatedAt, "number");
      assert.equal(typeof userWrite.updatedAt, "number");
    } finally {
      await remoteA.dispose();
    }

    const remoteB = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: new FakeRuntimeFactory(),
      kvFilePath,
    });

    try {
      const token = await authenticate(remoteB.app, privateKeyPem);

      const globalRead = await readRemoteKvValue({
        app: remoteB.app,
        token,
        scope: "global",
        namespace: "openusage",
        key: "selected-account",
      });
      const userRead = await readRemoteKvValue({
        app: remoteB.app,
        token,
        scope: "user",
        namespace: "openusage",
        key: "selected-account",
      });

      assert.equal(globalRead.found, true);
      assert.equal(globalRead.value, "host");
      assert.equal(userRead.found, true);
      assert.equal(userRead.value, "cliproxy:work");
    } finally {
      await remoteB.dispose();
    }
  } finally {
    await rm(kvRoot, { recursive: true, force: true });
  }
});

timedTest(
  "persistent remote sessions rebuild catalog on restart with authoritative summaries",
  async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const originalCwd = process.cwd();
    const root = await mkdtemp(join(tmpdir(), "pi-remote-session-catalog-"));
    const agentDir = join(root, "agent");
    const workspaceDir = join(root, "workspace");

    await mkdir(workspaceDir, { recursive: true });

    try {
      const remoteA = createRemoteApp({
        origin: "http://localhost:3000",
        allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
        runtimeFactory: InMemoryPiRuntimeFactory({
          cwd: workspaceDir,
          agentDir,
          persistSessions: true,
        }),
      });

      let createdSessionId = "";

      try {
        const token = await authenticate(remoteA.app, privateKeyPem);
        const createResponse = await remoteA.app.request("/v1/sessions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ sessionName: "Persistent Catalog Session" }),
        });

        assert.equal(createResponse.status, 201);
        const created = (await createResponse.json()) as { sessionId: string };
        createdSessionId = created.sessionId;

        const summaryResponse = await remoteA.app.request(
          `/v1/sessions/${createdSessionId}/summary`,
          {
            headers: { authorization: `Bearer ${token}` },
          },
        );
        assert.equal(summaryResponse.status, 200);
        const summary = (await summaryResponse.json()) as {
          sessionId: string;
          sessionName: string;
          cwd: string;
          parentSessionId: string | null;
          lifecycle: {
            persistence: string;
            loaded: boolean;
            state: string;
          };
        };
        assert.equal(summary.sessionId, createdSessionId);
        assert.equal(summary.sessionName, "Persistent Catalog Session");
        assert.equal(summary.cwd, workspaceDir);
        assert.equal(summary.parentSessionId, null);
        assert.equal(summary.lifecycle.persistence, "persistent");
        assert.equal(summary.lifecycle.loaded, true);
        assert.equal(summary.lifecycle.state, "active");
      } finally {
        await remoteA.dispose();
      }

      const remoteB = createRemoteApp({
        origin: "http://localhost:3000",
        allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
        runtimeFactory: InMemoryPiRuntimeFactory({
          cwd: workspaceDir,
          agentDir,
          persistSessions: true,
        }),
      });

      try {
        const token = await authenticate(remoteB.app, privateKeyPem);

        const snapshotResponse = await remoteB.app.request("/v1/app/snapshot", {
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(snapshotResponse.status, 200);
        const snapshot = (await snapshotResponse.json()) as {
          defaultAttachSessionId?: string;
          sessionSummaries: Array<{
            sessionId: string;
            sessionName: string;
            cwd: string;
            parentSessionId: string | null;
            lifecycle: {
              persistence: string;
              loaded: boolean;
              state: string;
            };
          }>;
        };

        assert.equal(snapshot.defaultAttachSessionId, undefined);
        assert.equal(snapshot.sessionSummaries.length, 1);
        assert.equal(snapshot.sessionSummaries[0]?.sessionId, createdSessionId);
        assert.equal(snapshot.sessionSummaries[0]?.sessionName, "Persistent Catalog Session");
        assert.equal(snapshot.sessionSummaries[0]?.cwd, workspaceDir);
        assert.equal(snapshot.sessionSummaries[0]?.parentSessionId, null);
        assert.equal(snapshot.sessionSummaries[0]?.lifecycle.persistence, "persistent");
        assert.equal(snapshot.sessionSummaries[0]?.lifecycle.loaded, false);
        assert.equal(snapshot.sessionSummaries[0]?.lifecycle.state, "active");

        const summaryResponse = await remoteB.app.request(
          `/v1/sessions/${createdSessionId}/summary`,
          {
            headers: { authorization: `Bearer ${token}` },
          },
        );
        assert.equal(summaryResponse.status, 200);
        const summary = (await summaryResponse.json()) as {
          sessionId: string;
          sessionName: string;
          cwd: string;
          parentSessionId: string | null;
          lifecycle: {
            persistence: string;
            loaded: boolean;
            state: string;
          };
        };
        assert.equal(summary.sessionId, createdSessionId);
        assert.equal(summary.sessionName, "Persistent Catalog Session");
        assert.equal(summary.cwd, workspaceDir);
        assert.equal(summary.parentSessionId, null);
        assert.equal(summary.lifecycle.persistence, "persistent");
        assert.equal(summary.lifecycle.loaded, false);
        assert.equal(summary.lifecycle.state, "active");
        assert.equal("sessionFile" in summary, false);
      } finally {
        await remoteB.dispose();
      }
    } finally {
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
  },
);

timedTest("persistent remote session lazily loads runtime on attach after restart", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const originalCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "pi-remote-lazy-attach-"));
  const agentDir = join(root, "agent");
  const workspaceDir = join(root, "workspace");

  await mkdir(workspaceDir, { recursive: true });

  try {
    const runtimeFactoryA = new CountingRuntimeFactory(
      InMemoryPiRuntimeFactory({
        cwd: workspaceDir,
        agentDir,
        persistSessions: true,
      }),
    );
    const remoteA = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: runtimeFactoryA,
    });

    let createdSessionId = "";

    try {
      const token = await authenticate(remoteA.app, privateKeyPem);
      const createResponse = await remoteA.app.request("/v1/sessions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionName: "Lazy Attach Session" }),
      });

      assert.equal(createResponse.status, 201);
      createdSessionId = ((await createResponse.json()) as { sessionId: string }).sessionId;
      assert.equal(runtimeFactoryA.createCalls, 1);
      assert.equal(runtimeFactoryA.loadCalls, 0);
    } finally {
      await remoteA.dispose();
    }

    const runtimeFactoryB = new CountingRuntimeFactory(
      InMemoryPiRuntimeFactory({
        cwd: workspaceDir,
        agentDir,
        persistSessions: true,
      }),
    );
    const remoteB = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: runtimeFactoryB,
    });

    try {
      const token = await authenticate(remoteB.app, privateKeyPem);

      const appSnapshotResponse = await remoteB.app.request("/v1/app/snapshot", {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(appSnapshotResponse.status, 200);
      const appSnapshot = (await appSnapshotResponse.json()) as {
        sessionSummaries: Array<{
          sessionId: string;
          cwd: string;
          lifecycle: { loaded: boolean };
        }>;
      };

      assert.equal(appSnapshot.sessionSummaries[0]?.sessionId, createdSessionId);
      assert.equal(appSnapshot.sessionSummaries[0]?.cwd, workspaceDir);
      assert.equal(appSnapshot.sessionSummaries[0]?.lifecycle.loaded, false);
      assert.equal(runtimeFactoryB.createCalls, 0);
      assert.equal(runtimeFactoryB.loadCalls, 0);

      const sessionSnapshotResponse = await remoteB.app.request(
        `/v1/sessions/${createdSessionId}/snapshot`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      assert.equal(sessionSnapshotResponse.status, 200);
      const sessionSnapshot = (await sessionSnapshotResponse.json()) as {
        sessionId: string;
        cwd: string;
      };

      assert.equal(sessionSnapshot.sessionId, createdSessionId);
      assert.equal(sessionSnapshot.cwd, workspaceDir);
      assert.equal(runtimeFactoryB.createCalls, 0);
      assert.equal(runtimeFactoryB.loadCalls, 1);

      const summaryResponse = await remoteB.app.request(
        `/v1/sessions/${createdSessionId}/summary`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      assert.equal(summaryResponse.status, 200);
      const summary = (await summaryResponse.json()) as {
        lifecycle: { loaded: boolean };
      };

      assert.equal(summary.lifecycle.loaded, true);

      const secondSnapshotResponse = await remoteB.app.request(
        `/v1/sessions/${createdSessionId}/snapshot`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      assert.equal(secondSnapshotResponse.status, 200);
      assert.equal(runtimeFactoryB.loadCalls, 1);
    } finally {
      await remoteB.dispose();
    }
  } finally {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

timedTest("persistent remote session lazily loads runtime for commands after restart", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const originalCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "pi-remote-lazy-command-"));
  const agentDir = join(root, "agent");
  const workspaceDir = join(root, "workspace");

  await mkdir(workspaceDir, { recursive: true });

  try {
    const remoteA = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: InMemoryPiRuntimeFactory({
        cwd: workspaceDir,
        agentDir,
        persistSessions: true,
      }),
    });

    let createdSessionId = "";

    try {
      const token = await authenticate(remoteA.app, privateKeyPem);
      const createResponse = await remoteA.app.request("/v1/sessions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionName: "Lazy Command Session" }),
      });

      assert.equal(createResponse.status, 201);
      createdSessionId = ((await createResponse.json()) as { sessionId: string }).sessionId;
    } finally {
      await remoteA.dispose();
    }

    const runtimeFactoryB = new CountingRuntimeFactory(
      InMemoryPiRuntimeFactory({
        cwd: workspaceDir,
        agentDir,
        persistSessions: true,
      }),
    );
    const remoteB = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: runtimeFactoryB,
    });

    try {
      const token = await authenticate(remoteB.app, privateKeyPem);

      const promptResponse = await remoteB.app.request(`/v1/sessions/${createdSessionId}/prompt`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "load persisted runtime and prompt" }),
      });
      assert.equal(promptResponse.status, 202);
      assert.equal(runtimeFactoryB.createCalls, 0);
      assert.equal(runtimeFactoryB.loadCalls, 1);

      const summaryResponse = await remoteB.app.request(
        `/v1/sessions/${createdSessionId}/summary`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      assert.equal(summaryResponse.status, 200);
      const summary = (await summaryResponse.json()) as {
        cwd: string;
        lifecycle: { loaded: boolean };
      };

      assert.equal(summary.cwd, workspaceDir);
      assert.equal(summary.lifecycle.loaded, true);
    } finally {
      await remoteB.dispose();
    }
  } finally {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

timedTest("missing session summary returns 404", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const response = await remote.app.request("/v1/sessions/missing/summary", {
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 404);
  } finally {
    await remote.dispose();
  }
});

timedTest(
  "remote session archive restore and delete lifecycle works for loaded and unloaded sessions",
  async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const originalCwd = process.cwd();
    const root = await mkdtemp(join(tmpdir(), "pi-remote-lifecycle-"));
    const agentDir = join(root, "agent");
    const workspaceDir = join(root, "workspace");

    await mkdir(workspaceDir, { recursive: true });

    try {
      const runtimeFactory = InMemoryPiRuntimeFactory({
        cwd: workspaceDir,
        agentDir,
        persistSessions: true,
      });
      const catalogRoot = runtimeFactory.getSessionCatalogRoot?.();
      const remote = createRemoteApp({
        origin: "http://localhost:3000",
        allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
        runtimeFactory,
      });

      try {
        const token = await authenticate(remote.app, privateKeyPem);

        const createAResponse = await remote.app.request("/v1/sessions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ sessionName: "Archive Me" }),
        });
        assert.equal(createAResponse.status, 201);
        const sessionAId = ((await createAResponse.json()) as { sessionId: string }).sessionId;

        const archivedResponse = await remote.app.request(`/v1/sessions/${sessionAId}/archive`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(archivedResponse.status, 200);
        const archivedSummary = (await archivedResponse.json()) as {
          lifecycle: { loaded: boolean; state: string };
        };
        assert.equal(archivedSummary.lifecycle.loaded, false);
        assert.equal(archivedSummary.lifecycle.state, "archived");

        const archivedCatalog = new SessionCatalog({ rootDir: catalogRoot });
        const archivedRecord = archivedCatalog.get(sessionAId);
        assert.ok(archivedRecord);
        assert.match(archivedRecord?.sessionPath ?? "", /\.archive/);
        await assert.doesNotReject(() => readFile(archivedRecord?.sessionPath ?? ""));

        const restoredResponse = await remote.app.request(`/v1/sessions/${sessionAId}/restore`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(restoredResponse.status, 200);
        const restoredSummary = (await restoredResponse.json()) as {
          lifecycle: { loaded: boolean; state: string };
        };
        assert.equal(restoredSummary.lifecycle.loaded, false);
        assert.equal(restoredSummary.lifecycle.state, "active");

        const restoredCatalog = new SessionCatalog({ rootDir: catalogRoot });
        const restoredRecord = restoredCatalog.get(sessionAId);
        assert.ok(restoredRecord);
        assert.doesNotMatch(restoredRecord?.sessionPath ?? "", /\.archive/);

        const deleteUnloadedResponse = await remote.app.request(`/v1/sessions/${sessionAId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(deleteUnloadedResponse.status, 200);
        assert.deepEqual(await deleteUnloadedResponse.json(), {
          sessionId: sessionAId,
          deleted: true,
        });

        const deletedSummaryResponse = await remote.app.request(
          `/v1/sessions/${sessionAId}/summary`,
          {
            headers: { authorization: `Bearer ${token}` },
          },
        );
        assert.equal(deletedSummaryResponse.status, 404);

        const createBResponse = await remote.app.request("/v1/sessions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ sessionName: "Delete Me Loaded" }),
        });
        assert.equal(createBResponse.status, 201);
        const sessionBId = ((await createBResponse.json()) as { sessionId: string }).sessionId;

        const deleteLoadedResponse = await remote.app.request(`/v1/sessions/${sessionBId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(deleteLoadedResponse.status, 200);
        assert.deepEqual(await deleteLoadedResponse.json(), {
          sessionId: sessionBId,
          deleted: true,
        });

        const snapshotResponse = await remote.app.request("/v1/app/snapshot", {
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(snapshotResponse.status, 200);
        const snapshot = (await snapshotResponse.json()) as {
          sessionSummaries: Array<{ sessionId: string }>;
        };
        assert.deepEqual(snapshot.sessionSummaries, []);

        const appEventsResponse = await remote.app.request("/v1/streams/app-events", {
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(appEventsResponse.status, 200);
        const appEventsBody = await appEventsResponse.json();
        assertType(StreamReadResponseSchema, appEventsBody);
        assert.deepEqual(
          appEventsBody.events.map((event) => event.kind),
          [
            "session_created",
            "session_summary_updated",
            "session_summary_updated",
            "session_closed",
            "session_created",
            "session_closed",
          ],
        );
      } finally {
        await remote.dispose();
      }
    } finally {
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
  },
);

timedTest("session catalog rethrows unexpected scan failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-session-catalog-error-"));
  const filePath = join(root, "not-a-directory");

  await writeFile(filePath, "x");

  try {
    assert.throws(() => new SessionCatalog({ rootDir: filePath }), /ENOTDIR/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

timedTest("session catalog preserves parent linkage across archive and restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-session-parent-linkage-"));
  const sessionRoot = join(root, "sessions");
  const parentPath = join(sessionRoot, "parent.jsonl");
  const childPath = join(sessionRoot, "child.jsonl");
  const timestamp = new Date().toISOString();

  await mkdir(sessionRoot, { recursive: true });
  await writeFile(
    parentPath,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "parent-session",
      timestamp,
      cwd: "/srv/workspace",
    })}\n`,
  );
  await writeFile(
    childPath,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "child-session",
      timestamp,
      cwd: "/srv/workspace",
      parentSession: parentPath,
    })}\n`,
  );

  try {
    const catalog = new SessionCatalog({ rootDir: sessionRoot });
    assert.equal(catalog.get("child-session")?.parentSessionId, "parent-session");

    const archived = catalog.archive("child-session");
    assert.equal(archived.parentSessionId, "parent-session");
    assert.equal(archived.lifecycleStatus, "archived");

    const restored = catalog.restore("child-session");
    assert.equal(restored.parentSessionId, "parent-session");
    assert.equal(restored.lifecycleStatus, "active");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

timedTest("session catalog scan marks archived files as archived", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-session-archived-scan-"));
  const archivedRoot = join(root, ".archive", "nested");
  const archivedPath = join(archivedRoot, "archived.jsonl");

  await mkdir(archivedRoot, { recursive: true });
  await writeFile(
    archivedPath,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "archived-session",
      timestamp: new Date().toISOString(),
      cwd: "/srv/workspace",
    })}\n`,
  );

  try {
    const catalog = new SessionCatalog({ rootDir: root });
    const record = catalog.get("archived-session");
    assert.ok(record);
    assert.equal(record?.lifecycleStatus, "archived");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

timedTest("remote app watcher reconciles external session add change and remove", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const root = await mkdtemp(join(tmpdir(), "pi-remote-watcher-reconcile-"));
  const catalogRoot = join(root, "sessions");
  const sessionPath = join(catalogRoot, "external.jsonl");

  await mkdir(catalogRoot, { recursive: true });

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
    sessionCatalogRoot: catalogRoot,
  });

  try {
    const token = await authenticate(remote.app, privateKeyPem);

    await writeSessionFile({
      sessionPath,
      sessionId: "external-session",
      cwd: "/srv/external",
      sessionName: "External Session",
    });

    const addedSnapshot = await waitForValue(
      async () => {
        const response = await remote.app.request("/v1/app/snapshot", {
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(response.status, 200);
        return (await response.json()) as {
          sessionSummaries: Array<{ sessionId: string; sessionName: string; cwd: string }>;
        };
      },
      (snapshot) =>
        snapshot.sessionSummaries.some((summary) => summary.sessionId === "external-session"),
    );

    assert.equal(addedSnapshot.sessionSummaries[0]?.sessionName, "External Session");
    assert.equal(addedSnapshot.sessionSummaries[0]?.cwd, "/srv/external");

    await writeSessionFile({
      sessionPath,
      sessionId: "external-session",
      cwd: "/srv/external-updated",
      sessionName: "External Session Updated",
    });

    const updatedSummary = await waitForValue(
      async () => {
        const response = await remote.app.request("/v1/sessions/external-session/summary", {
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(response.status, 200);
        return (await response.json()) as { sessionName: string; cwd: string };
      },
      (summary) =>
        summary.sessionName === "External Session Updated" &&
        summary.cwd === "/srv/external-updated",
    );

    assert.equal(updatedSummary.sessionName, "External Session Updated");
    assert.equal(updatedSummary.cwd, "/srv/external-updated");

    await rm(sessionPath, { force: true });

    await waitForValue(
      async () => {
        const response = await remote.app.request("/v1/sessions/external-session/summary", {
          headers: { authorization: `Bearer ${token}` },
        });
        return response.status;
      },
      (status) => status === 404,
    );

    const appEventsResponse = await remote.app.request("/v1/streams/app-events", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(appEventsResponse.status, 200);
    const appEvents = (await appEventsResponse.json()) as { events: Array<{ kind: string }> };
    assert.deepEqual(
      appEvents.events.map((event) => event.kind),
      ["session_summary_updated", "session_summary_updated", "session_closed"],
    );
  } finally {
    await remote.dispose();
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

    assert.equal(created.sessionId, "idle-session");
    assert.equal(session.reloadCalls, 0);

    await writeSessionFile({
      sessionPath,
      sessionId: "idle-session",
      cwd: "/srv/idle-v2",
      sessionName: "Idle Session Updated",
    });
    session.cwd = "/srv/idle-v2";

    await registry.reconcileCatalogFromDisk();

    const summary = registry.getSessionSummary("idle-session");
    assert.equal(session.reloadCalls, 1);
    assert.equal(summary.sessionName, "Idle Session Updated");
    assert.equal(summary.cwd, "/srv/idle-v2");
  } finally {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

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

    assert.equal(created.sessionId, "busy-session");

    await writeSessionFile({
      sessionPath,
      sessionId: "busy-session",
      cwd: "/srv/busy-v2",
      sessionName: "Busy Session Updated",
    });

    await registry.reconcileCatalogFromDisk();

    const snapshot = registry.getSessionSnapshot("busy-session", auth, "conn-a");
    assert.equal(session.reloadCalls, 0);
    assert.equal(
      snapshot.errorMessage,
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

      assert.equal(created.sessionId, "busy-delete-session");

      await rm(sessionPath, { force: true });
      await registry.reconcileCatalogFromDisk();

      const snapshot = registry.getSessionSnapshot("busy-delete-session", auth, "conn-a");
      assert.equal(runtimeFactory.runtimeDisposeCalls, 0);
      assert.equal(snapshot.sessionId, "busy-delete-session");
      assert.equal(
        snapshot.errorMessage,
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

    assert.throws(() => watcher.start());
  } finally {
    await chmod(blockedDir, 0o755);
    await rm(root, { recursive: true, force: true });
  }
});

timedTest(
  "custom runtime factory without catalog root does not expose cwd fallback sessions",
  async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
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

        assert.equal(snapshotResponse.status, 200);
        const snapshot = (await snapshotResponse.json()) as {
          sessionSummaries: Array<{ sessionId: string }>;
        };

        assert.deepEqual(snapshot.sessionSummaries, []);
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
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

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
    assert.deepEqual(write.value, { active: true });

    const read = await client.readKv("user", "review", "state");
    assert.equal(read.found, true);
    assert.deepEqual(read.value, { active: true });

    const deleted = await client.deleteKv("user", "review", "state");
    assert.equal(deleted.deleted, true);

    const readAfterDelete = await client.readKv("user", "review", "state");
    assert.equal(readAfterDelete.found, false);
  } finally {
    await remote.dispose();
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

  assert.deepEqual(readCalls, [
    { scope: "user", namespace: "openusage", key: "state" },
    { scope: "user", namespace: "prompt-stash", key: "state" },
  ]);
  const restored = sessionManager
    .getBranch()
    .find((entry) => entry.type === "custom" && entry.customType === "openusage-state");
  assert.ok(restored);
  if (restored?.type === "custom") {
    assert.deepEqual(restored.data, {
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

  assert.equal(isKvManagedExtensionState("openusage-state"), true);
  assert.equal(isKvManagedExtensionState("prompt-stash-state"), true);
  assert.equal(isKvManagedExtensionState("review-settings"), false);

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

  assert.deepEqual(writes, [
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
    const parsed = parseRemoteArgs(["--session", "session-123", "--resume"]);
    assert.fail(`Expected parser conflict error, got ${JSON.stringify(parsed)}`);
  } catch (error) {
    assert.match(String(error), /mutually exclusive/);
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
    assert.equal(parsed.workspaceCwd, "/srv/workspace");
  } finally {
    delete process.env.PI_REMOTE_ORIGIN;
    delete process.env.PI_REMOTE_KEY_ID;
  }
});

timedTest("remote CLI parser rejects unsupported remote session-dir and export flags", async () => {
  process.env.PI_REMOTE_ORIGIN = "http://localhost:3000";
  process.env.PI_REMOTE_KEY_ID = "dev";

  try {
    assert.throws(() => parseRemoteArgs(["--session-dir", "/tmp/sessions"]), /--session-dir/);
    assert.throws(() => parseRemoteArgs(["--export", "session.jsonl"]), /--export/);
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

    assert.deepEqual(
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
          verbose: false,
          initialMessage: undefined,
          initialMessages: [],
        },
        cwd: "/workspace/a",
      }),
      { sessionId: "session-c", createNewSession: false },
    );

    assert.deepEqual(
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
      { sessionId: "session-b", createNewSession: false },
    );

    assert.deepEqual(
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
      { sessionId: "session-c", createNewSession: false },
    );

    assert.deepEqual(
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
      { createNewSession: true },
    );
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

    assert.throws(
      () =>
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
      /--workspace-cwd/,
    );

    assert.throws(
      () =>
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
      /--workspace-cwd/,
    );

    assert.throws(
      () =>
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
      /--workspace-cwd/,
    );
  },
);

timedTest("remote runtime create requires explicit workspace for new session", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(new RecordingSession()),
  });

  try {
    await assert.rejects(
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
      /workspaceCwd/,
    );

    await assert.rejects(
      RemoteAgentSessionRuntime.create({
        origin: "http://localhost:3000",
        auth: {
          keyId: "dev",
          privateKey: privateKeyPem,
        },
        clientCapabilities: REMOTE_DEFAULT_CLIENT_CAPABILITIES,
        fetchImpl: createInProcessFetch(remote.app),
      }),
      /workspaceCwd/,
    );
  } finally {
    await remote.dispose();
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
  const auth = testAuthSession();

  try {
    const created = await registry.createSession(
      { workspaceCwd: "/srv/workspace-a" },
      auth,
      "conn-a",
    );
    const snapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    assert.equal(snapshot.cwd, "/srv/workspace-a");
    assert.equal(session.cwd, "/srv/workspace-a");
  } finally {
    await registry.dispose();
  }
});

timedTest("remote snapshot and adapter expose runtime context usage", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

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
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    const snapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    assert.equal(snapshotResponse.status, 200);
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
    assert.deepEqual(snapshot.contextUsage, usage);
    assert.equal(snapshot.usageCost, 12.34);
    assert.equal(
      snapshot.sessionStats.sessionFile,
      "/tmp/pi-remote-recording-session/authoritative.jsonl",
    );
    assert.equal(snapshot.sessionStats.cost, 12.34);
    assert.deepEqual(snapshot.sessionStats.contextUsage, usage);
    assert.equal(snapshot.autoCompactionEnabled, true);
    assert.equal(snapshot.steeringMode, "one-at-a-time");
    assert.equal(snapshot.followUpMode, "all");

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });
    assert.deepEqual(runtime.session.getContextUsage(), usage);
    assert.equal(runtime.session.getSessionStats().cost, 12.34);
    assert.equal(
      runtime.session.getSessionStats().sessionFile,
      "/tmp/pi-remote-recording-session/authoritative.jsonl",
    );
    assert.equal(runtime.session.autoCompactionEnabled, true);
    assert.equal(runtime.session.steeringMode, "one-at-a-time");
    assert.equal(runtime.session.followUpMode, "all");
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote adapter mirrors snapshot transcript into session entries", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

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
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    const messageEntries = runtime.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "message");

    assert.equal(messageEntries.length, 1);
    assert.equal(messageEntries[0]?.message.role, "assistant");
    assert.equal(
      calculateTotalCost({ sessionManager: runtime.session.sessionManager } as ExtensionContext),
      0.03,
    );
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote adapter mirrors live message events into session entries", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

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
    assert.equal(createResponse.status, 201);
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

    assert.equal(messageEntries.length, 2);
    assert.equal(messageEntries[0]?.message.role, "user");
    assert.equal(messageEntries[1]?.message.role, "assistant");
    assert.equal(
      calculateTotalCost({ sessionManager: runtime.session.sessionManager } as ExtensionContext),
      0.03,
    );
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest(
  "remote adapter getSessionStats uses server-authoritative stats instead of transcript",
  async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

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
      assert.equal(createResponse.status, 201);
      const created = (await createResponse.json()) as { sessionId: string };

      runtime = await createRemoteRuntime(remote.app, {
        privateKeyPem,
        sessionId: created.sessionId,
      });

      const stats = runtime.session.getSessionStats();
      assert.equal(stats.cost, 1.23);
      assert.equal(stats.tokens.total, 10);
      assert.equal(stats.sessionFile, "/tmp/pi-remote-recording-session/authoritative-stats.jsonl");
    } finally {
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

timedTest("session state patch carries server stats and client cache updates", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
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
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    const snapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    assert.equal(snapshotResponse.status, 200);
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
      }, 10_000);

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
    assert.ok(updatedStats.totalMessages > initialStats.totalMessages);

    const replayResponse = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=${encodeURIComponent(snapshot.lastSessionStreamOffset)}`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    assert.equal(replayResponse.status, 200);
    const replay = (await replayResponse.json()) as {
      events: Array<{
        kind: string;
        payload: { patch?: { sessionStats?: { totalMessages: number } } };
      }>;
    };
    assert.equal(
      replay.events.some(
        (event) =>
          event.kind === "session_state_patch" &&
          event.payload.patch?.sessionStats !== undefined &&
          event.payload.patch.sessionStats.totalMessages > snapshot.sessionStats.totalMessages,
      ),
      true,
    );
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

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

    await assert.rejects(
      () =>
        persistManagedExtensionState({
          client,
          sessionManager,
          customType: "openusage-state",
          value: { resetTimeFormat: "absolute" },
        }),
      /kv write failed/u,
    );

    const restored = sessionManager
      .getBranch()
      .find((entry) => entry.type === "custom" && entry.customType === "openusage-state");
    assert.equal(restored, undefined);
  },
);

timedTest("session primitive capability requires advertised support", () => {
  const falseCapabilities: ClientCapabilities = {
    protocolVersion: "1.0",
    primitives: {
      select: false,
      confirm: false,
      input: false,
      editor: false,
      custom: false,
      setWidget: false,
      setHeader: false,
      setFooter: false,
      setEditorComponent: false,
      onTerminalInput: false,
    },
  };
  const trueCapabilities: ClientCapabilities = {
    ...falseCapabilities,
    primitives: {
      ...falseCapabilities.primitives,
      select: true,
    },
  };

  const noPresence = new Map<string, Presence>();
  assert.equal(hasSessionPrimitiveCapability(noPresence, "select"), false);

  const falseOnlyPresence = new Map<string, Presence>([
    [
      "a",
      {
        clientId: "client-a",
        connectionId: "connection-a",
        connectedAt: 1,
        lastSeenAt: 1,
        clientCapabilities: falseCapabilities,
        lastSeenSessionOffset: "0000000000000000_0000000000000000",
        lastSeenAppOffset: "0000000000000000_0000000000000000",
      },
    ],
  ]);
  assert.equal(hasSessionPrimitiveCapability(falseOnlyPresence, "select"), false);

  const mixedPresence = new Map<string, Presence>([
    ...falseOnlyPresence,
    [
      "b",
      {
        clientId: "client-b",
        connectionId: "connection-b",
        connectedAt: 1,
        lastSeenAt: 1,
        clientCapabilities: trueCapabilities,
        lastSeenSessionOffset: "0000000000000000_0000000000000000",
        lastSeenAppOffset: "0000000000000000_0000000000000000",
      },
    ],
  ]);
  assert.equal(hasSessionPrimitiveCapability(mixedPresence, "select"), true);
});

timedTest("authoritative cwd update refreshes local extension runner context", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
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
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    const sessionAny = runtime.session as any;
    const beforeRunner = sessionAny.localExtensionRunner;
    assert.ok(beforeRunner);
    const beforeContext = beforeRunner.createCommandContext();
    const nextCwd = `${beforeContext.cwd}-updated`;

    sessionAny.applyAuthoritativeCwdUpdate(nextCwd);

    const afterRunner = sessionAny.localExtensionRunner;
    assert.ok(afterRunner);
    assert.notEqual(afterRunner, beforeRunner);
    const afterContext = afterRunner.createCommandContext();
    assert.equal(afterContext.cwd, nextCwd);
    assert.equal(afterContext.sessionManager.getCwd(), nextCwd);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote server ui getEditorText returns empty string fallback", () => {
  const uiContext = createRemoteUiContext({
    record: {
      presence: new Map(),
    } as any,
    now: () => Date.now(),
    publishUiEvent: () => {},
  });

  assert.equal(uiContext.getEditorText(), "");
});

timedTest("remote server ui addAutocompleteProvider fails loudly", () => {
  const uiContext = createRemoteUiContext({
    record: {
      presence: new Map(),
    } as any,
    now: () => Date.now(),
    publishUiEvent: () => {},
  });

  assert.throws(() => {
    uiContext.addAutocompleteProvider((current) => current);
  }, /addAutocompleteProvider\(\) is not supported/);
});

timedTest("editor ui request ignores late response after remote cancellation", async () => {
  const pendingInteractiveRequests = new Map<string, AbortController>();
  const postedResponses: Array<unknown> = [];
  let resolveEditor: ((value: string | undefined) => void) | undefined;
  const editorResult = new Promise<string | undefined>((resolve) => {
    resolveEditor = resolve;
  });

  const uiContext = {
    editor: async () => editorResult,
  } as unknown as ExtensionUIContext;
  const client = {
    postUiResponse: async (_sessionId: string, response: unknown) => {
      postedResponses.push(response);
    },
  } as unknown as RemoteApiClient;

  const requestTask = handleRemoteUiRequest({
    uiContext,
    request: {
      id: "editor-request-1",
      method: "editor",
      title: "Edit",
      prefill: "abc",
    },
    client,
    sessionId: "session-1",
    pendingInteractiveRequests,
  });

  cancelRemoteUiRequest(pendingInteractiveRequests, "editor-request-1");
  resolveEditor?.("late-value");
  await requestTask;

  assert.deepEqual(postedResponses, []);
  assert.equal(pendingInteractiveRequests.size, 0);
});

timedTest("presence tracks concurrent connections for the same token", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

  try {
    const token = await authenticate(remote.app, privateKeyPem);

    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-pi-connection-id": "conn-a",
      },
      body: JSON.stringify({}),
    });
    const created = (await createResponse.json()) as { sessionId: string };

    const streamA = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=${encodeURIComponent("0000000000000000_0000000000000000")}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          "x-pi-connection-id": "conn-a",
        },
      },
    );
    assert.equal(streamA.status, 200);

    const streamB = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=${encodeURIComponent("0000000000000000_0000000000000000")}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          "x-pi-connection-id": "conn-b",
        },
      },
    );
    assert.equal(streamB.status, 200);

    const snapshot = await remote.app.request(`/v1/sessions/${created.sessionId}/snapshot`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-pi-connection-id": "conn-a",
      },
    });

    assert.equal(snapshot.status, 200);
    const body = (await snapshot.json()) as {
      presence: Array<{ clientId: string; connectionId: string }>;
    };
    assert.equal(body.presence.length, 2);
    const connectionIds = body.presence.map((presence) => presence.connectionId).toSorted();
    assert.deepEqual(connectionIds, ["conn-a", "conn-b"]);
    assert.equal(body.presence[0]?.clientId, "dev");
    assert.equal(body.presence[1]?.clientId, "dev");
  } finally {
    await remote.dispose();
  }
});

timedTest("presence does not grow when connection header is omitted", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

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
    const created = (await createResponse.json()) as { sessionId: string };

    const snapshotA = await remote.app.request(`/v1/sessions/${created.sessionId}/snapshot`, {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    assert.equal(snapshotA.status, 200);

    const snapshotB = await remote.app.request(`/v1/sessions/${created.sessionId}/snapshot`, {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    assert.equal(snapshotB.status, 200);

    const body = (await snapshotB.json()) as {
      presence: Array<{ connectionId: string }>;
    };
    assert.equal(body.presence.length, 1);
  } finally {
    await remote.dispose();
  }
});

timedTest("session registry prunes stale presence and supports detach", async () => {
  const streams = new InMemoryDurableStreamStore();
  let now = 0;
  const registry = new SessionRegistry({
    streams,
    runtimeFactory: new FakeRuntimeFactory(),
    presenceTtlMs: 50,
    now: () => now,
  });
  const authSession = {
    token: "token-a",
    clientId: "dev",
    keyId: "dev",
    expiresAt: 1_000,
  };

  try {
    const created = await registry.createSession({}, authSession, "conn-a");
    now = 10;
    registry.touchPresence(created.sessionId, authSession, "conn-b");

    const activeSnapshot = registry.getSessionSnapshot(created.sessionId, authSession, "conn-a");
    assert.equal(activeSnapshot.presence.length, 2);

    now = 100;
    const prunedSnapshot = registry.getSessionSnapshot(created.sessionId, authSession, "conn-c");
    assert.equal(prunedSnapshot.presence.length, 1);
    assert.equal(prunedSnapshot.presence[0]?.connectionId, "conn-c");

    registry.touchPresence(created.sessionId, authSession, "conn-d");
    registry.detachPresence(created.sessionId, "conn-d");
    const detachedSnapshot = registry.getSessionSnapshot(created.sessionId, authSession, "conn-c");
    assert.equal(detachedSnapshot.presence.length, 1);
    assert.equal(detachedSnapshot.presence[0]?.connectionId, "conn-c");
  } finally {
    await registry.dispose();
  }
});

timedTest("accepted command failure persists error state in snapshots", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  session.promptError = new Error("missing API key");
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");
    const accepted = await registry.prompt(
      created.sessionId,
      {
        text: "run",
      },
      auth,
      "conn-a",
    );
    assert.equal(accepted.sequence, 1);

    await new Promise<void>((resolve) => setImmediate(resolve));

    const firstSnapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    assert.equal(firstSnapshot.status, "error");
    assert.equal(firstSnapshot.errorMessage, "missing API key");

    const secondSnapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    assert.equal(secondSnapshot.status, "error");
    assert.equal(secondSnapshot.errorMessage, "missing API key");

    const events = streams.read(sessionEventsStreamId(created.sessionId), "-1").events;
    assert.ok(events.some((event) => event.kind === "command_accepted"));
    assert.ok(events.some((event) => event.kind === "extension_error"));
  } finally {
    await registry.dispose();
  }
});

timedTest("snapshot and summary polling keeps updatedAt stable", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  let now = 0;
  const registry = new SessionRegistry({
    streams,
    runtimeFactory: new RecordingRuntimeFactory(session),
    now: () => {
      now += 1;
      return now;
    },
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");
    const initialSnapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    const initialUpdatedAt = initialSnapshot.updatedAt;

    const polledSnapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    assert.equal(polledSnapshot.updatedAt, initialUpdatedAt);

    const summariesA = registry.listSessionSummaries();
    const summariesB = registry.listSessionSummaries();
    assert.equal(summariesA[0]?.updatedAt, initialUpdatedAt);
    assert.equal(summariesB[0]?.updatedAt, initialUpdatedAt);
  } finally {
    await registry.dispose();
  }
});

timedTest("stream read schema rejects unknown kinds and malformed payloads", () => {
  assert.throws(
    () =>
      assertType(StreamReadResponseSchema, {
        streamId: "app-events",
        fromOffset: "0000000000000000_0000000000000000",
        nextOffset: "0000000000000000_0000000000000001",
        upToDate: true,
        streamClosed: false,
        events: [
          {
            eventId: "evt-1",
            sessionId: null,
            streamOffset: "0000000000000000_0000000000000001",
            ts: Date.now(),
            kind: "unknown_kind",
            payload: {},
          },
        ],
      }),
    /Schema validation failed/,
  );

  assert.throws(
    () =>
      assertType(StreamReadResponseSchema, {
        streamId: "app-events",
        fromOffset: "0000000000000000_0000000000000000",
        nextOffset: "0000000000000000_0000000000000001",
        upToDate: true,
        streamClosed: false,
        events: [
          {
            eventId: "evt-1",
            sessionId: null,
            streamOffset: "0000000000000000_0000000000000001",
            ts: Date.now(),
            kind: "session_created",
            payload: {
              sessionId: "sess-1",
            },
          },
        ],
      }),
    /Schema validation failed/,
  );
});

timedTest("failed model update does not emit command_accepted or consume sequence", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  session.modelRegistry = {
    find: () => ({ provider: "openai", id: "gpt-4o" }),
    getAvailable: () => [session.model],
  };
  session.setModelError = new Error("No API key for openai/gpt-4o");
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");
    const beforeOffset = streams.getHeadOffset(sessionEventsStreamId(created.sessionId));

    await assert.rejects(
      registry.updateModel(
        created.sessionId,
        {
          model: "openai/gpt-4o",
        },
        auth,
        "conn-a",
      ),
      /No API key for openai\/gpt-4o/,
    );

    const replay = streams.read(sessionEventsStreamId(created.sessionId), beforeOffset);
    assert.ok(replay.events.every((event) => event.kind !== "command_accepted"));

    const snapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    assert.equal(snapshot.queue.nextSequence, 1);
  } finally {
    await registry.dispose();
  }
});

timedTest("invalid thinkingLevel is rejected before command acceptance", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");
    const beforeOffset = streams.getHeadOffset(sessionEventsStreamId(created.sessionId));

    await assert.rejects(
      registry.updateModel(
        created.sessionId,
        {
          model: "pi-remote-faux/pi-remote-faux-1",
          thinkingLevel: "ultra",
        },
        auth,
        "conn-a",
      ),
      /Invalid thinkingLevel/,
    );

    const replay = streams.read(sessionEventsStreamId(created.sessionId), beforeOffset);
    assert.ok(replay.events.every((event) => event.kind !== "command_accepted"));

    const snapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    assert.equal(snapshot.queue.nextSequence, 1);
    assert.equal(snapshot.thinkingLevel, "medium");
  } finally {
    await registry.dispose();
  }
});

timedTest("prompt preflight rejects missing auth before command acceptance", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  session.modelRegistry = {
    find: () => session.model,
    getAvailable: () => [session.model],
    getApiKeyAndHeaders: async () => ({
      ok: true as const,
      apiKey: undefined,
      headers: undefined,
    }),
    isUsingOAuth: () => false,
  };
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");
    const beforeOffset = streams.getHeadOffset(sessionEventsStreamId(created.sessionId));

    await assert.rejects(
      registry.prompt(
        created.sessionId,
        {
          text: "prompt",
        },
        auth,
        "conn-a",
      ),
      /No API key found for pi-remote-faux/,
    );

    const replay = streams.read(sessionEventsStreamId(created.sessionId), beforeOffset);
    assert.ok(replay.events.every((event) => event.kind !== "command_accepted"));
    assert.ok(replay.events.every((event) => event.kind !== "extension_error"));

    const snapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    assert.equal(snapshot.queue.nextSequence, 1);
    assert.equal(session.promptCalls.length, 0);
  } finally {
    await registry.dispose();
  }
});

timedTest("prompt skips preflight when already streaming and queues follow-up", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  session.isStreaming = true;
  session.modelRegistry = {
    find: () => session.model,
    getAvailable: () => [session.model],
    getApiKeyAndHeaders: async () => ({
      ok: false as const,
      error: "transient auth failure",
    }),
    isUsingOAuth: () => false,
  };
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");
    const accepted = await registry.prompt(
      created.sessionId,
      {
        text: "queued while streaming",
      },
      auth,
      "conn-a",
    );

    assert.equal(accepted.sequence, 1);

    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(session.promptCalls.length, 1);
    assert.equal(session.promptCalls[0]?.text, "queued while streaming");
    assert.equal(session.promptCalls[0]?.options?.streamingBehavior, "followUp");

    const events = streams.read(sessionEventsStreamId(created.sessionId), "-1").events;
    assert.ok(events.some((event) => event.kind === "command_accepted"));
    assert.ok(events.every((event) => event.kind !== "extension_error"));
  } finally {
    await registry.dispose();
  }
});

timedTest("registered slash commands bypass prompt preflight", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  session.modelRegistry = {
    find: () => session.model,
    getAvailable: () => [session.model],
    getApiKeyAndHeaders: async () => ({
      ok: true as const,
      apiKey: undefined,
      headers: undefined,
    }),
    isUsingOAuth: () => false,
  };
  session.extensionRunner = {
    getCommand: (name: string) => (name === "login" ? { name } : undefined),
  };

  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");
    const accepted = await registry.prompt(
      created.sessionId,
      {
        text: "/login openai",
      },
      auth,
      "conn-a",
    );

    assert.equal(accepted.sequence, 1);

    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(session.promptCalls.length, 1);
    assert.equal(session.promptCalls[0]?.text, "/login openai");

    const events = streams.read(sessionEventsStreamId(created.sessionId), "-1").events;
    assert.ok(events.some((event) => event.kind === "command_accepted"));
    assert.ok(events.every((event) => event.kind !== "extension_error"));
  } finally {
    await registry.dispose();
  }
});

timedTest("runtime dispatch serializes prompt start ordering", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RacyPromptSession(96);
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");

    const [first, second] = await Promise.all([
      registry.prompt(
        created.sessionId,
        {
          text: "first",
        },
        auth,
        "conn-a",
      ),
      registry.prompt(
        created.sessionId,
        {
          text: "second",
        },
        auth,
        "conn-a",
      ),
    ]);

    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    assert.equal(session.promptCalls.length, 2);
    assert.equal(session.promptCalls[0]?.text, "first");
    assert.equal(session.promptCalls[1]?.text, "second");
    assert.equal(session.promptCalls[1]?.options?.streamingBehavior, "followUp");

    const events = streams.read(sessionEventsStreamId(created.sessionId), "-1").events;
    assert.ok(events.filter((event) => event.kind === "command_accepted").length >= 2);
    assert.ok(events.every((event) => event.kind !== "extension_error"));
  } finally {
    await registry.dispose();
  }
});

timedTest("interrupt stays ordered behind queued commands during prompt startup", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new BlockingPromptSession();
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");

    const promptAccepted = await registry.prompt(
      created.sessionId,
      {
        text: "long startup",
      },
      auth,
      "conn-a",
    );
    assert.equal(promptAccepted.sequence, 1);

    const steerAccepted = await registry.steer(
      created.sessionId,
      {
        text: "queued steer",
      },
      auth,
      "conn-a",
    );
    assert.equal(steerAccepted.sequence, 2);

    const interruptAccepted = await registry.interrupt(created.sessionId, {}, auth, "conn-a");
    assert.equal(interruptAccepted.sequence, 3);

    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(session.steerCalls.length, 0);
    assert.equal(session.abortCalls, 0);

    session.releasePrompt();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    assert.equal(session.steerCalls.length, 1);
    assert.equal(session.abortCalls, 1);
    assert.deepEqual(session.dispatchOrder, ["prompt", "steer", "interrupt"]);
  } finally {
    session.releasePrompt();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await registry.dispose();
  }
});

timedTest("snapshot queue depth includes accepted-but-undispatched commands", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new BlockingPromptSession();
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");

    const promptAccepted = await registry.prompt(
      created.sessionId,
      {
        text: "long startup",
      },
      auth,
      "conn-a",
    );
    assert.equal(promptAccepted.sequence, 1);

    await new Promise<void>((resolve) => setImmediate(resolve));

    const steerAccepted = await registry.steer(
      created.sessionId,
      {
        text: "queued steer",
      },
      auth,
      "conn-a",
    );
    assert.equal(steerAccepted.sequence, 2);

    const snapshot = registry.getSessionSnapshot(created.sessionId, auth, "conn-a");
    const headOffset = streams.getHeadOffset(sessionEventsStreamId(created.sessionId));

    assert.equal(snapshot.lastSessionStreamOffset, headOffset);
    assert.ok(snapshot.queue.depth >= 1);
  } finally {
    session.releasePrompt();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await registry.dispose();
  }
});

timedTest("interrupt clears queued steering and follow-up before aborting", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  session.isStreaming = true;
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");

    const steerAccepted = await registry.steer(
      created.sessionId,
      {
        text: "queued steer",
      },
      auth,
      "conn-a",
    );
    assert.equal(steerAccepted.sequence, 1);

    const followUpAccepted = await registry.followUp(
      created.sessionId,
      {
        text: "queued follow-up",
      },
      auth,
      "conn-a",
    );
    assert.equal(followUpAccepted.sequence, 2);

    const interruptAccepted = await registry.interrupt(created.sessionId, {}, auth, "conn-a");
    assert.equal(interruptAccepted.sequence, 3);

    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(session.clearQueueCalls, 1);
    assert.deepEqual(session.queuedSteering, []);
    assert.deepEqual(session.queuedFollowUp, []);
  } finally {
    await registry.dispose();
  }
});

timedTest("prompt, steer, and follow-up forward attachments", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");
    const attachments = ["data:image/png;base64,AAAA", "BBBB"];

    const promptAccepted = await registry.prompt(
      created.sessionId,
      {
        text: "prompt",
        attachments,
      },
      auth,
      "conn-a",
    );
    assert.equal(promptAccepted.sequence, 1);

    const steerAccepted = await registry.steer(
      created.sessionId,
      {
        text: "steer",
        attachments,
      },
      auth,
      "conn-a",
    );
    assert.equal(steerAccepted.sequence, 2);

    const followUpAccepted = await registry.followUp(
      created.sessionId,
      {
        text: "follow-up",
        attachments,
      },
      auth,
      "conn-a",
    );
    assert.equal(followUpAccepted.sequence, 3);

    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(session.promptCalls.length, 1);
    assert.equal(session.steerCalls.length, 1);
    assert.equal(session.followUpCalls.length, 1);

    assert.deepEqual(session.promptCalls[0]?.options?.images, [
      {
        type: "image",
        mimeType: "image/png",
        data: "AAAA",
      },
      {
        type: "image",
        mimeType: "application/octet-stream",
        data: "BBBB",
      },
    ]);
    assert.deepEqual(session.steerCalls[0]?.images, [
      {
        type: "image",
        mimeType: "image/png",
        data: "AAAA",
      },
      {
        type: "image",
        mimeType: "application/octet-stream",
        data: "BBBB",
      },
    ]);
    assert.deepEqual(session.followUpCalls[0]?.images, [
      {
        type: "image",
        mimeType: "image/png",
        data: "AAAA",
      },
      {
        type: "image",
        mimeType: "application/octet-stream",
        data: "BBBB",
      },
    ]);
  } finally {
    await registry.dispose();
  }
});

timedTest("createSession disposes runtime when session initialization fails", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  session.bindExtensionsError = new Error("bind failed");
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    await assert.rejects(registry.createSession({}, auth, "conn-a"), /bind failed/);
    assert.equal(runtimeFactory.runtimeDisposeCalls, 1);

    const snapshot = registry.getAppSnapshot(auth);
    assert.equal(snapshot.sessionSummaries.length, 0);
  } finally {
    await registry.dispose();
  }
});

timedTest("lazy-loaded session disposes runtime when initialization fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-lazy-load-failure-"));
  const catalogDir = join(root, "catalog");
  const workspaceDir = join(root, "workspace");
  const sessionId = "lazy-load-bind-failure";
  const sessionPath = join(catalogDir, "session.jsonl");

  await mkdir(catalogDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    sessionPath,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd: workspaceDir,
    })}\n`,
  );

  const streams = new InMemoryDurableStreamStore();
  const session = new RecordingSession();
  session.bindExtensionsError = new Error("bind failed");
  session.sessionStats = {
    ...session.sessionStats,
    sessionId,
    sessionFile: sessionPath,
  };
  session.sessionManager = {
    getCwd: () => workspaceDir,
    getSessionId: () => sessionId,
    isPersisted: () => true,
    getSessionFile: () => sessionPath,
    getSessionDir: () => catalogDir,
  };

  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
    catalog: new SessionCatalog({ rootDir: catalogDir }),
  });
  const auth = testAuthSession();

  try {
    await assert.rejects(registry.loadSessionSnapshot(sessionId, auth, "conn-a"), /bind failed/);
    await assert.rejects(registry.loadSessionSnapshot(sessionId, auth, "conn-a"), /bind failed/);

    assert.equal(runtimeFactory.loadCalls, 2);
    assert.equal(runtimeFactory.runtimeDisposeCalls, 2);

    const summary = registry.getSessionSummary(sessionId);
    assert.equal(summary.lifecycle.loaded, false);
  } finally {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

timedTest("open stream responses omit Stream-Closed header", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

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
    assert.equal(createResponse.status, 201);

    const streamResponse = await remote.app.request("/v1/streams/app-events?offset=-1", {
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(streamResponse.status, 200);
    assert.equal(streamResponse.headers.get("Stream-Closed"), null);
  } finally {
    await remote.dispose();
  }
});

timedTest("milestone 2 command surface sequences commands and replays session events", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
  });

  try {
    const tokenA = await authenticate(remote.app, privateKeyPem);
    const tokenB = await authenticate(remote.app, privateKeyPem);

    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json",
        "x-pi-connection-id": "device-a",
      },
      body: JSON.stringify({ sessionName: "Milestone 2" }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    const initialSnapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${tokenA}`,
          "x-pi-connection-id": "device-a",
        },
      },
    );
    assert.equal(initialSnapshotResponse.status, 200);
    const initialSnapshot = (await initialSnapshotResponse.json()) as {
      model: string;
      thinkingLevel: string;
      lastSessionStreamOffset: string;
    };

    const [nameAResponse, nameBResponse] = await Promise.all([
      remote.app.request(`/v1/sessions/${created.sessionId}/session-name`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenA}`,
          "content-type": "application/json",
          "x-pi-connection-id": "device-a",
        },
        body: JSON.stringify({
          sessionName: "Milestone 2 A",
        }),
      }),
      remote.app.request(`/v1/sessions/${created.sessionId}/session-name`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenB}`,
          "content-type": "application/json",
          "x-pi-connection-id": "device-b",
        },
        body: JSON.stringify({
          sessionName: "Milestone 2 B",
        }),
      }),
    ]);

    assert.equal(nameAResponse.status, 202);
    assert.equal(nameBResponse.status, 202);
    const nameAcceptedA = (await nameAResponse.json()) as {
      sequence: number;
    };
    const nameAcceptedB = (await nameBResponse.json()) as {
      sequence: number;
    };
    const firstSequences = [nameAcceptedA.sequence, nameAcceptedB.sequence].toSorted(
      (a, b) => a - b,
    );
    assert.deepEqual(firstSequences, [1, 2]);

    const commandReplayResponse = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=${encodeURIComponent(initialSnapshot.lastSessionStreamOffset)}`,
      {
        headers: { authorization: `Bearer ${tokenA}` },
      },
    );
    assert.equal(commandReplayResponse.status, 200);
    const commandReplay = (await commandReplayResponse.json()) as {
      events: Array<{ kind: string; payload: any }>;
      nextOffset: string;
    };
    const sessionNamePatchEvents = commandReplay.events.filter(
      (event) =>
        event.kind === "session_state_patch" &&
        typeof event.payload?.patch?.sessionName === "string",
    );
    assert.equal(sessionNamePatchEvents.length, 2);
    const patchedNames = sessionNamePatchEvents
      .map((event) => event.payload?.patch?.sessionName as string)
      .toSorted((a, b) => a.localeCompare(b));
    assert.deepEqual(patchedNames, ["Milestone 2 A", "Milestone 2 B"]);
    const replayOffset = commandReplay.nextOffset;

    const nameResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/session-name`,
      tokenA,
      {
        sessionName: "Milestone 2 Renamed",
      },
    );
    assert.equal(nameResponse.status, 202);
    const nameAccepted = (await nameResponse.json()) as { sequence: number };
    assert.equal(nameAccepted.sequence, 3);

    const modelResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/model`,
      tokenA,
      {
        model: initialSnapshot.model,
        thinkingLevel: initialSnapshot.thinkingLevel,
      },
    );
    assert.equal(modelResponse.status, 202);
    const modelAccepted = (await modelResponse.json()) as { sequence: number };
    assert.equal(modelAccepted.sequence, 4);

    const promptResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/prompt`,
      tokenA,
      {
        text: "Say hello in one sentence.",
      },
    );
    assert.equal(promptResponse.status, 202);
    const promptAccepted = (await promptResponse.json()) as { sequence: number };
    assert.equal(promptAccepted.sequence, 5);

    const steerResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/steer`,
      tokenB,
      {
        text: "Keep it very short.",
      },
    );
    assert.equal(steerResponse.status, 202);
    const steerAccepted = (await steerResponse.json()) as { sequence: number };
    assert.equal(steerAccepted.sequence, 6);

    const followUpResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/follow-up`,
      tokenB,
      {
        text: "Then add one more short sentence.",
      },
    );
    assert.equal(followUpResponse.status, 202);
    const followUpAccepted = (await followUpResponse.json()) as { sequence: number };
    assert.equal(followUpAccepted.sequence, 7);

    const interruptResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/interrupt`,
      tokenA,
      {},
    );
    assert.equal(interruptResponse.status, 202);
    const interruptAccepted = (await interruptResponse.json()) as { sequence: number };
    assert.equal(interruptAccepted.sequence, 8);

    const waited = await waitForSessionEvent(
      remote.app,
      tokenA,
      created.sessionId,
      replayOffset,
      (event) =>
        event.kind === "agent_session_event" &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        (event.payload as { type?: string }).type === "agent_end",
    );
    assert.equal(waited.event.kind, "agent_session_event");
    assert.equal((waited.event.payload as { type: string }).type, "agent_end");

    const resumedResponse = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=${encodeURIComponent(replayOffset)}`,
      {
        headers: { authorization: `Bearer ${tokenA}` },
      },
    );
    assert.equal(resumedResponse.status, 200);
    const resumed = (await resumedResponse.json()) as {
      events: Array<{ kind: string; payload: any }>;
      nextOffset: string;
    };
    assert.ok(resumed.events.some((event) => event.kind === "command_accepted"));
    assert.ok(resumed.events.some((event) => event.kind === "agent_session_event"));
    assert.ok(!resumed.events.some((event) => event.kind === "extension_error"));

    const postPromptSnapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: { authorization: `Bearer ${tokenA}` },
      },
    );
    assert.equal(postPromptSnapshotResponse.status, 200);
    const postPromptSnapshot = (await postPromptSnapshotResponse.json()) as {
      transcript: Array<{ role?: string }>;
    };
    assert.ok(postPromptSnapshot.transcript.some((message) => message.role === "assistant"));

    const secondDeviceSnapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${tokenB}`,
          "x-pi-connection-id": "device-b",
        },
      },
    );
    assert.equal(secondDeviceSnapshotResponse.status, 200);
    const secondDeviceSnapshot = (await secondDeviceSnapshotResponse.json()) as {
      sessionName: string;
      presence: Array<{ connectionId: string }>;
      transcript: Array<{ role?: string }>;
    };
    assert.equal(secondDeviceSnapshot.sessionName, "Milestone 2 Renamed");
    assert.ok(secondDeviceSnapshot.transcript.some((message) => message.role === "assistant"));
    assert.ok(
      secondDeviceSnapshot.presence.some((presence) => presence.connectionId === "device-a"),
    );
    assert.ok(
      secondDeviceSnapshot.presence.some((presence) => presence.connectionId === "device-b"),
    );

    const secondDeviceResume = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=${encodeURIComponent(resumed.nextOffset)}`,
      {
        headers: { authorization: `Bearer ${tokenB}` },
      },
    );
    assert.equal(secondDeviceResume.status, 200);
    const secondDeviceResumeBody = (await secondDeviceResume.json()) as {
      events: unknown[];
    };
    assert.deepEqual(secondDeviceResumeBody.events, []);
  } finally {
    await remote.dispose();
  }
});

timedTest("default runtime factory hosts an in-memory Pi runtime", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
  });

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

    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };
    assert.ok(created.sessionId);
  } finally {
    await remote.dispose();
  }
});

timedTest("remote theme parser matches bundled theme examples", async () => {
  const bundledThemePaths = [
    join(process.cwd(), "src", "resources", "themes", "catppuccin-latte.json"),
    join(process.cwd(), "src", "resources", "themes", "catppuccin-mocha.json"),
  ];

  for (const themePath of bundledThemePaths) {
    const content = await readFile(themePath, "utf8");
    const remoteTheme = createRemoteThemeFromContent({
      sourcePath: themePath,
      content,
    });
    const upstreamTheme = loadThemeFromPath(themePath);

    assert.equal(remoteTheme.name, upstreamTheme.name);
    assert.equal(remoteTheme.sourcePath, themePath);
    assert.equal(remoteTheme.getColorMode(), upstreamTheme.getColorMode());
    assert.equal(remoteTheme.getFgAnsi("accent"), upstreamTheme.getFgAnsi("accent"));
    assert.equal(remoteTheme.getFgAnsi("text"), upstreamTheme.getFgAnsi("text"));
    assert.equal(remoteTheme.getFgAnsi("mdCode"), upstreamTheme.getFgAnsi("mdCode"));
    assert.equal(remoteTheme.getFgAnsi("thinkingHigh"), upstreamTheme.getFgAnsi("thinkingHigh"));
    assert.equal(remoteTheme.getBgAnsi("selectedBg"), upstreamTheme.getBgAnsi("selectedBg"));
    assert.equal(remoteTheme.getBgAnsi("toolSuccessBg"), upstreamTheme.getBgAnsi("toolSuccessBg"));
  }
});

timedTest(
  "remote reload refreshes server resources and replays client extension lifecycle",
  async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    const session = new RecordingSession();
    session.enableVersionedResources();
    const events: string[] = [];
    const eventRecorderExtension: ExtensionFactory = (pi) => {
      pi.on("session_start", (event) => {
        events.push(`start:${event.reason}`);
      });
      pi.on("session_shutdown", () => {
        events.push("shutdown");
      });
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
      assert.equal(createResponse.status, 201);
      const created = (await createResponse.json()) as { sessionId: string };

      runtime = await createRemoteRuntime(remote.app, {
        privateKeyPem,
        sessionId: created.sessionId,
        clientExtensionFactories: [eventRecorderExtension],
      });

      await runtime.session.bindExtensions({});

      const initialExtensions = runtime.services.resourceLoader.getExtensions().extensions;
      const initialSkills = runtime.services.resourceLoader.getSkills().skills;
      const initialPrompts = runtime.services.resourceLoader.getPrompts().prompts;
      const initialThemes = runtime.services.resourceLoader.getThemes().themes;

      assert.equal(session.reloadCalls, 0);
      assert.equal(initialExtensions[0]?.path, "extension-v1");
      assert.equal(initialSkills[0]?.name, "skill-v1");
      assert.equal(initialPrompts[0]?.name, "prompt-v1");
      assert.equal(initialThemes[0]?.name, "dark");
      assert.equal(initialSkills.length, 1);
      assert.equal(initialPrompts.length, 1);
      assert.equal(initialThemes.length, 1);
      assert.deepEqual(events, ["start:startup"]);

      await runtime.session.reload();

      const reloadedExtensions = runtime.services.resourceLoader.getExtensions().extensions;
      const reloadedSkills = runtime.services.resourceLoader.getSkills().skills;
      const reloadedPrompts = runtime.services.resourceLoader.getPrompts().prompts;
      const reloadedThemes = runtime.services.resourceLoader.getThemes().themes;

      assert.equal(session.reloadCalls, 1);
      assert.equal(reloadedExtensions[0]?.path, "extension-v2");
      assert.equal(reloadedSkills[0]?.name, "skill-v2");
      assert.equal(reloadedPrompts[0]?.name, "prompt-v2");
      assert.equal(reloadedThemes[0]?.name, "light");
      assert.equal(reloadedSkills.length, 1);
      assert.equal(reloadedPrompts.length, 1);
      assert.equal(reloadedThemes.length, 1);
      assert.deepEqual(events, ["start:startup", "shutdown", "start:reload"]);
    } finally {
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

timedTest(
  "remote runtime session exposes server prompt templates before and after reload",
  async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    const session = new RecordingSession();
    session.enableVersionedResources();

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
      assert.equal(createResponse.status, 201);
      const created = (await createResponse.json()) as { sessionId: string };

      runtime = await createRemoteRuntime(remote.app, {
        privateKeyPem,
        sessionId: created.sessionId,
      });

      assert.equal(runtime.session.promptTemplates.length, 1);
      assert.equal(runtime.session.promptTemplates[0]?.name, "prompt-v1");

      await runtime.session.reload();

      assert.equal(runtime.session.promptTemplates.length, 1);
      assert.equal(runtime.session.promptTemplates[0]?.name, "prompt-v2");
    } finally {
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

timedTest("reload rejects while queued commands are still pending", async () => {
  const streams = new InMemoryDurableStreamStore();
  const session = new BlockingPromptSession();
  const runtimeFactory = new RecordingRuntimeFactory(session);
  const registry = new SessionRegistry({
    streams,
    runtimeFactory,
  });
  const auth = testAuthSession();

  try {
    const created = await registry.createSession({}, auth, "conn-a");

    const promptAccepted = await registry.prompt(
      created.sessionId,
      {
        text: "long startup",
      },
      auth,
      "conn-a",
    );
    assert.equal(promptAccepted.sequence, 1);

    await new Promise<void>((resolve) => setImmediate(resolve));

    const steerAccepted = await registry.steer(
      created.sessionId,
      {
        text: "queued steer",
      },
      auth,
      "conn-a",
    );
    assert.equal(steerAccepted.sequence, 2);

    await assert.rejects(
      registry.reload(created.sessionId, auth, "conn-a"),
      /Wait for queued commands to finish before reloading\./,
    );

    assert.equal(session.reloadCalls, 0);
  } finally {
    session.releasePrompt();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await registry.dispose();
  }
});

timedTest("in-memory runtime factory preserves explicit null fauxApiKey", async () => {
  const defaultFactory = InMemoryPiRuntimeFactory();
  const defaultRuntime = await defaultFactory.create();
  const defaultKey = await defaultRuntime.services.authStorage.getApiKey("pi-remote-faux");

  assert.equal(defaultKey, "pi-remote-faux-local-key");

  await defaultRuntime.dispose();
  await defaultFactory.dispose();

  const nullFactory = InMemoryPiRuntimeFactory({
    fauxApiKey: null,
  });
  const nullRuntime = await nullFactory.create();
  const nullKey = await nullRuntime.services.authStorage.getApiKey("pi-remote-faux");

  assert.equal(nullKey, undefined);

  await nullRuntime.dispose();
  await nullFactory.dispose();
});

timedTest("in-memory runtime load preserves source session directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-load-session-dir-"));
  const workspaceDir = join(root, "workspace");
  const agentDir = join(root, "agent");
  const defaultSessionDir = join(root, "default-sessions");
  const sourceSessionDir = join(root, "source-sessions");

  await mkdir(workspaceDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const sourceManager = SessionManager.create(workspaceDir, sourceSessionDir);
  const sourceSessionPath = sourceManager.getSessionFile();
  assert.ok(sourceSessionPath);

  const runtimeFactory = InMemoryPiRuntimeFactory({
    cwd: workspaceDir,
    agentDir,
    sessionDir: defaultSessionDir,
    persistSessions: true,
  });
  const runtime = await runtimeFactory.load?.({
    sessionId: sourceManager.getSessionId(),
    sessionPath: sourceSessionPath,
    cwd: workspaceDir,
  });

  assert.ok(runtime);

  try {
    assert.equal(runtime.session.sessionManager.getSessionDir(), sourceSessionDir);

    const next = await runtime.newSession();
    assert.equal(next.cancelled, false);
    assert.equal(runtime.session.sessionManager.getSessionDir(), sourceSessionDir);
    assert.equal(dirname(runtime.session.sessionManager.getSessionFile() ?? ""), sourceSessionDir);
  } finally {
    await runtime.dispose();
    await runtimeFactory.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

timedTest("milestone 3 remote runtime adapter replays snapshot and streams events", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: InMemoryPiRuntimeFactory(),
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
      body: JSON.stringify({ sessionName: "milestone3" }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    const beforePromptSnapshot = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    assert.equal(beforePromptSnapshot.status, 200);
    const snapshot = (await beforePromptSnapshot.json()) as { lastSessionStreamOffset: string };

    const promptResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/prompt`,
      token,
      {
        text: "hello from milestone 3",
      },
    );
    assert.equal(promptResponse.status, 202);

    await waitForSessionEvent(
      remote.app,
      token,
      created.sessionId,
      snapshot.lastSessionStreamOffset,
      (event) =>
        event.kind === "agent_session_event" &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        (event.payload as { type?: string }).type === "agent_end",
    );

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    assert.ok(
      runtime.session.messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as { role?: string }).role === "assistant",
      ),
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error("Timed out waiting for remote adapter agent_end"));
      }, 5_000);

      const unsubscribe = runtime!.session.subscribe((event) => {
        if (event.type !== "agent_end") {
          return;
        }
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      });

      void runtime!.session.prompt("second prompt through adapter");
    });
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3 adapter routes extension ui requests through ui-response", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const session = new UiRequestPromptSession();
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
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    let inputCalls = 0;
    await runtime.session.bindExtensions({
      uiContext: {
        input: async () => {
          inputCalls += 1;
          return "client-answer";
        },
      } as any,
    } as any);

    await runtime.session.prompt("prompt requiring ui response");

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (session.uiAnswers.length > 0) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(inputCalls, 1);
    assert.equal(session.uiAnswers.length, 1);
    assert.equal(session.uiAnswers[0], "client-answer");
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3 adapter forwards turn_end to client extensions", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new InMemoryPiRuntimeFactory(),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
  let turnEndCount = 0;
  const turnEndExtension: ExtensionFactory = (pi) => {
    pi.on("turn_end", () => {
      turnEndCount += 1;
    });
  };

  try {
    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      cwd: "/srv/turn-end-workspace",
      clientExtensionMetadata: [
        {
          id: "test-turn-end",
          runtime: "client",
          path: "client:test-turn-end",
        },
      ],
      clientExtensionFactories: [turnEndExtension],
    });

    await runtime.session.bindExtensions({});

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error("Timed out waiting for agent_end while forwarding turn_end"));
      }, 5_000);

      const unsubscribe = runtime!.session.subscribe((event) => {
        if (event.type !== "agent_end") {
          return;
        }
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      });

      void runtime!.session.prompt("forward turn end");
    });

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (turnEndCount > 0) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(turnEndCount, 1);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest(
  "milestone 3 adapter passes message_end object by reference to client extensions",
  async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    const remote = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: InMemoryPiRuntimeFactory(),
    });

    let runtime: RemoteAgentSessionRuntime | undefined;
    const mutatingExtension: ExtensionFactory = (pi) => {
      pi.on("message_end", (event) => {
        const message = event.message as { role?: string; content?: unknown };
        if (message.role !== "assistant" || !Array.isArray(message.content)) {
          return;
        }
        message.content.length = 0;
      });
    };

    try {
      runtime = await createRemoteRuntime(remote.app, {
        privateKeyPem,
        cwd: "/srv/message-end-workspace",
        clientExtensionMetadata: [
          {
            id: "test-mutating-message-end",
            runtime: "client",
            path: "client:test-mutating-message-end",
          },
        ],
        clientExtensionFactories: [mutatingExtension],
      });

      await runtime.session.bindExtensions({});

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          unsubscribe();
          reject(new Error("Timed out waiting for agent_end in mutation pass-through test"));
        }, 5_000);

        const unsubscribe = runtime!.session.subscribe((event) => {
          if (event.type !== "agent_end") {
            return;
          }
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        });

        void runtime!.session.prompt("verify message mutation pass-through");
      });

      const assistant = [...runtime.session.messages]
        .toReversed()
        .find(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            (message as { role?: string }).role === "assistant",
        ) as
        | {
            role?: string;
            content?: Array<{ type?: string; text?: string }>;
          }
        | undefined;

      assert.ok(assistant);
      assert.ok(Array.isArray(assistant.content));
      assert.equal((assistant.content ?? []).length, 0);
    } finally {
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

timedTest("milestone 3 adapter forwards queue, compaction, and retry events", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const session = new RuntimeExtensionEventsPromptSession();
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
  let queueUpdateCount = 0;
  let compactionStartCount = 0;
  let compactionEndCount = 0;
  let autoRetryStartCount = 0;
  let autoRetryEndCount = 0;

  const extension: ExtensionFactory = (pi) => {
    pi.on("queue_update", () => {
      queueUpdateCount += 1;
    });
    pi.on("compaction_start", () => {
      compactionStartCount += 1;
    });
    pi.on("compaction_end", () => {
      compactionEndCount += 1;
    });
    pi.on("auto_retry_start", () => {
      autoRetryStartCount += 1;
    });
    pi.on("auto_retry_end", () => {
      autoRetryEndCount += 1;
    });
  };

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
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
      clientExtensionMetadata: [
        {
          id: "test-runtime-events",
          runtime: "client",
          path: "client:test-runtime-events",
        },
      ],
      clientExtensionFactories: [extension],
    });

    await runtime.session.bindExtensions({});
    await runtime.session.prompt("trigger runtime extension events");

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (
        queueUpdateCount > 0 &&
        compactionStartCount > 0 &&
        compactionEndCount > 0 &&
        autoRetryStartCount > 0 &&
        autoRetryEndCount > 0
      ) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(queueUpdateCount, 1);
    assert.equal(compactionStartCount, 1);
    assert.equal(compactionEndCount, 1);
    assert.equal(autoRetryStartCount, 1);
    assert.equal(autoRetryEndCount, 1);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3 adapter forwards passive extension events", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const session = new PassiveExtensionEventsPromptSession();
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
  let modelSelectCount = 0;
  let sessionCompactCount = 0;
  let sessionTreeCount = 0;
  let modelSeenByExtension: string | undefined;

  const extension: ExtensionFactory = (pi) => {
    pi.on("model_select", (_event, ctx) => {
      modelSelectCount += 1;
      modelSeenByExtension = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    });
    pi.on("session_compact", () => {
      sessionCompactCount += 1;
    });
    pi.on("session_tree", () => {
      sessionTreeCount += 1;
    });
  };

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
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
      clientExtensionMetadata: [
        {
          id: "test-passive-events",
          runtime: "client",
          path: "client:test-passive-events",
        },
      ],
      clientExtensionFactories: [extension],
    });

    await runtime.session.bindExtensions({});
    await runtime.session.setModel({
      ...session.model,
      provider: "test-provider",
      id: "updated-model",
      name: "test-provider/updated-model",
    });
    await runtime.session.prompt("trigger passive extension events");

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (modelSelectCount > 0 && sessionCompactCount > 0 && sessionTreeCount > 0) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(modelSelectCount, 1);
    assert.equal(modelSeenByExtension, "test-provider/updated-model");
    assert.equal(sessionCompactCount, 1);
    assert.equal(sessionTreeCount, 1);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest(
  "milestone 3 adapter rolls back optimistic thinkingLevel on rejected update",
  async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

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
      assert.equal(createResponse.status, 201);
      const created = (await createResponse.json()) as { sessionId: string };

      const inProcessFetch = createInProcessFetch(remote.app);
      runtime = await RemoteAgentSessionRuntime.create({
        origin: "http://localhost:3000",
        auth: {
          keyId: "dev",
          privateKey: privateKeyPem,
        },
        sessionId: created.sessionId,
        fetchImpl: async (input, init) => {
          const url = typeof input === "string" ? input : input.url;
          if (url.includes("/model") && init?.method === "POST") {
            return new Response(JSON.stringify({ message: "simulated transport failure" }), {
              status: 500,
              headers: {
                "content-type": "application/json",
              },
            });
          }
          return inProcessFetch(input, init);
        },
      });

      runtime.session.setThinkingLevel("high");

      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (runtime.session.state.errorMessage) {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }

      assert.equal(runtime.session.thinkingLevel, "medium");
      assert.match(runtime.session.state.errorMessage ?? "", /Failed to update thinking level/);
    } finally {
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

timedTest("milestone 3 adapter surfaces extension_error stream events", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const session = new RecordingSession();
  session.promptError = new Error("simulated runtime prompt failure");

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
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    await runtime.session.prompt("trigger runtime failure");

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (runtime.session.state.errorMessage) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    assert.match(runtime.session.state.errorMessage ?? "", /simulated runtime prompt failure/);
    assert.ok(
      runtime.session.messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as { customType?: string }).customType === "remote_error",
      ),
    );
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3 adapter clearQueue clears authoritative remote queue", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

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
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    await postSessionCommand(remote.app, `/v1/sessions/${created.sessionId}/steer`, token, {
      text: "queued steer",
    });
    await postSessionCommand(remote.app, `/v1/sessions/${created.sessionId}/follow-up`, token, {
      text: "queued follow-up",
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (session.queuedSteering.length > 0 && session.queuedFollowUp.length > 0) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(session.queuedSteering.length, 1);
    assert.equal(session.queuedFollowUp.length, 1);

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    runtime.session.clearQueue();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (session.clearQueueCalls > 0) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(session.clearQueueCalls, 1);
    assert.deepEqual(session.queuedSteering, []);
    assert.deepEqual(session.queuedFollowUp, []);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3 adapter does not double-append user/custom messages", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
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
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    const sessionAny = runtime.session as any;
    const baseline = runtime.session.messages.length;
    const userMessage = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    };
    sessionAny.applyAgentSessionEvent({ type: "message_start", message: userMessage });
    sessionAny.applyAgentSessionEvent({ type: "message_end", message: userMessage });

    const customMessage = {
      role: "custom",
      customType: "remote_error",
      content: "err",
      display: true,
      timestamp: Date.now(),
    };
    sessionAny.applyAgentSessionEvent({ type: "message_start", message: customMessage });
    sessionAny.applyAgentSessionEvent({ type: "message_end", message: customMessage });

    assert.equal(runtime.session.messages.length, baseline + 2);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3 adapter sendCustomMessage appends custom messages", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
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
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    const baseline = runtime.session.messages.length;
    await runtime.session.sendCustomMessage({
      customType: "pi-mermaid",
      content: "graph TD;A-->B",
      display: true,
    });

    assert.equal(runtime.session.messages.length, baseline + 1);
    const appended = runtime.session.messages.at(-1);
    assert.equal(appended?.role, "custom");
    if (appended?.role === "custom") {
      assert.equal(appended.customType, "pi-mermaid");
    }
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3.1 snapshot includes model catalog and remote model settings", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const session = new RecordingSession();
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
  });

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
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    const snapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    assert.equal(snapshotResponse.status, 200);
    const snapshot = (await snapshotResponse.json()) as {
      model: string;
      availableModels: Array<{ provider: string; id: string }>;
      modelSettings: {
        defaultProvider: string | null;
        defaultModel: string | null;
        defaultThinkingLevel: string | null;
        enabledModels: string[] | null;
      };
    };

    assert.ok(snapshot.availableModels.length > 0);
    assert.ok(
      snapshot.availableModels.some(
        (model) => model.provider === "pi-remote-faux" && model.id === "pi-remote-faux-1",
      ),
    );
    assert.equal(snapshot.modelSettings.defaultProvider, null);
    assert.equal(snapshot.modelSettings.defaultModel, null);
    assert.equal(snapshot.modelSettings.defaultThinkingLevel, null);
    assert.equal(snapshot.modelSettings.enabledModels, null);

    const updateResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/model`,
      token,
      {
        model: snapshot.model,
        thinkingLevel: "high",
      },
    );
    assert.equal(updateResponse.status, 202);

    const updatedSnapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    assert.equal(updatedSnapshotResponse.status, 200);
    const updatedSnapshot = (await updatedSnapshotResponse.json()) as {
      model: string;
      modelSettings: {
        defaultProvider: string | null;
        defaultModel: string | null;
        defaultThinkingLevel: string | null;
      };
    };

    assert.equal(updatedSnapshot.modelSettings.defaultProvider, "pi-remote-faux");
    assert.equal(updatedSnapshot.modelSettings.defaultModel, "pi-remote-faux-1");
    assert.equal(updatedSnapshot.modelSettings.defaultThinkingLevel, "high");
  } finally {
    await remote.dispose();
  }
});

timedTest("milestone 3.1 adapter hydrates catalog and syncs remote model settings", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const session = new RecordingSession();
  session.model = {
    ...session.model,
    reasoning: false,
    contextWindow: 4_096,
    maxTokens: 1_024,
  };
  session.defaultProvider = "pi-remote-faux";
  session.defaultModel = "pi-remote-faux-1";
  session.defaultThinkingLevel = "off";
  session.enabledModels = ["pi-remote-faux/*"];

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
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    const availableModels = runtime.session.modelRegistry.getAvailable();
    assert.equal(availableModels.length, 1);
    assert.equal(availableModels[0]?.provider, "pi-remote-faux");
    assert.equal(availableModels[0]?.id, "pi-remote-faux-1");
    assert.equal(runtime.session.model?.reasoning, false);
    assert.equal(runtime.session.state.model?.provider, "pi-remote-faux");
    assert.equal(runtime.session.state.model?.id, "pi-remote-faux-1");
    assert.equal(runtime.session.state.thinkingLevel, runtime.session.thinkingLevel);
    assert.deepEqual(runtime.session.getAvailableThinkingLevels(), ["off"]);
    assert.equal(runtime.session.supportsThinking(), false);
    assert.equal(runtime.session.settingsManager.getDefaultProvider(), "pi-remote-faux");
    assert.equal(runtime.session.settingsManager.getDefaultModel(), "pi-remote-faux-1");
    assert.equal(runtime.session.settingsManager.getDefaultThinkingLevel(), "off");
    assert.deepEqual(runtime.session.settingsManager.getEnabledModels(), ["pi-remote-faux/*"]);

    const updateResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/model`,
      token,
      {
        model: "pi-remote-faux/pi-remote-faux-1",
        thinkingLevel: "high",
      },
    );
    assert.equal(updateResponse.status, 202);

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (runtime.session.settingsManager.getDefaultThinkingLevel() === "high") {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(runtime.session.settingsManager.getDefaultThinkingLevel(), "high");
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote settings manager changes sync across sessions", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const sharedSettingsStore = {
    global: {} as Record<string, unknown>,
    project: {} as Record<string, unknown>,
  };
  const sessionA = new RecordingSession();
  const sessionB = new RecordingSession();
  sessionA.settingsStore = sharedSettingsStore;
  sessionB.settingsStore = sharedSettingsStore;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new SequencedRecordingRuntimeFactory([sessionA, sessionB]),
  });

  let runtimeA: RemoteAgentSessionRuntime | undefined;
  let runtimeB: RemoteAgentSessionRuntime | undefined;
  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const createResponseA = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const createResponseB = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    assert.equal(createResponseA.status, 201);
    assert.equal(createResponseB.status, 201);

    const createdA = (await createResponseA.json()) as { sessionId: string };
    const createdB = (await createResponseB.json()) as { sessionId: string };

    runtimeA = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: createdA.sessionId,
    });
    runtimeB = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: createdB.sessionId,
    });

    const beforeSnapshotResponse = await remote.app.request(
      `/v1/sessions/${createdB.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    assert.equal(beforeSnapshotResponse.status, 200);
    const beforeSnapshot = (await beforeSnapshotResponse.json()) as {
      lastSessionStreamOffset: string;
    };

    runtimeA.session.settingsManager.setTheme("light");

    const sessionBPatch = await waitForSessionEvent(
      remote.app,
      token,
      createdB.sessionId,
      beforeSnapshot.lastSessionStreamOffset,
      (event) =>
        event.kind === "session_state_patch" && event.payload.patch?.settings?.theme === "light",
    );
    assert.equal(sessionBPatch.event.kind, "session_state_patch");
    assert.equal(sessionBPatch.event.payload.patch.settings?.theme, "light");

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (runtimeB.session.settingsManager.getTheme() === "light") {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(runtimeA.session.settingsManager.getTheme(), "light");
    assert.equal(runtimeB.session.settingsManager.getTheme(), "light");

    const snapshotResponse = await remote.app.request(
      `/v1/sessions/${createdB.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    assert.equal(snapshotResponse.status, 200);
    const snapshot = (await snapshotResponse.json()) as {
      settings?: {
        theme?: string;
      };
    };
    assert.equal(snapshot.settings?.theme, "light");
  } finally {
    await runtimeA?.dispose();
    await runtimeB?.dispose();
    await remote.dispose();
  }
});

timedTest("remote settings mutations do not rebuild resource snapshots", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const sharedSettingsStore = {
    global: {} as Record<string, unknown>,
    project: {} as Record<string, unknown>,
  };
  const sessionA = new RecordingSession();
  const sessionB = new RecordingSession();
  sessionA.settingsStore = sharedSettingsStore;
  sessionB.settingsStore = sharedSettingsStore;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new SequencedRecordingRuntimeFactory([sessionA, sessionB]),
  });

  let runtimeA: RemoteAgentSessionRuntime | undefined;
  let runtimeB: RemoteAgentSessionRuntime | undefined;
  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const createResponseA = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const createResponseB = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    assert.equal(createResponseA.status, 201);
    assert.equal(createResponseB.status, 201);

    const createdA = (await createResponseA.json()) as { sessionId: string };
    const createdB = (await createResponseB.json()) as { sessionId: string };

    runtimeA = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: createdA.sessionId,
    });
    runtimeB = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: createdB.sessionId,
    });

    const snapshotResponse = await remote.app.request(
      `/v1/sessions/${createdB.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    assert.equal(snapshotResponse.status, 200);
    const snapshot = (await snapshotResponse.json()) as {
      lastSessionStreamOffset: string;
    };

    const resourceReadsBeforeA = sessionA.snapshotExpensiveResourceReadCounts();
    const resourceReadsBeforeB = sessionB.snapshotExpensiveResourceReadCounts();

    runtimeA.session.settingsManager.setTheme("light");

    const sessionBPatch = await waitForSessionEvent(
      remote.app,
      token,
      createdB.sessionId,
      snapshot.lastSessionStreamOffset,
      (event) =>
        event.kind === "session_state_patch" && event.payload.patch?.settings?.theme === "light",
    );
    assert.equal(sessionBPatch.event.kind, "session_state_patch");

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (runtimeB.session.settingsManager.getTheme() === "light") {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(runtimeB.session.settingsManager.getTheme(), "light");
    assert.deepEqual(sessionA.snapshotExpensiveResourceReadCounts(), resourceReadsBeforeA);
    assert.deepEqual(sessionB.snapshotExpensiveResourceReadCounts(), resourceReadsBeforeB);
  } finally {
    await runtimeA?.dispose();
    await runtimeB?.dispose();
    await remote.dispose();
  }
});

timedTest("remote behavior settings sync across sessions", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const sharedSettingsStore = {
    global: {} as Record<string, unknown>,
    project: {} as Record<string, unknown>,
  };
  const sessionA = new RecordingSession();
  const sessionB = new RecordingSession();
  sessionA.settingsStore = sharedSettingsStore;
  sessionB.settingsStore = sharedSettingsStore;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new SequencedRecordingRuntimeFactory([sessionA, sessionB]),
  });

  let runtimeA: RemoteAgentSessionRuntime | undefined;
  let runtimeB: RemoteAgentSessionRuntime | undefined;
  try {
    const token = await authenticate(remote.app, privateKeyPem);
    const createResponseA = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const createResponseB = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    assert.equal(createResponseA.status, 201);
    assert.equal(createResponseB.status, 201);

    const createdA = (await createResponseA.json()) as { sessionId: string };
    const createdB = (await createResponseB.json()) as { sessionId: string };

    runtimeA = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: createdA.sessionId,
    });
    runtimeB = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: createdB.sessionId,
    });

    const beforeSnapshotResponse = await remote.app.request(
      `/v1/sessions/${createdB.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    assert.equal(beforeSnapshotResponse.status, 200);
    const beforeSnapshot = (await beforeSnapshotResponse.json()) as {
      lastSessionStreamOffset: string;
    };

    runtimeA.session.setSteeringMode("one-at-a-time");
    runtimeA.session.setAutoCompactionEnabled(true);

    const sessionBPatch = await waitForSessionEvent(
      remote.app,
      token,
      createdB.sessionId,
      beforeSnapshot.lastSessionStreamOffset,
      (event) =>
        event.kind === "session_state_patch" &&
        event.payload.patch?.steeringMode === "one-at-a-time" &&
        event.payload.patch?.autoCompactionEnabled === true,
    );
    assert.equal(sessionBPatch.event.kind, "session_state_patch");
    assert.equal(sessionBPatch.event.payload.patch.steeringMode, "one-at-a-time");
    assert.equal(sessionBPatch.event.payload.patch.autoCompactionEnabled, true);

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (
        runtimeB.session.steeringMode === "one-at-a-time" &&
        runtimeB.session.autoCompactionEnabled === true
      ) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(runtimeA.session.steeringMode, "one-at-a-time");
    assert.equal(runtimeB.session.steeringMode, "one-at-a-time");
    assert.equal(runtimeA.session.autoCompactionEnabled, true);
    assert.equal(runtimeB.session.autoCompactionEnabled, true);
  } finally {
    await runtimeA?.dispose();
    await runtimeB?.dispose();
    await remote.dispose();
  }
});

timedTest(
  "remote settings mutations rollback optimistic local state on server failure",
  async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    const session = new RecordingSession();
    const remote = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: new RecordingRuntimeFactory(session),
    });

    let runtime: RemoteAgentSessionRuntime | undefined;
    try {
      runtime = await createRemoteRuntime(remote.app, {
        privateKeyPem,
        cwd: "/srv/settings-rollback-workspace",
      });
      const initialTheme = runtime.session.settingsManager.getTheme();

      const originalSetTheme = session.settingsManager.setTheme;
      session.settingsManager.setTheme = () => {
        throw new Error("theme write denied");
      };

      runtime.session.settingsManager.setTheme("light");

      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (runtime.session.settingsManager.getTheme() === undefined) {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }

      assert.equal(runtime.session.settingsManager.getTheme(), initialTheme);
      assert.match(runtime.session.state.errorMessage ?? "", /theme write denied/);

      session.settingsManager.setTheme = originalSetTheme;
    } finally {
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

timedTest("milestone 3.2 snapshot and adapter use authoritative server cwd", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const session = new RecordingSession();
  session.cwd = "/srv/authoritative-workspace";
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
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    if (!created || typeof created !== "object" || !("sessionId" in created)) {
      throw new Error("Missing sessionId in createSession response");
    }

    const snapshotResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/snapshot`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    if (!snapshot || typeof snapshot !== "object" || !("cwd" in snapshot)) {
      throw new Error("Missing cwd in session snapshot");
    }
    assert.equal(snapshot.cwd, "/srv/authoritative-workspace");

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
      cwd: "/tmp/client-local-cwd",
    });

    assert.equal(runtime.session.sessionManager.getCwd(), "/srv/authoritative-workspace");
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3.2 adapter handles extended remote ui bridge primitives", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const session = new UiPrimitivesPromptSession();
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
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    if (!created || typeof created !== "object" || !("sessionId" in created)) {
      throw new Error("Missing sessionId in createSession response");
    }

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    let workingMessage: string | undefined;
    let workingIndicator:
      | {
          frames?: string[];
          intervalMs?: number;
        }
      | undefined;
    let hiddenThinkingLabel: string | undefined;
    let toolsExpanded = true;

    const uiContext = {
      setWorkingMessage: (message?: string) => {
        workingMessage = message;
      },
      setWorkingIndicator: (options?: { frames?: string[]; intervalMs?: number }) => {
        workingIndicator = options;
      },
      setHiddenThinkingLabel: (label?: string) => {
        hiddenThinkingLabel = label;
      },
      setToolsExpanded: (expanded: boolean) => {
        toolsExpanded = expanded;
      },
      setHeader: () => {},
      setFooter: () => {},
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setTitle: () => {},
      setEditorText: () => {},
      select: async () => {},
      confirm: async () => false,
      input: async () => {},
      editor: async () => {},
      onTerminalInput: () => () => {},
      custom: async () => {},
      pasteToEditor: () => {},
      getEditorText: () => "",
      setEditorComponent: () => {},
      theme: {
        fg: (...parts: unknown[]) => String(parts.at(-1) ?? ""),
      },
      getAllThemes: () => [],
      getTheme: () => {},
      setTheme: () => ({ success: false }),
      getToolsExpanded: () => true,
    };

    Reflect.set(runtime.session, "uiContext", uiContext);
    await runtime.session.prompt("trigger ui primitives");

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (workingMessage && hiddenThinkingLabel) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(workingMessage, "remote-working");
    assert.deepEqual(workingIndicator, { frames: ["remote-indicator"], intervalMs: 321 });
    assert.equal(hiddenThinkingLabel, "remote-hidden-thinking");
    assert.equal(toolsExpanded, false);
    assert.match(session.headerError ?? "", /setHeader\(factory\) is not supported/);
    assert.match(session.footerError ?? "", /setFooter\(factory\) is not supported/);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote runtime newSession runs withSession on replacement context", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: InMemoryPiRuntimeFactory(),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
  try {
    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      cwd: "/srv/new-session-workspace",
    });

    let statusKey: string | undefined;
    let statusText: string | undefined;
    await runtime.session.bindExtensions({
      uiContext: {
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        editor: async () => undefined,
        custom: async () => undefined,
        notify: () => {},
        onTerminalInput: () => () => {},
        setStatus: (nextStatusKey: string, nextStatusText: string | undefined) => {
          statusKey = nextStatusKey;
          statusText = nextStatusText;
        },
        setWorkingMessage: () => {},
        setWorkingIndicator: () => {},
        setHiddenThinkingLabel: () => {},
        setWidget: () => {},
        setFooter: () => {},
        setHeader: () => {},
        setTitle: () => {},
        pasteToEditor: () => {},
        setEditorText: () => {},
        getEditorText: () => "",
        addAutocompleteProvider: () => {},
        setEditorComponent: () => {},
        theme: sessionTheme(),
        getAllThemes: () => [],
        getTheme: () => undefined,
        setTheme: () => ({ success: false }),
        getToolsExpanded: () => false,
        setToolsExpanded: () => {},
      },
    });

    const previousSessionId = runtime.session.sessionManager.getSessionId();
    let replacementSessionId: string | undefined;
    let replacementHasUi: boolean | undefined;

    const result = await runtime.newSession({
      withSession: async (ctx) => {
        replacementSessionId = ctx.sessionManager.getSessionId();
        replacementHasUi = ctx.hasUI;
        ctx.ui.setStatus("replacement", "ready");
        await ctx.sendUserMessage("replacement-session-message");
      },
    });

    assert.equal(result.cancelled, false);
    assert.notEqual(replacementSessionId, previousSessionId);
    assert.equal(replacementSessionId, runtime.session.sessionManager.getSessionId());
    assert.equal(replacementHasUi, true);
    assert.equal(statusKey, "replacement");
    assert.equal(statusText, "ready");
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote runtime switchSession runs withSession on target session", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: InMemoryPiRuntimeFactory(),
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
      body: JSON.stringify({ sessionName: "switch-target" }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
    });

    let notified = false;
    await runtime.session.bindExtensions({
      uiContext: {
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        editor: async () => undefined,
        custom: async () => undefined,
        notify: () => {
          notified = true;
        },
        onTerminalInput: () => () => {},
        setStatus: () => {},
        setWorkingMessage: () => {},
        setWorkingIndicator: () => {},
        setHiddenThinkingLabel: () => {},
        setWidget: () => {},
        setFooter: () => {},
        setHeader: () => {},
        setTitle: () => {},
        pasteToEditor: () => {},
        setEditorText: () => {},
        getEditorText: () => "",
        addAutocompleteProvider: () => {},
        setEditorComponent: () => {},
        theme: sessionTheme(),
        getAllThemes: () => [],
        getTheme: () => undefined,
        setTheme: () => ({ success: false }),
        getToolsExpanded: () => false,
        setToolsExpanded: () => {},
      },
    });

    let replacementSessionId: string | undefined;
    const result = await runtime.switchSession(created.sessionId, {
      withSession: async (ctx) => {
        replacementSessionId = ctx.sessionManager.getSessionId();
        ctx.ui.notify("switched", "info");
        await ctx.sendUserMessage("switched-session-message");
      },
    });

    assert.equal(result.cancelled, false);
    assert.equal(replacementSessionId, created.sessionId);
    assert.equal(runtime.session.sessionManager.getSessionId(), created.sessionId);
    assert.equal(notified, true);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

function sessionTheme() {
  return {
    fg: (_style: string, text: string) => text,
    bg: (_style: string, text: string) => text,
    getBgAnsi: () => "",
  };
}

timedTest("milestone 3 adapter reads session stream via sse", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
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
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    const streamRequests: string[] = [];
    const baseFetch = createInProcessFetch(remote.app);

    runtime = await RemoteAgentSessionRuntime.create({
      origin: "http://localhost:3000",
      auth: {
        keyId: "dev",
        privateKey: privateKeyPem,
      },
      sessionId: created.sessionId,
      fetchImpl: async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes(`/streams/sessions/${created.sessionId}/events`)) {
          streamRequests.push(url);
        }
        return baseFetch(input, init);
      },
    });

    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (streamRequests.some((url) => url.includes("live=sse"))) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(streamRequests.some((url) => url.includes("live=sse")));
    assert.equal(
      streamRequests.some((url) => url.includes("live=long-poll")),
      false,
    );

    const initialSseRequestCount = streamRequests.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    assert.equal(streamRequests.length, initialSseRequestCount);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3 adapter applies live sse control offsets without reconnect", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
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
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    const streamRequests: string[] = [];
    const baseFetch = createInProcessFetch(remote.app);
    runtime = await RemoteAgentSessionRuntime.create({
      origin: "http://localhost:3000",
      auth: {
        keyId: "dev",
        privateKey: privateKeyPem,
      },
      sessionId: created.sessionId,
      fetchImpl: async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes(`/streams/sessions/${created.sessionId}/events`)) {
          streamRequests.push(url);
        }
        return baseFetch(input, init);
      },
    });

    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (streamRequests.length > 0) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    const sessionAny = runtime.session as any;
    const initialOffset = sessionAny.streamOffset;

    const nameResponse = await postSessionCommand(
      remote.app,
      `/v1/sessions/${created.sessionId}/session-name`,
      token,
      {
        sessionName: "live-sse-offset",
      },
    );
    assert.equal(nameResponse.status, 202);

    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (sessionAny.streamOffset !== initialOffset) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    assert.notEqual(sessionAny.streamOffset, initialOffset);
    assert.equal(streamRequests.length, 1);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest(
  "milestone 3 adapter reauthenticates and resumes polling after token invalidation",
  async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    const remote = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: new FakeRuntimeFactory(),
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
      assert.equal(createResponse.status, 201);
      const created = (await createResponse.json()) as { sessionId: string };

      const baseFetch = createInProcessFetch(remote.app);
      let authChallengeCalls = 0;
      let streamUnauthorizedInjected = false;
      runtime = await RemoteAgentSessionRuntime.create({
        origin: "http://localhost:3000",
        auth: {
          keyId: "dev",
          privateKey: privateKeyPem,
        },
        sessionId: created.sessionId,
        fetchImpl: async (input, init) => {
          const url = typeof input === "string" ? input : input.url;
          if (url.includes("/v1/auth/challenge")) {
            authChallengeCalls += 1;
          }
          if (
            !streamUnauthorizedInjected &&
            url.includes(`/streams/sessions/${created.sessionId}/events`)
          ) {
            streamUnauthorizedInjected = true;
            return new Response(JSON.stringify({ error: "Invalid token" }), {
              status: 401,
              headers: {
                "content-type": "application/json",
              },
            });
          }
          return baseFetch(input, init);
        },
      });

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (streamUnauthorizedInjected && authChallengeCalls >= 2) {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }

      assert.equal(streamUnauthorizedInjected, true);
      assert.ok(authChallengeCalls >= 2);
      assert.equal(runtime.session.state.errorMessage, undefined);

      const sessionAny = runtime.session as any;
      const initialOffset = sessionAny.streamOffset;

      const nameResponse = await postSessionCommand(
        remote.app,
        `/v1/sessions/${created.sessionId}/session-name`,
        token,
        {
          sessionName: "resume-after-reauth",
        },
      );
      assert.equal(nameResponse.status, 202);

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (sessionAny.streamOffset !== initialOffset) {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }

      assert.notEqual(sessionAny.streamOffset, initialOffset);

      const remoteErrorMessages = runtime.session.messages.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as { customType?: string }).customType === "remote_error",
      );
      assert.equal(remoteErrorMessages.length, 0);
    } finally {
      await runtime?.dispose();
      await remote.dispose();
    }
  },
);

timedTest("milestone 3 adapter stops auth refresh loop when key is denied", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
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
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    const baseFetch = createInProcessFetch(remote.app);
    let authChallengeCalls = 0;
    runtime = await RemoteAgentSessionRuntime.create({
      origin: "http://localhost:3000",
      auth: {
        keyId: "dev",
        privateKey: privateKeyPem,
      },
      sessionId: created.sessionId,
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("/v1/auth/challenge")) {
          authChallengeCalls += 1;
          if (authChallengeCalls > 1) {
            return new Response(JSON.stringify({ error: "Unknown key" }), {
              status: 403,
              headers: {
                "content-type": "application/json",
              },
            });
          }
        }
        if (url.includes(`/streams/sessions/${created.sessionId}/events`)) {
          return new Response(JSON.stringify({ error: "Invalid token" }), {
            status: 401,
            headers: {
              "content-type": "application/json",
            },
          });
        }
        return baseFetch(input, init);
      },
    });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((runtime.session.state.errorMessage ?? "").includes("Remote authentication denied")) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    assert.match(runtime.session.state.errorMessage ?? "", /Remote authentication denied/);
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    assert.equal(authChallengeCalls, 2);

    const remoteErrorMessages = runtime.session.messages.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        (message as { customType?: string }).customType === "remote_error",
    );
    assert.equal(remoteErrorMessages.length, 1);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3 adapter retries failed stream batch from same offset", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
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
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    const sessionAny = runtime.session as any;
    sessionAny.closed = true;
    sessionAny.activeReadAbortController?.abort();
    await sessionAny.pollingTask;

    sessionAny.closed = false;
    sessionAny.streamOffset = "0-0";

    const offsets: string[] = [];
    let readCalls = 0;
    sessionAny.client.readSessionEvents = async (_sessionId: string, offset: string) => {
      offsets.push(offset);
      readCalls += 1;
      if (readCalls === 1) {
        return {
          events: [
            { kind: "unknown_first", payload: { id: "first" }, streamOffset: "0-1" },
            { kind: "unknown_second", payload: { id: "second" }, streamOffset: "0-2" },
          ],
          nextOffset: "0-3",
          streamClosed: false,
        };
      }
      if (readCalls === 2) {
        return {
          events: [
            { kind: "unknown_first", payload: { id: "first" }, streamOffset: "0-1" },
            { kind: "unknown_second", payload: { id: "second" }, streamOffset: "0-2" },
          ],
          nextOffset: "0-3",
          streamClosed: true,
        };
      }
      throw new Error("unexpected readSessionEvents call");
    };

    const handled: string[] = [];
    let transientFailureInjected = false;
    sessionAny.handleEnvelope = async (envelope: { payload: { id: string } }) => {
      if (!transientFailureInjected) {
        transientFailureInjected = true;
        throw { status: 500, message: "transient" };
      }
      handled.push(envelope.payload.id);
    };

    await sessionAny.pollEvents();

    assert.deepEqual(offsets, ["0-0", "0-0"]);
    assert.deepEqual(handled, ["first", "second"]);
    assert.equal(sessionAny.streamOffset, "0-3");
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("milestone 3 adapter fails fast on non-http polling errors", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
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
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { sessionId: string };

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId: created.sessionId,
    });

    const sessionAny = runtime.session as any;
    sessionAny.closed = true;
    sessionAny.activeReadAbortController?.abort();
    await sessionAny.pollingTask;

    sessionAny.closed = false;

    let readCalls = 0;
    sessionAny.client.readSessionEvents = async () => {
      readCalls += 1;
      throw new Error("schema mismatch");
    };

    await sessionAny.pollEvents();

    assert.equal(readCalls, 1);
    assert.match(
      runtime.session.state.errorMessage ?? "",
      /Remote stream polling failed: schema mismatch/,
    );
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});
