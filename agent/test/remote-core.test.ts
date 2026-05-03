import { expect, test } from "vitest";
import { sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { Value } from "typebox/value";
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
import {
  appendDurableExtensionEvent,
  buildDurableExtensionState,
  createDurableExtensionRemovalEvent,
  REMOTE_DURABLE_EXTENSION_STATE_ENTRY,
  REMOTE_RUNTIME_TRANSITION_ENTRY,
  REMOTE_SESSION_VERSION_ENTRY,
  readDurableExtensionEvents,
  restoreDurableRuntimeDomainState,
} from "../src/remote/session/durable-runtime-state.ts";
import { acceptSessionCommand } from "../src/remote/session/command-acceptance.ts";
import { createSessionRecord } from "../src/remote/session/command-registry.ts";
import { appendMirroredRemoteCustomExtensionEvent } from "../src/remote/session/extension-event-stream.ts";
import { handleRegistrySessionEvent } from "../src/remote/session/event-stream-ops.ts";
import { SessionLiveEventBus } from "../src/remote/live-events.ts";
import {
  bufferPatchEvent,
  handleSessionSync,
  isPatchCoveredBySnapshot,
  toSessionSyncPatchEvent,
} from "../src/remote/routes/session-sync.ts";
import { createV1Routes } from "../src/remote/routes.ts";
import {
  RemoteSessionEntrySchema,
  SettingsUpdateRequestTransportSchema,
} from "../src/remote/schemas-core.ts";
import { SessionSyncPatchEventSchema } from "../src/remote/schemas-stream.ts";
import { sanitizeSessionEntry } from "../src/remote/schema-normalization.ts";
import { syncSessionRecordFromRuntime } from "../src/remote/session/runtime-sync.ts";
import { touchSessionPresence } from "../src/remote/session/presence-ops.ts";
import { createRemoteUiContext } from "../src/remote/session/ui-context.ts";
import {
  InMemoryPiRuntimeFactory,
  type RemoteRuntimeFactory,
} from "../src/remote/runtime-factory.ts";
import { createRemoteThemeFromContent } from "../src/remote/client/remote-theme.ts";
import { RemoteAgentSessionRuntime, createInProcessFetch } from "../src/remote/client-runtime.ts";
import { RuntimeAgentSessionEventSchema } from "../src/remote/client/session/runtime-agent-session-event-schema.ts";
import {
  applySessionSyncPatch,
  replaySnapshotExtensionState,
  replaySnapshotLiveOverlay,
  toAssistantMessagePatchEvent,
} from "../src/remote/client/session/runtime-sync-support.ts";
import { applyRemoteAgentSessionEvent } from "../src/remote/client/session-events.ts";
import { applyToolExecutionSyncPatch } from "../src/remote/client/session/tool-sync-patches.ts";
import { createInitialRemoteSessionState } from "../src/remote/client/session-bootstrap-ops.ts";
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
import modesExtension from "../src/extensions/modes.ts";
import type {
  ClientCapabilities,
  Presence,
  SessionSnapshot,
  SessionSyncEvent,
} from "../src/remote/schemas.ts";
import { SessionRegistry } from "../src/remote/session-registry.ts";
import { SessionCatalog } from "../src/remote/session-catalog.ts";
import {
  appendAndPublish,
  InMemoryDurableStreamStore,
  sessionEventsStreamId,
} from "../src/remote/streams.ts";
import { assertType } from "../src/remote/typebox.ts";
import { createTempPersistedRuntimeHarness } from "./remote-runtime-test-helpers.ts";
import { TEST_ED25519_KEYS, TEST_RSA_PUBLIC_KEY_PEM } from "./remote-test-keys.ts";

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

class InvalidToolMetadataSession extends RecordingSession {
  override getAllTools(): Array<{
    name: string;
    description: string;
    parameters: unknown;
    sourceInfo: unknown;
  }> {
    return [
      {
        name: "read",
        description: "read tool",
        parameters: [],
        sourceInfo: { source: "test" },
      },
    ];
  }
}

class MissingSourceInfoSession extends RecordingSession {
  override getAllTools(): Array<{
    name: string;
    description: string;
    parameters: unknown;
    sourceInfo: unknown;
  }> {
    return [
      {
        name: "read",
        description: "read tool",
        parameters: {},
        sourceInfo: undefined,
      },
    ];
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
  const eventEmitter = new EventEmitter();
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
    eventBus: {
      emit: (channel: string, data: unknown) => {
        eventEmitter.emit(channel, data);
      },
      on: (channel: string, handler: (data: unknown) => void | Promise<void>) => {
        const safeHandler = async (data: unknown) => {
          await handler(data);
        };
        eventEmitter.on(channel, safeHandler);
        return () => {
          eventEmitter.off(channel, safeHandler);
        };
      },
      clear: () => {
        eventEmitter.removeAllListeners();
      },
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
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const snapshot = await client.getSessionSnapshot(sessionId);
    if (
      snapshot.status === "idle" &&
      (snapshot.transcript.length >= expectedCount ||
        snapshot.sessionStats.totalMessages >= expectedCount)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(
    `Timed out waiting for remote session ${sessionId} to reach ${expectedCount} messages`,
  );
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

async function readSessionSyncEvents(
  response: Response,
  timeoutMs = 250,
): Promise<SessionSyncEvent[]> {
  expect(response.status).toBe(200);
  const stream = response.body;
  expect(stream).toBeTruthy();
  if (!stream) {
    return [];
  }

  const events: SessionSyncEvent[] = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for await (const event of parseSseStream(stream, controller.signal)) {
      if (event.type !== "data") {
        continue;
      }
      events.push(JSON.parse(event.data) as SessionSyncEvent);
    }
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "AbortError") {
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }

  return events;
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
    case "queue.update":
    case "retry.status":
      return { kind: "agent_session_event", payload: patch.payload, streamOffset };
    case "assistant.message":
      return { kind: "assistant_message_patch", payload: patch.payload, streamOffset };
    case "tool.execution":
      return { kind: "tool_execution_patch", payload: patch.payload, streamOffset };
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

function buildEmptySnapshot(): SessionSnapshot {
  return {
    sessionId: "buffer-session",
    status: "idle",
    cwd: "/tmp/buffer-session",
    model: "remote/model",
    thinkingLevel: "medium",
    activeTools: [],
    extensions: [],
    resources: {
      skills: [],
      prompts: [],
      themes: [],
      systemPrompt: null,
      appendSystemPrompt: [],
    },
    settings: {
      defaultProvider: "codex-openai",
      defaultModel: "gpt-5.5",
      hideThinkingBlock: true,
      defaultThinkingLevel: "low",
      transport: "auto",
      quietStartup: true,
      editorPaddingX: 0,
      collapseChangelog: true,
      enableInstallTelemetry: false,
      lastChangelogVersion: "0.70.0",
      theme: "catppuccin-mocha",
      retry: {
        enabled: true,
        maxRetries: 1024,
      },
      terminal: {
        showImages: true,
        clearOnShrink: false,
        showTerminalProgress: true,
      },
    },
    availableModels: [],
    modelSettings: {
      defaultProvider: null,
      defaultModel: null,
      defaultThinkingLevel: null,
      enabledModels: null,
    },
    sessionStats: {
      sessionId: "buffer-session",
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
    },
    usageCost: 0,
    autoCompactionEnabled: false,
    steeringMode: "all",
    followUpMode: "all",
    executorState: { kind: "idle" },
    gitState: {
      gitRoot: null,
      trackedFiles: [],
      trackedSet: [],
      statusEntries: [],
      projectInfo: {
        dirty: false,
        addedLines: 0,
        removedLines: 0,
        aheadCommits: 0,
        behindCommits: 0,
      },
    },
    entries: [],
    leafId: null,
    transcript: [],
    queue: {
      depth: 0,
      nextSequence: 1,
    },
    live: {
      queuedSteeringMessages: [],
      queuedFollowUpMessages: [],
      retryAttempt: 0,
      activeToolExecutions: [],
    },
    retry: { status: "idle" },
    compaction: { status: "idle" },
    presence: [],
    activeRun: null,
    interruptedRuntimeDomains: {
      queue: false,
      retry: false,
      compaction: false,
      bash: false,
      streaming: false,
    },
    pendingUiRequests: [],
    uiState: {
      statuses: [],
      widgets: [],
    },
    durableExtensionState: [],
    streamingState: "idle",
    isBashRunning: false,
    hasPendingBashMessages: false,
    pendingToolCalls: [],
    errorMessage: null,
    createdAt: 0,
    updatedAt: 0,
    version: "0",
  };
}

timedTest("health endpoint reports ready status", async () => {
  const { publicKeyPem } = TEST_ED25519_KEYS;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new InMemoryPiRuntimeFactory(),
  });

  try {
    const response = await remote.app.request("/health", {
      method: "GET",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      service: string;
    };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("pi-remote");
  } finally {
    await remote.dispose();
  }
});

timedTest("stream endpoints reject malformed offsets", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

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
    expect(appStream.status).toBe(404);

    const sessionStream = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?offset=bad-offset`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(sessionStream.status).toBe(404);
  } finally {
    await remote.dispose();
  }
});

timedTest("session sync stream emits connected then snapshot", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

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

    const response = await remote.app.request(`/v1/sessions/${created.sessionId}/sync`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();
    let payload = "";
    while (!payload.includes('"type":"snapshot"')) {
      const chunk = await reader!.read();
      if (chunk.done) {
        break;
      }
      payload += new TextDecoder().decode(chunk.value);
    }
    void reader?.cancel();

    expect(payload).toMatch(/"type":"server.connected"/);
    expect(payload).toMatch(/"type":"snapshot"/);
    expect(payload).toMatch(new RegExp(`"sessionId":"${created.sessionId}"`));
    expect(payload).not.toMatch(/lastAppStreamOffsetSeenByServer/);
  } finally {
    await remote.dispose();
  }
});

timedTest("session sync compaction patches use explicit taxonomy", () => {
  const event = {
    eventId: "1",
    sessionId: "session-1",
    streamOffset: "0",
    sessionVersion: "3",
    ts: 1,
    kind: "agent_session_event",
    payload: {
      type: "compaction_start",
      reason: "threshold",
    },
  } as const;

  expect(toSessionSyncPatchEvent("session-1", event)).toEqual({
    type: "patch",
    sessionId: "session-1",
    version: "3",
    patch: {
      patchType: "compaction.status",
      payload: {
        type: "compaction_start",
        reason: "threshold",
      },
    },
  });
});

timedTest("session sync lifecycle patches use explicit taxonomy", () => {
  const event = {
    eventId: "1",
    sessionId: "session-1",
    streamOffset: "0",
    sessionVersion: "3",
    ts: 1,
    kind: "agent_session_event",
    payload: {
      type: "turn_start",
      turnIndex: 1,
      timestamp: 1,
    },
  } as const;

  expect(toSessionSyncPatchEvent("session-1", event)).toEqual({
    type: "patch",
    sessionId: "session-1",
    version: "3",
    patch: {
      patchType: "agent.lifecycle",
      payload: event.payload,
    },
  });
});

timedTest("session sync keeps known lifecycle events out of fallback taxonomy", () => {
  const event = {
    eventId: "1",
    sessionId: "session-1",
    streamOffset: "0",
    sessionVersion: "3",
    ts: 1,
    kind: "agent_session_event",
    payload: {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    },
  } as const;

  expect(toSessionSyncPatchEvent("session-1", event)?.patch.patchType).toBe("agent.lifecycle");
});

timedTest("session sync drops opaque agent.event residue from typed sync protocol", () => {
  const event = {
    eventId: "1",
    sessionId: "session-1",
    streamOffset: "0",
    sessionVersion: "3",
    ts: 1,
    kind: "agent_session_event",
    payload: {
      type: "unknown_future_event",
      id: "residual",
    },
  } as const;

  expect(toSessionSyncPatchEvent("session-1", event)).toBeUndefined();
});

timedTest("session sync assistant patches send minimal text deltas", () => {
  const event = {
    eventId: "1",
    sessionId: "session-1",
    streamOffset: "0",
    sessionVersion: "3",
    ts: 1,
    kind: "agent_session_event",
    payload: {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial answer" }],
        api: "responses",
        provider: "demo",
        model: "demo",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 1,
      },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: " answer",
        partial: {
          role: "assistant",
          content: [{ type: "text", text: "partial answer" }],
          api: "responses",
          provider: "demo",
          model: "demo",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 1,
        },
      },
    },
  } as const;

  expect(toSessionSyncPatchEvent("session-1", event)).toEqual({
    type: "patch",
    sessionId: "session-1",
    version: "3",
    patch: {
      patchType: "assistant.message",
      payload: {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          start: 7,
          delta: " answer",
        },
      },
    },
  });
});

timedTest("session sync tool patches send output deltas when output grows", () => {
  const liveEvents = new SessionLiveEventBus();
  const streams = new InMemoryDurableStreamStore({ liveEventBus: liveEvents });
  const runtime = {
    cwd: "/tmp/runtime-tool-delta",
    dispose: async () => {},
  } as never;
  const record = createSessionRecord({
    sessionId: "runtime-tool-delta-session",
    persistence: "ephemeral",
    cwd: "/tmp/runtime-tool-delta",
    createdAt: 1,
    runtime,
    readRuntimeExtensionMetadata: () => [],
  });
  const sessions = new Map([[record.sessionId, record]]);
  const toolEvents = [] as Array<Extract<SessionSyncEvent, { type: "patch" }>["patch"]>;
  const unsubscribe = liveEvents.subscribe(sessionEventsStreamId(record.sessionId), (event) => {
    const patchEvent = toSessionSyncPatchEvent(record.sessionId, event);
    if (patchEvent?.type === "patch" && patchEvent.patch.patchType === "tool.execution") {
      toolEvents.push(patchEvent.patch);
    }
  });

  try {
    handleRegistrySessionEvent({
      sessionId: record.sessionId,
      event: {
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "echo hi" },
      },
      sessions,
      streams,
      liveEvents,
      now: 1,
      createRunId: () => "run-1",
      syncFromRuntime: () => {},
      emitSessionSummaryUpdated: () => {},
    });
    handleRegistrySessionEvent({
      sessionId: record.sessionId,
      event: {
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "echo hi" },
        partialResult: {
          content: [{ type: "text", text: "hi" }],
          details: { truncation: null, fullOutputPath: null },
        },
      },
      sessions,
      streams,
      liveEvents,
      now: 2,
      createRunId: () => "run-1",
      syncFromRuntime: () => {},
      emitSessionSummaryUpdated: () => {},
    });
    handleRegistrySessionEvent({
      sessionId: record.sessionId,
      event: {
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "echo hi" },
        partialResult: {
          content: [{ type: "text", text: "hi there" }],
          details: { truncation: null, fullOutputPath: null },
        },
      },
      sessions,
      streams,
      liveEvents,
      now: 3,
      createRunId: () => "run-1",
      syncFromRuntime: () => {},
      emitSessionSummaryUpdated: () => {},
    });

    expect(toolEvents.at(-1)).toEqual({
      patchType: "tool.execution",
      payload: {
        type: "tool_execution_output_delta",
        toolCallId: "tool-1",
        start: 2,
        delta: " there",
      },
    });
  } finally {
    unsubscribe();
  }
});

timedTest("session sync tool patches send structured partial ops for nested changes", () => {
  const liveEvents = new SessionLiveEventBus();
  const streams = new InMemoryDurableStreamStore({ liveEventBus: liveEvents });
  const runtime = {
    cwd: "/tmp/runtime-tool-partial-patch",
    dispose: async () => {},
  } as never;
  const record = createSessionRecord({
    sessionId: "runtime-tool-partial-patch-session",
    persistence: "ephemeral",
    cwd: "/tmp/runtime-tool-partial-patch",
    createdAt: 1,
    runtime,
    readRuntimeExtensionMetadata: () => [],
  });
  const sessions = new Map([[record.sessionId, record]]);
  const toolEvents = [] as Array<Extract<SessionSyncEvent, { type: "patch" }>["patch"]>;
  const unsubscribe = liveEvents.subscribe(sessionEventsStreamId(record.sessionId), (event) => {
    const patchEvent = toSessionSyncPatchEvent(record.sessionId, event);
    if (patchEvent?.type === "patch" && patchEvent.patch.patchType === "tool.execution") {
      toolEvents.push(patchEvent.patch);
    }
  });

  try {
    handleRegistrySessionEvent({
      sessionId: record.sessionId,
      event: {
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "echo hi" },
      },
      sessions,
      streams,
      liveEvents,
      now: 1,
      createRunId: () => "run-1",
      syncFromRuntime: () => {},
      emitSessionSummaryUpdated: () => {},
    });
    handleRegistrySessionEvent({
      sessionId: record.sessionId,
      event: {
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "echo hi" },
        partialResult: {
          content: [{ type: "text", text: "hi" }],
          details: { truncation: null, fullOutputPath: null },
        },
      },
      sessions,
      streams,
      liveEvents,
      now: 2,
      createRunId: () => "run-1",
      syncFromRuntime: () => {},
      emitSessionSummaryUpdated: () => {},
    });
    handleRegistrySessionEvent({
      sessionId: record.sessionId,
      event: {
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "echo hi" },
        partialResult: {
          content: [{ type: "text", text: "hi" }],
          details: { truncation: "tail", fullOutputPath: null },
        },
      },
      sessions,
      streams,
      liveEvents,
      now: 3,
      createRunId: () => "run-1",
      syncFromRuntime: () => {},
      emitSessionSummaryUpdated: () => {},
    });

    expect(toolEvents.at(-1)).toEqual({
      patchType: "tool.execution",
      payload: {
        type: "tool_execution_partial_patch",
        toolCallId: "tool-1",
        ops: [
          {
            op: "replace",
            path: ["details", "truncation"],
            value: "tail",
          },
        ],
      },
    });
  } finally {
    unsubscribe();
  }
});

timedTest("snapshot handoff keeps assistant trailing duplicate substring delta", () => {
  const patchEvent: SessionSyncEvent = {
    type: "patch",
    sessionId: "session-1",
    version: "3",
    patch: {
      patchType: "assistant.message",
      payload: {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "abc",
        },
      },
    },
  };

  const snapshot = {
    version: "3",
    transcript: [],
    live: {
      queuedSteeringMessages: [],
      queuedFollowUpMessages: [],
      retryAttempt: 0,
      activeToolExecutions: [],
      streamingMessage: {
        role: "assistant",
        content: [{ type: "text", text: "abc...earlier...abc" }],
        api: "responses",
        provider: "demo",
        model: "demo",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 1,
      },
    },
    queue: { depth: 0, nextSequence: 0, steering: [], followUp: [] },
    retry: { status: "idle" },
    compaction: { status: "idle" },
    streamingState: "streaming",
    isBashRunning: false,
    hasPendingBashMessages: false,
    pendingToolCalls: [],
    interruptedRuntimeDomains: {
      queue: false,
      retry: false,
      compaction: false,
      bash: false,
      streaming: false,
    },
    pendingUiRequests: [],
    uiState: { statuses: [], widgets: [] },
    durableExtensionState: [],
    errorMessage: null,
    model: "demo/demo",
    thinkingLevel: "medium",
    activeTools: [],
    autoCompactionEnabled: false,
    steeringMode: "all",
    followUpMode: "all",
    resources: { prompts: [], rules: [], mcps: [] },
    settings: { global: {}, project: {} },
    availableModels: [],
    modelSettings: {
      defaultProvider: null,
      defaultModel: null,
      defaultThinkingLevel: null,
      enabledModels: null,
    },
    sessionStats: {
      sessionId: "session-1",
      turns: 0,
      messages: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cost: 0,
    },
    usageCost: 0,
    createdAt: 1,
    updatedAt: 1,
    cwd: "/tmp",
    status: "running",
    presence: [],
    extensions: [],
  } as SessionSnapshot;

  expect(isPatchCoveredBySnapshot(patchEvent, snapshot)).toBe(false);
});

timedTest("snapshot handoff keeps tool trailing duplicate substring delta", () => {
  const patchEvent: SessionSyncEvent = {
    type: "patch",
    sessionId: "session-1",
    version: "3",
    patch: {
      patchType: "tool.execution",
      payload: {
        type: "tool_execution_output_delta",
        toolCallId: "tool-1",
        delta: "abc",
      },
    },
  };

  const snapshot = {
    version: "3",
    transcript: [],
    live: {
      queuedSteeringMessages: [],
      queuedFollowUpMessages: [],
      retryAttempt: 0,
      streamingMessage: undefined,
      activeToolExecutions: [
        {
          toolCallId: "tool-1",
          toolName: "bash",
          args: { command: "echo" },
          partialResult: {
            content: [{ type: "text", text: "abc...earlier...abc" }],
            details: { truncation: null, fullOutputPath: null },
          },
        },
      ],
    },
    queue: { depth: 0, nextSequence: 0, steering: [], followUp: [] },
    retry: { status: "idle" },
    compaction: { status: "idle" },
    streamingState: "idle",
    isBashRunning: false,
    hasPendingBashMessages: false,
    pendingToolCalls: ["tool-1"],
    interruptedRuntimeDomains: {
      queue: false,
      retry: false,
      compaction: false,
      bash: false,
      streaming: false,
    },
    pendingUiRequests: [],
    uiState: { statuses: [], widgets: [] },
    durableExtensionState: [],
    errorMessage: null,
    model: "demo/demo",
    thinkingLevel: "medium",
    activeTools: [],
    autoCompactionEnabled: false,
    steeringMode: "all",
    followUpMode: "all",
    resources: { prompts: [], rules: [], mcps: [] },
    settings: { global: {}, project: {} },
    availableModels: [],
    modelSettings: {
      defaultProvider: null,
      defaultModel: null,
      defaultThinkingLevel: null,
      enabledModels: null,
    },
    sessionStats: {
      sessionId: "session-1",
      turns: 0,
      messages: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cost: 0,
    },
    usageCost: 0,
    createdAt: 1,
    updatedAt: 1,
    cwd: "/tmp",
    status: "running",
    presence: [],
    extensions: [],
  } as SessionSnapshot;

  expect(isPatchCoveredBySnapshot(patchEvent, snapshot)).toBe(false);
});

timedTest("assistant toolcall sync patch drops partial payload on delta path", () => {
  const event = {
    eventId: "1",
    sessionId: "session-1",
    streamOffset: "0",
    sessionVersion: "3",
    ts: 1,
    kind: "agent_session_event",
    payload: {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: {} }],
        api: "responses",
        provider: "demo",
        model: "demo",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 1,
      },
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '{"command":"ls"}',
        partial: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-1",
              name: "bash",
              arguments: { command: "ls" },
            },
          ],
          api: "responses",
          provider: "demo",
          model: "demo",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 1,
        },
      },
    },
  } as const;

  const patch = toSessionSyncPatchEvent("session-1", event);
  expect(patch?.type).toBe("patch");
  expect(JSON.stringify(patch)).not.toContain("partial");
});

timedTest("session sync patch schema no longer accepts agent.event", () => {
  expect(
    Value.Check(SessionSyncPatchEventSchema, {
      type: "patch",
      sessionId: "session-1",
      version: "3",
      patch: {
        patchType: "agent.event",
        eventType: "unknown_future_event",
        payload: { type: "unknown_future_event" },
      },
    }),
  ).toBe(false);
});

timedTest("session tools rejects invalid metadata objects", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(new InvalidToolMetadataSession()),
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

    const response = await remote.app.request(`/v1/sessions/${created.sessionId}/tools`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain("parameters must be JSON object");
  } finally {
    await remote.dispose();
  }
});

timedTest("session tools preserves missing sourceInfo instead of inventing it", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(new MissingSourceInfoSession()),
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

    const response = await remote.app.request(`/v1/sessions/${created.sessionId}/tools`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { tools: Array<Record<string, unknown>> };
    expect(payload.tools).toHaveLength(1);
    expect(payload.tools[0]).not.toHaveProperty("sourceInfo");
    expect(payload.tools[0]).toMatchObject({
      name: "read",
      description: "read tool",
      parameters: {},
      definition: expect.objectContaining({
        name: "read",
        label: "read",
      }),
    });
  } finally {
    await remote.dispose();
  }
});

timedTest("runtime event schema validates narrowed sync payloads", () => {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  expect(
    Value.Check(RuntimeAgentSessionEventSchema, {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
        api: "responses",
        provider: "demo",
        model: "demo-1",
        usage,
        stopReason: "toolUse",
        timestamp: 1,
      },
      assistantMessageEvent: {
        type: "start",
        partial: {
          role: "assistant",
          content: [{ type: "text", text: "partial" }],
          api: "responses",
          provider: "demo",
          model: "demo-1",
          usage,
          stopReason: "toolUse",
          timestamp: 1,
        },
      },
    }),
  ).toBe(true);

  expect(
    Value.Check(RuntimeAgentSessionEventSchema, {
      type: "tool_execution_update",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "README.md" },
      partialResult: { lines: ["x"] },
    }),
  ).toBe(true);

  expect(
    Value.Check(RuntimeAgentSessionEventSchema, {
      type: "turn_end",
      turnIndex: 1,
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      toolResults: [],
    }),
  ).toBe(true);

  expect(
    Value.Check(RuntimeAgentSessionEventSchema, {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {},
    }),
  ).toBe(false);
});

timedTest("session sync drops buffered patches already covered by snapshot", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

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

    const syncResponse = await remote.app.request(`/v1/sessions/${created.sessionId}/sync`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(syncResponse.status).toBe(200);

    const renameResponse = await remote.app.request(
      `/v1/sessions/${created.sessionId}/session-name`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionName: "buffered" }),
      },
    );
    expect(renameResponse.status).toBe(202);

    const reader = syncResponse.body?.getReader();
    expect(reader).toBeTruthy();
    let payload = "";
    while (!payload.includes('"type":"snapshot"')) {
      const chunk = await reader!.read();
      if (chunk.done) {
        break;
      }
      payload += new TextDecoder().decode(chunk.value);
    }
    void reader?.cancel();

    expect(payload.match(/"type":"snapshot"/g)?.length ?? 0).toBe(1);
    expect(payload.match(/"type":"patch"/g)?.length ?? 0).toBe(0);
  } finally {
    await remote.dispose();
  }
});

timedTest("session sync drains only uncovered buffered live patches after snapshot", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const rootDir = await mkdtemp(join(tmpdir(), "pi-remote-sync-buffered-drain-"));
  const liveEvents = new SessionLiveEventBus();
  const streams = new InMemoryDurableStreamStore({ liveEventBus: liveEvents });
  const sessions = new SessionRegistry({
    streams,
    liveEvents,
    runtimeFactory: new InMemoryPiRuntimeFactory(),
    catalog: new SessionCatalog({ rootDir }),
  });
  const originalLoadSessionSnapshot = sessions.loadSessionSnapshot.bind(sessions);
  let releaseSnapshotLoad: (() => void) | undefined;
  const snapshotLoadGate = new Promise<void>((resolve) => {
    releaseSnapshotLoad = resolve;
  });
  sessions.loadSessionSnapshot = async (...args) => {
    await snapshotLoadGate;
    const snapshot = await originalLoadSessionSnapshot(...args);
    return {
      ...snapshot,
      version: "9",
      streamingState: "streaming",
      pendingToolCalls: ["tool-1"],
      live: {
        queuedSteeringMessages: [],
        queuedFollowUpMessages: [],
        retryAttempt: 0,
        streamingMessage: {
          role: "assistant",
          content: [{ type: "text", text: "partial answer" }],
          api: "remote",
          provider: "remote",
          model: "remote",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 2,
        },
        activeToolExecutions: [
          {
            toolCallId: "tool-1",
            toolName: "bash",
            args: { command: "echo hi" },
            partialResult: { output: "hi" },
          },
        ],
      },
    };
  };

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
      liveEvents,
    }),
  );

  try {
    const token = await authenticate(app, privateKeyPem);
    const createResponse = await app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    const syncResponsePromise = app.request(`/v1/sessions/${created.sessionId}/sync`, {
      headers: { authorization: `Bearer ${token}` },
    });

    await waitForValue(
      () => releaseSnapshotLoad,
      (value) => value !== undefined,
    );

    appendAndPublish(streams, liveEvents, sessionEventsStreamId(created.sessionId), {
      sessionId: created.sessionId,
      kind: "assistant_message_patch",
      sessionVersion: "7",
      payload: {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          start: 0,
          delta: "partial",
        },
      },
    });
    appendAndPublish(streams, liveEvents, sessionEventsStreamId(created.sessionId), {
      sessionId: created.sessionId,
      kind: "tool_execution_patch",
      sessionVersion: "8",
      payload: {
        type: "tool_execution_update",
        toolCallId: "tool-1",
        partialResult: { output: "newer" },
      },
    });

    releaseSnapshotLoad?.();
    const syncResponse = await syncResponsePromise;
    expect(syncResponse.status).toBe(200);
    const reader = syncResponse.body?.getReader();
    expect(reader).toBeTruthy();

    let payload = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const chunk = await reader!.read();
      if (chunk.done) {
        break;
      }
      payload += new TextDecoder().decode(chunk.value);
      if (payload.includes('"partial answer"') && payload.includes('"newer"')) {
        break;
      }
    }
    void reader?.cancel();

    expect(payload).toContain('"type":"snapshot"');
    expect(payload).toContain('"partial answer"');
    expect(payload).not.toContain('"text":"partial"');
    expect(payload).toContain('"partialResult":{"output":"newer"}');
  } finally {
    await sessions.dispose();
    await rm(rootDir, { recursive: true, force: true });
  }
});

timedTest(
  "session sync client drain converges to snapshot assistant and newer buffered tool progress",
  async () => {
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
    const rootDir = await mkdtemp(join(tmpdir(), "pi-remote-sync-client-drain-"));
    const liveEvents = new SessionLiveEventBus();
    const streams = new InMemoryDurableStreamStore({ liveEventBus: liveEvents });
    const sessions = new SessionRegistry({
      streams,
      liveEvents,
      runtimeFactory: new InMemoryPiRuntimeFactory(),
      catalog: new SessionCatalog({ rootDir }),
    });
    const originalLoadSessionSnapshot = sessions.loadSessionSnapshot.bind(sessions);
    let releaseSnapshotLoad: (() => void) | undefined;
    const snapshotLoadGate = new Promise<void>((resolve) => {
      releaseSnapshotLoad = resolve;
    });
    sessions.loadSessionSnapshot = async (...args) => {
      await snapshotLoadGate;
      const snapshot = await originalLoadSessionSnapshot(...args);
      return {
        ...snapshot,
        version: "9",
        streamingState: "streaming",
        pendingToolCalls: ["tool-1"],
        live: {
          queuedSteeringMessages: [],
          queuedFollowUpMessages: [],
          retryAttempt: 0,
          streamingMessage: {
            role: "assistant",
            content: [{ type: "text", text: "partial answer" }],
            api: "remote",
            provider: "remote",
            model: "remote",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 2,
          },
          activeToolExecutions: [
            {
              toolCallId: "tool-1",
              toolName: "bash",
              args: { command: "echo hi" },
              partialResult: { output: "hi" },
            },
          ],
        },
      };
    };

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
        liveEvents,
      }),
    );

    try {
      const token = await authenticate(app, privateKeyPem);
      const createResponse = await app.request("/v1/sessions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as { sessionId: string };

      const syncResponsePromise = app.request(`/v1/sessions/${created.sessionId}/sync`, {
        headers: { authorization: `Bearer ${token}` },
      });

      await waitForValue(
        () => releaseSnapshotLoad,
        (value) => value !== undefined,
      );

      appendAndPublish(streams, liveEvents, sessionEventsStreamId(created.sessionId), {
        sessionId: created.sessionId,
        kind: "assistant_message_patch",
        sessionVersion: "7",
        payload: {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            start: 0,
            delta: "partial",
          },
        },
      });
      appendAndPublish(streams, liveEvents, sessionEventsStreamId(created.sessionId), {
        sessionId: created.sessionId,
        kind: "tool_execution_patch",
        sessionVersion: "8",
        payload: {
          type: "tool_execution_update",
          toolCallId: "tool-1",
          partialResult: { output: "newer" },
        },
      });

      releaseSnapshotLoad?.();
      const syncResponse = await syncResponsePromise;
      const events = await readSessionSyncEvents(syncResponse);
      const snapshotEvent = events.find((event) => event.type === "snapshot");
      expect(snapshotEvent?.type).toBe("snapshot");
      if (snapshotEvent?.type !== "snapshot") {
        return;
      }

      const state = createInitialRemoteSessionState({
        snapshot: snapshotEvent.snapshot,
        model: undefined,
        thinkingLevel: "medium",
      });
      const activeSyncToolExecutions = new Map<string, { toolName: string; args: unknown }>();
      const assistantUpdates: string[] = [];
      const toolUpdates: string[] = [];
      const applyAgentEvent = (event: Parameters<typeof applyRemoteAgentSessionEvent>[1]) => {
        applyRemoteAgentSessionEvent(state, event, {
          queuedSteeringMessages: [],
          queuedFollowUpMessages: [],
          queueDepth: 0,
          isRetrying: false,
          retryAttempt: 0,
          isCompacting: false,
        });

        if (event.type === "message_update" && event.message.role === "assistant") {
          const block = event.message.content[0];
          if (block?.type === "text") {
            assistantUpdates.push(block.text);
          }
        }

        if (event.type === "tool_execution_update") {
          toolUpdates.push(JSON.stringify(event.partialResult));
        }
      };

      replaySnapshotLiveOverlay({
        snapshot: snapshotEvent.snapshot,
        forwardAgentSessionEventToLocalExtensions: applyAgentEvent,
      });

      for (const execution of snapshotEvent.snapshot.live.activeToolExecutions) {
        activeSyncToolExecutions.set(execution.toolCallId, {
          toolName: execution.toolName,
          args: execution.args,
        });
      }

      for (const event of events) {
        if (event.type !== "patch") {
          continue;
        }

        await applySessionSyncPatch({
          patch: event.patch,
          handleAgentSessionEvent: applyAgentEvent,
          handleAssistantMessagePatch: (payload) => {
            applyAgentEvent(toAssistantMessagePatchEvent(payload));
          },
          handleToolExecutionPatch: (payload) => {
            applyToolExecutionSyncPatch({
              payload,
              activeSyncToolExecutions,
              applyAgentSessionEvent: applyAgentEvent,
            });
          },
          applySessionStatePatch: () => {},
          handleExtensionEvent: () => {},
          isForwardableRemoteExtensionEvent: () => false,
          emitExtensionCustom: () => {},
          handleUiRequest: async () => {},
          cancelUiRequest: () => {},
          handleExtensionError: () => {},
          handleBashStart: () => {},
          handleBashChunk: () => {},
          handleBashEnd: () => {},
          handleBashFlush: () => {},
        });
      }

      expect(state.streamingMessage).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "partial answer" }],
      });
      expect(assistantUpdates).not.toContain("partial");
      expect(toolUpdates).toEqual([
        JSON.stringify({ output: "hi" }),
        JSON.stringify({ output: "newer" }),
      ]);
    } finally {
      await sessions.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  },
);

timedTest("completed snapshot suppresses stale assistant progress patches", () => {
  const patchEvent: SessionSyncEvent = {
    type: "patch",
    sessionId: "session-1",
    version: "5",
    patch: {
      patchType: "assistant.message",
      payload: {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "stale",
          partial: {
            role: "assistant",
            content: [{ type: "text", text: "stale" }],
            api: "responses",
            provider: "demo",
            model: "demo",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 1,
          },
        },
      },
    },
  };

  expect(
    isPatchCoveredBySnapshot(patchEvent, {
      ...buildEmptySnapshot(),
      version: "5",
      streamingState: "idle",
      live: {
        queuedSteeringMessages: [],
        queuedFollowUpMessages: [],
        retryAttempt: 0,
        activeToolExecutions: [],
      },
    }),
  ).toBe(true);
});

timedTest("active snapshot suppresses older buffered assistant partials", () => {
  const patchEvent: SessionSyncEvent = {
    type: "patch",
    sessionId: "session-1",
    version: "5",
    patch: {
      patchType: "assistant.message",
      payload: {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          start: 0,
          delta: "partial",
        },
      },
    },
  };

  expect(
    isPatchCoveredBySnapshot(patchEvent, {
      ...buildEmptySnapshot(),
      version: "5",
      streamingState: "streaming",
      live: {
        queuedSteeringMessages: [],
        queuedFollowUpMessages: [],
        retryAttempt: 0,
        streamingMessage: {
          role: "assistant",
          content: [{ type: "text", text: "partial answer" }],
          api: "responses",
          provider: "demo",
          model: "demo",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 2,
        },
        activeToolExecutions: [],
      },
    }),
  ).toBe(true);
});

timedTest("snapshot handoff keeps assistant later duplicate text delta", () => {
  const patchEvent: SessionSyncEvent = {
    type: "patch",
    sessionId: "session-1",
    version: "5",
    patch: {
      patchType: "assistant.message",
      payload: {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          start: 14,
          delta: "abc",
        },
      },
    },
  };

  expect(
    isPatchCoveredBySnapshot(patchEvent, {
      ...buildEmptySnapshot(),
      version: "5",
      streamingState: "streaming",
      live: {
        queuedSteeringMessages: [],
        queuedFollowUpMessages: [],
        retryAttempt: 0,
        streamingMessage: {
          role: "assistant",
          content: [{ type: "text", text: "abc...earlier...xyz" }],
          api: "responses",
          provider: "demo",
          model: "demo",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 2,
        },
        activeToolExecutions: [],
      },
    }),
  ).toBe(false);
});

timedTest("snapshot handoff keeps assistant later duplicate thinking delta", () => {
  const patchEvent: SessionSyncEvent = {
    type: "patch",
    sessionId: "session-1",
    version: "5",
    patch: {
      patchType: "assistant.message",
      payload: {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          start: 14,
          delta: "abc",
        },
      },
    },
  };

  expect(
    isPatchCoveredBySnapshot(patchEvent, {
      ...buildEmptySnapshot(),
      version: "5",
      streamingState: "streaming",
      live: {
        queuedSteeringMessages: [],
        queuedFollowUpMessages: [],
        retryAttempt: 0,
        streamingMessage: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "abc...earlier...xyz" }],
          api: "responses",
          provider: "demo",
          model: "demo",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 2,
        },
        activeToolExecutions: [],
      },
    }),
  ).toBe(false);
});

timedTest("completed snapshot suppresses stale tool progress patches", () => {
  const patchEvent: SessionSyncEvent = {
    type: "patch",
    sessionId: "session-1",
    version: "5",
    patch: {
      patchType: "tool.execution",
      payload: {
        type: "tool_execution_update",
        toolCallId: "tool-1",
        partialResult: { output: "stale" },
      },
    },
  };

  expect(
    isPatchCoveredBySnapshot(patchEvent, {
      ...buildEmptySnapshot(),
      version: "5",
      pendingToolCalls: [],
      live: {
        queuedSteeringMessages: [],
        queuedFollowUpMessages: [],
        retryAttempt: 0,
        activeToolExecutions: [],
      },
    }),
  ).toBe(true);
});

timedTest("active snapshot replays newer buffered tool progress patches", () => {
  const patchEvent: SessionSyncEvent = {
    type: "patch",
    sessionId: "session-1",
    version: "5",
    patch: {
      patchType: "tool.execution",
      payload: {
        type: "tool_execution_update",
        toolCallId: "tool-1",
        partialResult: { output: "newer" },
      },
    },
  };

  expect(
    isPatchCoveredBySnapshot(patchEvent, {
      ...buildEmptySnapshot(),
      version: "5",
      pendingToolCalls: ["tool-1"],
      live: {
        queuedSteeringMessages: [],
        queuedFollowUpMessages: [],
        retryAttempt: 0,
        activeToolExecutions: [
          {
            toolCallId: "tool-1",
            toolName: "bash",
            args: { command: "echo hi" },
            partialResult: { output: "older" },
          },
        ],
      },
    }),
  ).toBe(false);
});

timedTest("active snapshot suppresses equal buffered assistant tool call content", () => {
  const patchEvent: SessionSyncEvent = {
    type: "patch",
    sessionId: "session-1",
    version: "5",
    patch: {
      patchType: "assistant.message",
      payload: {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 0,
          toolCall: {
            type: "toolCall",
            id: "tool-1",
            name: "read",
            arguments: { path: "README.md" },
          },
        },
      },
    },
  };

  expect(
    isPatchCoveredBySnapshot(patchEvent, {
      ...buildEmptySnapshot(),
      version: "5",
      streamingState: "streaming",
      live: {
        queuedSteeringMessages: [],
        queuedFollowUpMessages: [],
        retryAttempt: 0,
        streamingMessage: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-1",
              name: "read",
              arguments: { path: "README.md" },
            },
          ],
          api: "responses",
          provider: "demo",
          model: "demo",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 1,
        },
        activeToolExecutions: [],
      },
    }),
  ).toBe(true);
});

timedTest("ephemeral custom extension events stay live-only", () => {
  const liveEvents = new SessionLiveEventBus();
  const streams = new InMemoryDurableStreamStore();
  const sessionId = "test-session";
  const streamId = `sessions/${sessionId}/events`;
  streams.ensureStream(streamId);
  const liveEventsSeen: string[] = [];
  const unsubscribe = liveEvents.subscribe(streamId, (event) => {
    if (event.kind === "extension_custom_event") {
      liveEventsSeen.push(event.payload.channel);
    }
  });

  appendMirroredRemoteCustomExtensionEvent({
    streams,
    liveEvents,
    record: { sessionId } as never,
    channel: "demo:ephemeral",
    data: { sync: "ephemeral", value: "ignored" },
    ts: Date.now(),
  });

  expect(liveEventsSeen).toEqual(["demo:ephemeral"]);
  unsubscribe();
});

timedTest("origin client suppresses echoed custom extension patch", async () => {
  const seen: Array<{ channel: string; data: unknown }> = [];

  await applySessionSyncPatch({
    patch: {
      patchType: "extension.custom",
      payload: {
        channel: "demo:custom",
        data: { sync: "replaceable", replaceKey: "slot", value: 1 },
        originConnectionId: "conn-1",
      },
    } as Extract<SessionSyncEvent, { type: "patch" }>["patch"],
    handleAgentSessionEvent: () => {},
    handleAssistantMessagePatch: () => {},
    handleToolExecutionPatch: () => {},
    applySessionStatePatch: () => {},
    handleExtensionEvent: () => {},
    isForwardableRemoteExtensionEvent: () => false,
    emitExtensionCustom: (channel, data) => {
      seen.push({ channel, data });
    },
    handleUiRequest: async () => {},
    cancelUiRequest: () => {},
    handleExtensionError: () => {},
    handleBashStart: () => {},
    handleBashChunk: () => {},
    handleBashEnd: () => {},
    handleBashFlush: () => {},
    localConnectionId: "conn-1",
  });

  expect(seen).toEqual([]);
});

timedTest("durable store append stays silent until live bus publish seam runs", () => {
  const liveEvents = new SessionLiveEventBus();
  const streams = new InMemoryDurableStreamStore();
  const streamId = sessionEventsStreamId("bus-split-session");
  streams.ensureStream(streamId);
  const seenKinds: string[] = [];
  const unsubscribe = liveEvents.subscribe(streamId, (event) => {
    seenKinds.push(event.kind);
  });

  const retainedEvent = streams.append(streamId, {
    sessionId: "bus-split-session",
    kind: "session_state_patch",
    sessionVersion: "1",
    payload: {
      commandId: "cmd-1",
      sequence: 1,
      patch: { sessionName: "bus split" },
    },
    ts: 1,
  });

  expect(seenKinds).toEqual([]);

  appendAndPublish(streams, liveEvents, streamId, {
    sessionId: "bus-split-session",
    kind: "session_state_patch",
    sessionVersion: "2",
    payload: {
      commandId: "cmd-2",
      sequence: 2,
      patch: { sessionName: "published" },
    },
    ts: 2,
  });

  expect(seenKinds).toEqual(["session_state_patch"]);
  expect(retainedEvent.streamOffset).toBe("0000000000000000_0000000000000001");
  unsubscribe();
});

timedTest("session sync bounds pre-snapshot custom event buffering", async () => {
  const bufferedPatchEvents: SessionSyncEvent[] = [];
  const bufferedPatchEventIndexesByKey = new Map<string, number>();

  for (let index = 0; index < 200; index += 1) {
    bufferPatchEvent(bufferedPatchEvents, bufferedPatchEventIndexesByKey, {
      type: "patch",
      sessionId: "buffer-session",
      version: "0",
      patch: {
        patchType: "extension.custom",
        payload: {
          channel: `demo:${index}`,
          data: { value: index },
        },
      },
    });
  }

  expect(bufferedPatchEvents).toHaveLength(128);
  expect(
    bufferedPatchEvents.every(
      (event) => event.type === "patch" && !isPatchCoveredBySnapshot(event, buildEmptySnapshot()),
    ),
  ).toBe(true);
  expect(JSON.stringify(bufferedPatchEvents)).not.toContain('"channel":"demo:0"');
  expect(JSON.stringify(bufferedPatchEvents)).toContain('"channel":"demo:199"');
});

timedTest("session sync bounds 100k assistant message updates to one buffered patch", () => {
  const bufferedPatchEvents: SessionSyncEvent[] = [];
  const bufferedPatchEventIndexesByKey = new Map<string, number>();

  for (let index = 0; index < 100_000; index += 1) {
    bufferPatchEvent(bufferedPatchEvents, bufferedPatchEventIndexesByKey, {
      type: "patch",
      sessionId: "buffer-session",
      version: "0",
      patch: {
        patchType: "assistant.message",
        payload: {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: String(index),
            partial: {
              role: "assistant",
              content: [{ type: "text", text: String(index) }],
              api: "responses",
              provider: "demo",
              model: "demo",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "toolUse",
              timestamp: index,
            },
          },
        },
      },
    });
  }

  expect(bufferedPatchEvents).toHaveLength(1);
  expect(bufferedPatchEvents[0]).toMatchObject({
    type: "patch",
    patch: {
      patchType: "assistant.message",
      payload: {
        assistantMessageEvent: {
          type: "text_delta",
          delta: "99999",
        },
      },
    },
  });
});

timedTest("session sync bounds 100k tool execution updates to one buffered patch per tool", () => {
  const bufferedPatchEvents: SessionSyncEvent[] = [];
  const bufferedPatchEventIndexesByKey = new Map<string, number>();

  for (let index = 0; index < 100_000; index += 1) {
    bufferPatchEvent(bufferedPatchEvents, bufferedPatchEventIndexesByKey, {
      type: "patch",
      sessionId: "buffer-session",
      version: "0",
      patch: {
        patchType: "tool.execution",
        payload: {
          type: "tool_execution_update",
          toolCallId: "tool-1",
          partialResult: { line: index },
        },
      },
    });
  }

  expect(bufferedPatchEvents).toHaveLength(1);
  expect(bufferedPatchEvents[0]).toMatchObject({
    type: "patch",
    patch: {
      patchType: "tool.execution",
      payload: {
        type: "tool_execution_update",
        toolCallId: "tool-1",
        partialResult: { line: 99999 },
      },
    },
  });
});

timedTest("session sync coalesces mixed tool patch forms by toolCallId", () => {
  const bufferedPatchEvents: SessionSyncEvent[] = [];
  const bufferedPatchEventIndexesByKey = new Map<string, number>();

  bufferPatchEvent(bufferedPatchEvents, bufferedPatchEventIndexesByKey, {
    type: "patch",
    sessionId: "buffer-session",
    version: "1",
    patch: {
      patchType: "tool.execution",
      payload: {
        type: "tool_execution_update",
        toolCallId: "tool-1",
        partialResult: { line: 1 },
      },
    },
  });
  bufferPatchEvent(bufferedPatchEvents, bufferedPatchEventIndexesByKey, {
    type: "patch",
    sessionId: "buffer-session",
    version: "2",
    patch: {
      patchType: "tool.execution",
      payload: {
        type: "tool_execution_output_delta",
        toolCallId: "tool-1",
        start: 0,
        delta: "hi",
      },
    },
  });
  bufferPatchEvent(bufferedPatchEvents, bufferedPatchEventIndexesByKey, {
    type: "patch",
    sessionId: "buffer-session",
    version: "3",
    patch: {
      patchType: "tool.execution",
      payload: {
        type: "tool_execution_partial_patch",
        toolCallId: "tool-1",
        ops: [{ op: "replace", path: ["details", "truncation"], value: "tail" }],
      },
    },
  });

  expect(bufferedPatchEvents).toHaveLength(1);
  expect(bufferedPatchEvents[0]).toMatchObject({
    type: "patch",
    version: "3",
    patch: {
      patchType: "tool.execution",
      payload: { type: "tool_execution_partial_patch", toolCallId: "tool-1" },
    },
  });
});

timedTest("session sync live bus keeps bounded mixed tool patch buffer at 100k events", () => {
  const liveEvents = new SessionLiveEventBus();
  const bufferedPatchEvents: SessionSyncEvent[] = [];
  const bufferedPatchEventIndexesByKey = new Map<string, number>();
  const unsubscribe = liveEvents.subscribeSessionSyncEvent("buffer-session", (event) => {
    bufferPatchEvent(bufferedPatchEvents, bufferedPatchEventIndexesByKey, event);
  });

  try {
    for (let index = 0; index < 100_000; index += 1) {
      liveEvents.publishSessionSyncEvent("buffer-session", {
        type: "patch",
        sessionId: "buffer-session",
        version: String(index + 1),
        patch: {
          patchType: "tool.execution",
          payload: {
            type: index % 2 === 0 ? "tool_execution_update" : "tool_execution_partial_patch",
            toolCallId: "tool-1",
            ...(index % 2 === 0
              ? { partialResult: { line: index } }
              : { ops: [{ op: "replace", path: ["line"], value: index }] }),
          },
        },
      });
    }

    expect(bufferedPatchEvents).toHaveLength(1);
    expect(bufferedPatchEvents[0]).toMatchObject({
      type: "patch",
      version: "100000",
      patch: {
        patchType: "tool.execution",
        payload: { toolCallId: "tool-1" },
      },
    });
    expect(JSON.stringify(bufferedPatchEvents).length).toBeLessThan(512);
  } finally {
    unsubscribe();
  }
});

timedTest("snapshot suppresses buffered tool partial patch when snapshot already covers it", () => {
  const patchEvent: SessionSyncEvent = {
    type: "patch",
    sessionId: "session-1",
    version: "3",
    patch: {
      patchType: "tool.execution",
      payload: {
        type: "tool_execution_partial_patch",
        toolCallId: "tool-1",
        ops: [{ op: "replace", path: ["details", "truncation"], value: "tail" }],
      },
    },
  };

  const snapshot = {
    ...buildEmptySnapshot(),
    version: "3",
    pendingToolCalls: ["tool-1"],
    live: {
      ...buildEmptySnapshot().live,
      activeToolExecutions: [
        {
          toolCallId: "tool-1",
          toolName: "bash",
          args: { command: "echo hi" },
          partialResult: {
            content: [{ type: "text", text: "hi" }],
            details: { truncation: "tail", fullOutputPath: null },
          },
        },
      ],
    },
  } as SessionSnapshot;

  expect(isPatchCoveredBySnapshot(patchEvent, snapshot)).toBe(true);
});

timedTest("runtime durable sync patches use post-change durable version", async () => {
  const liveEvents = new SessionLiveEventBus();
  const streams = new InMemoryDurableStreamStore({ liveEventBus: liveEvents });
  const runtime = {
    cwd: "/tmp/runtime-version",
    dispose: async () => {},
  } as never;
  const record = createSessionRecord({
    sessionId: "runtime-version-session",
    persistence: "ephemeral",
    cwd: "/tmp/runtime-version",
    createdAt: 1,
    runtime,
    readRuntimeExtensionMetadata: () => [],
  });
  const sessions = new Map([[record.sessionId, record]]);
  const observedEvents: Array<{ kind: string; type?: string; sessionVersion?: string }> = [];
  const unsubscribe = liveEvents.subscribe(sessionEventsStreamId(record.sessionId), (event) => {
    observedEvents.push({
      kind: event.kind,
      type:
        "payload" in event &&
        event.payload !== null &&
        typeof event.payload === "object" &&
        "type" in event.payload
          ? typeof event.payload.type === "string"
            ? event.payload.type
            : undefined
          : undefined,
      sessionVersion: event.sessionVersion,
    });
  });

  try {
    handleRegistrySessionEvent({
      sessionId: record.sessionId,
      event: {
        type: "queue_update",
        steering: ["queued-steer"],
        followUp: [],
      },
      sessions,
      streams,
      liveEvents,
      now: 10,
      createRunId: () => "run-1",
      syncFromRuntime: (targetRecord) => {
        targetRecord.queue.depth = 1;
      },
      emitSessionSummaryUpdated: () => {},
    });

    handleRegistrySessionEvent({
      sessionId: record.sessionId,
      event: {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 100,
        errorMessage: "retry",
      },
      sessions,
      streams,
      liveEvents,
      now: 11,
      createRunId: () => "run-1",
      syncFromRuntime: (targetRecord) => {
        targetRecord.retry.status = "running";
      },
      emitSessionSummaryUpdated: () => {},
    });

    expect(
      observedEvents.find(
        (event) => event.kind === "agent_session_event" && event.type === "queue_update",
      )?.sessionVersion,
    ).toBe("1");
    expect(
      observedEvents.find(
        (event) => event.kind === "agent_session_event" && event.type === "auto_retry_start",
      )?.sessionVersion,
    ).toBe("2");
    expect(record.lastDurableSessionVersion).toBe(2);
  } finally {
    unsubscribe();
  }
});

timedTest("live-only sync patches do not advance durable version", () => {
  const liveEvents = new SessionLiveEventBus();
  const streams = new InMemoryDurableStreamStore({ liveEventBus: liveEvents });
  const runtime = {
    cwd: "/tmp/runtime-live-version",
    dispose: async () => {},
  } as never;
  const record = createSessionRecord({
    sessionId: "runtime-live-version-session",
    persistence: "ephemeral",
    cwd: "/tmp/runtime-live-version",
    createdAt: 1,
    runtime,
    readRuntimeExtensionMetadata: () => [],
  });
  const sessions = new Map([[record.sessionId, record]]);
  const observedVersions: string[] = [];
  const unsubscribe = liveEvents.subscribe(sessionEventsStreamId(record.sessionId), (event) => {
    if (event.kind === "assistant_message_patch") {
      observedVersions.push(event.sessionVersion ?? "missing");
    }
  });

  try {
    handleRegistrySessionEvent({
      sessionId: record.sessionId,
      event: {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "partial" }],
          api: "responses",
          provider: "demo",
          model: "demo",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 1,
        },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "partial",
          partial: {
            role: "assistant",
            content: [{ type: "text", text: "partial" }],
            api: "responses",
            provider: "demo",
            model: "demo",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 1,
          },
        },
      },
      sessions,
      streams,
      liveEvents,
      now: 10,
      createRunId: () => "run-1",
      syncFromRuntime: () => {},
      emitSessionSummaryUpdated: () => {},
    });

    expect(observedVersions).toEqual(["0"]);
    expect(record.lastDurableSessionVersion).toBe(0);
  } finally {
    unsubscribe();
  }
});

timedTest("session sync agent_session_event patches keep durable version semantics", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const rootDir = await mkdtemp(join(tmpdir(), "pi-remote-sync-version-"));
  const liveEvents = new SessionLiveEventBus();
  const streams = new InMemoryDurableStreamStore({ liveEventBus: liveEvents });
  const sessions = new SessionRegistry({
    streams,
    liveEvents,
    runtimeFactory: new FakeRuntimeFactory(),
    catalog: new SessionCatalog({ rootDir }),
  });
  const originalLoadSessionSnapshot = sessions.loadSessionSnapshot.bind(sessions);
  let releaseSnapshotLoad: (() => void) | undefined;
  const snapshotLoadGate = new Promise<void>((resolve) => {
    releaseSnapshotLoad = resolve;
  });
  sessions.loadSessionSnapshot = async (...args) => {
    await snapshotLoadGate;
    return originalLoadSessionSnapshot(...args);
  };

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
      liveEvents,
    }),
  );

  try {
    const token = await authenticate(app, privateKeyPem);
    const createResponse = await app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    const syncResponsePromise = app.request(`/v1/sessions/${created.sessionId}/sync`, {
      headers: { authorization: `Bearer ${token}` },
    });

    await waitForValue(
      () => releaseSnapshotLoad,
      (value) => value !== undefined,
    );

    appendAndPublish(streams, liveEvents, sessionEventsStreamId(created.sessionId), {
      sessionId: created.sessionId,
      kind: "agent_session_event",
      sessionVersion: "7",
      payload: {
        type: "queue_update",
        steering: ["queued"],
        followUp: [],
      },
    });

    releaseSnapshotLoad?.();

    const syncResponse = await syncResponsePromise;
    expect(syncResponse.status).toBe(200);

    const reader = syncResponse.body?.getReader();
    expect(reader).toBeTruthy();
    let payload = "";
    while (!payload.includes('"patchType":"queue.update"')) {
      const chunk = await reader!.read();
      if (chunk.done) {
        break;
      }
      payload += new TextDecoder().decode(chunk.value);
    }
    await reader?.cancel();

    expect(payload).toContain('"version":"7"');
    expect(payload).toContain('"patchType":"queue.update"');
  } finally {
    await sessions.dispose();
    await rm(rootDir, { recursive: true, force: true });
  }
});

timedTest(
  "session sync snapshot suppresses buffered durable tombstone when snapshot already reflects re-add",
  async () => {
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
    const rootDir = await mkdtemp(join(tmpdir(), "pi-remote-sync-durable-authority-"));
    const liveEvents = new SessionLiveEventBus();
    const streams = new InMemoryDurableStreamStore({ liveEventBus: liveEvents });
    const sessions = new SessionRegistry({
      streams,
      liveEvents,
      runtimeFactory: new InMemoryPiRuntimeFactory(),
      catalog: new SessionCatalog({ rootDir }),
    });
    const originalLoadSessionSnapshot = sessions.loadSessionSnapshot.bind(sessions);
    let releaseSnapshotLoad: (() => void) | undefined;
    const snapshotLoadGate = new Promise<void>((resolve) => {
      releaseSnapshotLoad = resolve;
    });
    sessions.loadSessionSnapshot = async (...args) => {
      await snapshotLoadGate;
      return originalLoadSessionSnapshot(...args);
    };

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
        liveEvents,
      }),
    );

    try {
      const token = await authenticate(app, privateKeyPem);
      const createResponse = await app.request("/v1/sessions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as { sessionId: string };

      const syncResponsePromise = app.request(`/v1/sessions/${created.sessionId}/sync`, {
        headers: { authorization: `Bearer ${token}` },
      });

      await waitForValue(
        () => releaseSnapshotLoad,
        (value) => value !== undefined,
      );

      await sessions.emitSessionExtensionCustomEvent(
        created.sessionId,
        {
          channel: "demo:durable",
          data: { sync: "durable", replaceKey: "slot", deleted: true },
        },
        testAuthSession(),
        "conn-a",
      );
      await sessions.emitSessionExtensionCustomEvent(
        created.sessionId,
        {
          channel: "demo:durable",
          data: { sync: "durable", replaceKey: "slot", value: 2 },
        },
        testAuthSession(),
        "conn-a",
      );

      releaseSnapshotLoad?.();

      const syncResponse = await syncResponsePromise;
      const events = await readSessionSyncEvents(syncResponse);
      const snapshotEvent = events.find((event) => event.type === "snapshot");
      const extensionPatchEvents = events.filter(
        (event) => event.type === "patch" && event.patch.patchType === "extension.custom",
      );

      expect(snapshotEvent).toBeDefined();
      expect(
        snapshotEvent?.type === "snapshot" && snapshotEvent.snapshot.durableExtensionState,
      ).toEqual([
        { channel: "demo:durable", data: { sync: "durable", replaceKey: "slot", value: 2 } },
      ]);
      expect(extensionPatchEvents).toEqual([]);
    } finally {
      await sessions.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  },
);

timedTest(
  "session sync reconnect restores active live overlay from snapshot over real sse",
  async () => {
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
    const rootDir = await mkdtemp(join(tmpdir(), "pi-remote-sync-live-overlay-"));
    const liveEvents = new SessionLiveEventBus();
    const streams = new InMemoryDurableStreamStore({ liveEventBus: liveEvents });
    const sessions = new SessionRegistry({
      streams,
      liveEvents,
      runtimeFactory: new InMemoryPiRuntimeFactory(),
      catalog: new SessionCatalog({ rootDir }),
    });
    const originalLoadSessionSnapshot = sessions.loadSessionSnapshot.bind(sessions);
    let releaseSnapshotLoad: (() => void) | undefined;
    const snapshotLoadGate = new Promise<void>((resolve) => {
      releaseSnapshotLoad = resolve;
    });
    sessions.loadSessionSnapshot = async (...args) => {
      await snapshotLoadGate;
      const snapshot = await originalLoadSessionSnapshot(...args);
      return {
        ...snapshot,
        version: "9",
        streamingState: "streaming",
        pendingToolCalls: ["tool-1"],
        retry: { status: "running" },
        live: {
          queuedSteeringMessages: ["steer now"],
          queuedFollowUpMessages: ["follow later"],
          retryAttempt: 2,
          streamingMessage: {
            role: "assistant",
            content: [{ type: "text", text: "partial answer" }],
            api: "remote",
            provider: "remote",
            model: "remote",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: Date.now(),
          },
          activeToolExecutions: [
            {
              toolCallId: "tool-1",
              toolName: "bash",
              args: { command: "echo hi" },
              partialResult: { output: "hi" },
            },
          ],
        },
      };
    };

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
        liveEvents,
      }),
    );

    let runtime: RemoteAgentSessionRuntime | undefined;
    try {
      const token = await authenticate(app, privateKeyPem);
      const createResponse = await app.request("/v1/sessions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as { sessionId: string };

      const runtimePromise = createRemoteRuntime(app, {
        privateKeyPem,
        sessionId: created.sessionId,
      });

      await waitForValue(
        () => releaseSnapshotLoad,
        (value) => value !== undefined,
      );

      appendAndPublish(streams, liveEvents, sessionEventsStreamId(created.sessionId), {
        sessionId: created.sessionId,
        kind: "assistant_message_patch",
        sessionVersion: "7",
        payload: {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "partial",
            partial: {
              role: "assistant",
              content: [{ type: "text", text: "partial" }],
              api: "remote",
              provider: "remote",
              model: "remote",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "toolUse",
              timestamp: 1,
            },
          },
        },
      });
      appendAndPublish(streams, liveEvents, sessionEventsStreamId(created.sessionId), {
        sessionId: created.sessionId,
        kind: "tool_execution_patch",
        sessionVersion: "8",
        payload: {
          type: "tool_execution_update",
          toolCallId: "tool-1",
          partialResult: { output: "newer" },
        },
      });

      releaseSnapshotLoad?.();
      runtime = await runtimePromise;

      await waitForValue(
        () => runtime?.session.retryAttempt,
        (retryAttempt) => retryAttempt === 2,
      );
      expect(runtime.session.isStreaming).toBe(true);
      expect([...runtime.session.state.pendingToolCalls]).toEqual(["tool-1"]);
      expect(runtime.session.retryAttempt).toBe(2);
      expect(runtime.session.getSteeringMessages()).toEqual(["steer now"]);
      expect(runtime.session.getFollowUpMessages()).toEqual(["follow later"]);
      expect(runtime.session.state.streamingMessage).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "partial answer" }],
      });
    } finally {
      await runtime?.dispose();
      await sessions.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  },
);

timedTest("extension custom event route rejects missing json payload data", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
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
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    const response = await remote.app.request(`/v1/sessions/${created.sessionId}/extension-event`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ channel: "demo:json-only" }),
    });

    expect(response.status).toBe(400);
  } finally {
    await remote.dispose();
  }
});

timedTest("durable runtime state rebuild marks interrupted domains on restart", () => {
  const sessionManager = SessionManager.inMemory(process.cwd());
  sessionManager.appendCustomEntry(REMOTE_RUNTIME_TRANSITION_ENTRY, {
    domain: "queue",
    op: "depth_delta",
    delta: 2,
    updatedAt: 1,
  });
  sessionManager.appendCustomEntry(REMOTE_RUNTIME_TRANSITION_ENTRY, {
    domain: "queue",
    op: "next_sequence_set",
    nextSequence: 7,
    updatedAt: 1,
  });
  sessionManager.appendCustomEntry(REMOTE_RUNTIME_TRANSITION_ENTRY, {
    domain: "retry",
    op: "status_set",
    status: "running",
    updatedAt: 1,
  });
  sessionManager.appendCustomEntry(REMOTE_RUNTIME_TRANSITION_ENTRY, {
    domain: "compaction",
    op: "status_set",
    status: "running",
    updatedAt: 1,
  });
  sessionManager.appendCustomEntry(REMOTE_RUNTIME_TRANSITION_ENTRY, {
    domain: "bash",
    op: "running_set",
    isRunning: true,
    updatedAt: 1,
  });
  sessionManager.appendCustomEntry(REMOTE_RUNTIME_TRANSITION_ENTRY, {
    domain: "bash",
    op: "pending_messages_set",
    hasPendingMessages: true,
    updatedAt: 1,
  });
  sessionManager.appendCustomEntry(REMOTE_RUNTIME_TRANSITION_ENTRY, {
    domain: "streaming",
    op: "status_set",
    status: "streaming",
    updatedAt: 1,
  });
  sessionManager.appendCustomEntry(REMOTE_SESSION_VERSION_ENTRY, {
    version: 42,
    updatedAt: 1,
  });

  const record = {
    runtime: {
      session: {
        sessionManager,
      },
    },
    queue: { depth: 0, nextSequence: 7 },
    retry: { status: "idle" },
    compaction: { status: "idle" },
    isBashRunning: false,
    hasPendingBashMessages: false,
    streamingState: "idle",
    interruptedRuntimeDomains: {
      queue: false,
      retry: false,
      compaction: false,
      bash: false,
      streaming: false,
    },
    activeRun: null,
  } as never;

  restoreDurableRuntimeDomainState(record, 10);

  expect(record.interruptedRuntimeDomains).toEqual({
    queue: true,
    retry: true,
    compaction: true,
    bash: true,
    streaming: true,
  });
  expect(record.queue.depth).toBe(0);
  expect(record.retry.status).toBe("interrupted");
  expect(record.compaction.status).toBe("interrupted");
  expect(record.streamingState).toBe("interrupted");
  expect(record.activeRun?.status).toBe("interrupted");
  expect(record.lastDurableSessionVersion).toBe(42);
});

timedTest("snapshot clears stale bash execution caches", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new FakeRuntimeFactory(),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
  try {
    runtime = await createRemoteRuntime(remote.app, { privateKeyPem, cwd: process.cwd() });
    const sessionAny = runtime.session as unknown as {
      activeBashExecutions: Map<string, unknown>;
      activeBashRequests: Map<string, unknown>;
      applySnapshot: (
        snapshot: Awaited<ReturnType<RemoteApiClient["getSessionSnapshot"]>>,
        options?: { resetTransientBashState?: boolean },
      ) => void;
      client: RemoteApiClient;
      sessionId: string;
    };

    sessionAny.activeBashExecutions.set("stale", { executionId: "stale" });
    sessionAny.activeBashRequests.set("stale", { onChunk: () => {} });
    const snapshot = await sessionAny.client.getSessionSnapshot(sessionAny.sessionId);
    sessionAny.applySnapshot(
      { ...snapshot, isBashRunning: false, hasPendingBashMessages: false },
      { resetTransientBashState: true },
    );

    expect(sessionAny.activeBashExecutions.size).toBe(0);
    expect(sessionAny.activeBashRequests.size).toBe(0);
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest(
  "sync from runtime preserves interrupted restart state until live activity resumes",
  () => {
    const record = {
      runtime: {
        session: {
          sessionManager: { getCwd: () => "/tmp" },
          resourceLoader: { getExtensions: () => ({ extensions: [] }) },
          model: { provider: "p", id: "m" },
          thinkingLevel: "medium",
          getActiveToolNames: () => [],
          autoCompactionEnabled: false,
          steeringMode: "all",
          followUpMode: "all",
          modelRegistry: { getAvailable: () => [] },
          settingsManager: {
            getDefaultProvider: () => null,
            getDefaultModel: () => null,
            getDefaultThinkingLevel: () => null,
            getEnabledModels: () => null,
          },
          messages: [],
          isStreaming: false,
          isBashRunning: false,
          hasPendingBashMessages: false,
          state: { pendingToolCalls: new Set(), errorMessage: null },
          isRetrying: false,
          isCompacting: false,
          pendingMessageCount: 0,
        },
      },
      interruptedRuntimeDomains: {
        queue: true,
        retry: true,
        compaction: true,
        bash: true,
        streaming: true,
      },
      queue: { depth: 0, nextSequence: 1 },
      retry: { status: "interrupted" },
      compaction: { status: "interrupted" },
      activeRun: {
        runId: "interrupted",
        status: "interrupted",
        triggeringCommandId: "server-recovery",
        startedAt: 1,
        updatedAt: 1,
        queueDepth: 0,
      },
      streamingState: "interrupted",
      isBashRunning: false,
      hasPendingBashMessages: false,
      pendingToolCalls: [],
      cwd: "",
      extensions: [],
      settings: {},
      availableModels: [],
      modelSettings: {
        defaultProvider: null,
        defaultModel: null,
        defaultThinkingLevel: null,
        enabledModels: null,
      },
      transcript: [],
      sessionStats: {
        sessionId: "s",
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      },
      contextUsage: undefined,
      usageCost: 0,
      autoCompactionEnabled: false,
      steeringMode: "all",
      followUpMode: "all",
      errorMessage: null,
      status: "idle",
    } as never;

    syncSessionRecordFromRuntime({
      record,
      now: () => 10,
      getRuntimeSession: (targetRecord) => targetRecord.runtime.session,
    });

    expect(record.interruptedRuntimeDomains).toEqual({
      queue: true,
      retry: true,
      compaction: true,
      bash: true,
      streaming: true,
    });
    expect(record.retry.status).toBe("interrupted");
    expect(record.compaction.status).toBe("interrupted");
    expect(record.streamingState).toBe("interrupted");
    expect(record.activeRun?.status).toBe("interrupted");
  },
);

timedTest("durable extension events persist to session history", () => {
  const sessionManager = SessionManager.inMemory(process.cwd());
  const record = {
    runtime: { session: { sessionManager } },
  } as never;

  appendDurableExtensionEvent({
    record,
    channel: "demo:durable",
    data: { sync: "durable", value: 1 },
    ts: 1,
  });

  expect(readDurableExtensionEvents(record)).toEqual([
    {
      op: "upsert",
      stateKey: "demo:durable",
      channel: "demo:durable",
      data: { sync: "durable", value: 1 },
      ts: 1,
    },
  ]);
});

timedTest("durable extension reducer removes stale state by key", () => {
  const sessionManager = SessionManager.inMemory(process.cwd());
  const record = {
    runtime: { session: { sessionManager } },
    lastDurableSessionVersion: 0,
  } as never;

  appendDurableExtensionEvent({
    record,
    channel: "demo:durable",
    data: { sync: "durable", replaceKey: "slot", value: 1 },
    ts: 1,
  });
  appendDurableExtensionEvent({
    record,
    channel: "demo:durable",
    data: { sync: "durable", replaceKey: "slot", value: 2 },
    ts: 2,
  });
  appendDurableExtensionEvent({
    record,
    channel: "demo:durable",
    data: { sync: "durable", replaceKey: "slot", deleted: true },
    ts: 3,
  });

  expect(buildDurableExtensionState(record)).toEqual([]);
});

timedTest("snapshot replay emits removal for stale durable extension state", () => {
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const appliedSnapshotExtensionState = new Map<string, string>([
    [
      "demo:durable:slot",
      JSON.stringify({
        channel: "demo:durable",
        data: { sync: "durable", replaceKey: "slot", value: 1 },
      }),
    ],
  ]);

  replaySnapshotExtensionState({
    extensionState: [],
    appliedSnapshotExtensionState,
    emit: (channel, data) => {
      emitted.push({ channel, data });
    },
  });

  expect(emitted).toEqual([
    {
      channel: "demo:durable",
      data: createDurableExtensionRemovalEvent({
        channel: "demo:durable",
        replaceKey: "slot",
      }).data,
    },
  ]);
  expect(appliedSnapshotExtensionState.size).toBe(0);
});

timedTest("command acceptance persists queue state after onAccepted mutation", async () => {
  const sessionManager = SessionManager.inMemory(process.cwd());
  const entriesBefore = sessionManager.getEntries().length;
  const record = {
    sessionId: "session-1",
    queue: { depth: 0, nextSequence: 1 },
    updatedAt: 0,
    lastDurableSessionVersion: 0,
    commandAcceptanceQueue: Promise.resolve(),
    runtime: { session: { sessionManager } },
    retry: { status: "idle" },
    compaction: { status: "idle" },
    isBashRunning: false,
    hasPendingBashMessages: false,
    streamingState: "idle",
  } as never;

  await acceptSessionCommand({
    record,
    client: { clientId: "client-1" } as never,
    kind: "prompt",
    payload: { text: "hi" },
    hooksOrOnAccepted: {
      onAccepted: () => {
        record.queue.depth = 1;
      },
    },
    createCommandId: () => "cmd-1",
    now: () => 1,
    touchPresence: () => {},
    appendCommandAccepted: () => {},
    syncFromRuntime: () => {},
  });

  const entriesAfter = sessionManager.getEntries().slice(entriesBefore);
  expect(
    entriesAfter.some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === REMOTE_RUNTIME_TRANSITION_ENTRY &&
        typeof entry.data === "object" &&
        entry.data !== null &&
        !Array.isArray(entry.data) &&
        entry.data.domain === "queue" &&
        entry.data.op === "depth_delta" &&
        entry.data.delta === 1,
    ),
  ).toBe(true);
});

timedTest("seeded head offset resumes persisted session version", () => {
  const streams = new InMemoryDurableStreamStore();
  const streamId = "sessions/persisted/events";
  streams.ensureStream(streamId);
  streams.seedHeadOffset(streamId, 42);

  const event = streams.append(streamId, {
    sessionId: "persisted",
    kind: "server_notice",
    payload: { message: "resume" },
  });

  expect(event.streamOffset).toBe("0000000000000000_0000000000000043");
  expect(streams.getHeadOffset(streamId)).toBe("0000000000000000_0000000000000043");
});

timedTest("stream endpoints accept durable protocol sentinel offsets", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

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
    expect(createResponse.status).toBe(201);

    const fromStart = await remote.app.request("/v1/streams/app-events?offset=-1", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(fromStart.status).toBe(404);

    const fromNow = await remote.app.request("/v1/streams/app-events?offset=now", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(fromNow.status).toBe(404);
  } finally {
    await remote.dispose();
  }
});

timedTest("live stream modes require offset", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

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
    expect(appSse.status).toBe(404);

    const sessionLongPoll = await remote.app.request(
      `/v1/streams/sessions/${created.sessionId}/events?live=long-poll`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(sessionLongPoll.status).toBe(404);
  } finally {
    await remote.dispose();
  }
});

timedTest("long-poll timeout returns 204 with stream headers", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

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

    expect(longPoll.status).toBe(404);
  } finally {
    await remote.dispose();
  }
});

timedTest("long-poll with offset=now returns newly appended events", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

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
    expect(createResponse.status).toBe(201);

    const longPoll = await longPollPromise;
    expect(longPoll.status).toBe(404);
  } finally {
    await remote.dispose();
  }
});

timedTest("sse uses data and control events", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

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
    expect(createResponse.status).toBe(201);

    const sse = await remote.app.request(
      "/v1/streams/app-events?live=sse&offset=0000000000000000_0000000000000000",
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );

    expect(sse.status).toBe(404);
  } finally {
    await remote.dispose();
  }
});

timedTest("auth service prunes expired and consumed records", () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

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

  expect((auth as any).challenges.size).toBe(0);
  expect((auth as any).tokens.size).toBe(1);

  now = 100;
  auth.createChallenge("dev");
  expect((auth as any).tokens.size).toBe(0);
  expect((auth as any).challenges.size).toBe(1);
});

timedTest("auth service rejects non-ed25519 public keys", () => {
  const rsaPublicKeyPem = TEST_RSA_PUBLIC_KEY_PEM;

  expect(
    () =>
      new AuthService({
        origin: "http://localhost:3000",
        allowedKeys: [{ keyId: "rsa", publicKey: rsaPublicKeyPem }],
      }),
  ).toThrow(/ed25519/);

  const ed25519PublicKeyPem = TEST_ED25519_KEYS.publicKeyPem;

  const auth = new AuthService({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "ed", publicKey: ed25519PublicKeyPem }],
  });
  const challenge = auth.createChallenge("ed");
  expect(challenge.algorithm).toBe("ed25519");
});

timedTest("session creation remains stable under concurrent requests", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

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
    expect(statuses).toEqual([201, 201]);
    expect(runtimeFactory.createCalls).toBe(2);

    const snapshotResponse = await remote.app.request("/v1/app/snapshot", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as {
      sessionSummaries: Array<{ sessionId: string }>;
    };
    expect(snapshot.sessionSummaries.length).toBe(2);
  } finally {
    await remote.dispose();
  }
});

timedTest("presence tracks concurrent tokens independently", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

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

    expect(snapshotB.status).toBe(200);
    const snapshot = (await snapshotB.json()) as {
      presence: Array<{ clientId: string; connectionId: string }>;
    };
    expect(snapshot.presence.length).toBe(2);
    expect(snapshot.presence[0]?.clientId).toBe("dev");
    expect(snapshot.presence[1]?.clientId).toBe("dev");
    expect(snapshot.presence[0]?.connectionId).not.toBe(snapshot.presence[1]?.connectionId);
  } finally {
    await remote.dispose();
  }
});

timedTest("connection capabilities endpoint stores flags and snapshots expose them", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

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

    expect(capabilitiesResponse.status).toBe(200);

    const createResponse = await remote.app.request("/v1/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-pi-connection-id": "conn-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(createResponse.status).toBe(201);
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
    expect(snapshotResponse.status).toBe(200);

    const snapshot = (await snapshotResponse.json()) as {
      presence: Array<{
        connectionId: string;
        clientCapabilities?: {
          protocolVersion: string;
          primitives: { custom: boolean; setHeader: boolean; setFooter: boolean };
        };
      }>;
    };

    expect(snapshot.presence[0]?.connectionId).toBe("conn-a");
    expect(snapshot.presence[0]?.clientCapabilities?.protocolVersion).toBe("1.0");
    expect(snapshot.presence[0]?.clientCapabilities?.primitives.custom).toBe(false);
    expect(snapshot.presence[0]?.clientCapabilities?.primitives.setHeader).toBe(false);
    expect(snapshot.presence[0]?.clientCapabilities?.primitives.setFooter).toBe(false);
  } finally {
    await remote.dispose();
  }
});

timedTest(
  "connection capabilities are isolated per authenticated client for shared connection ids",
  async () => {
    const publicKeyPemA = TEST_ED25519_KEYS.publicKeyPem;
    const privateKeyPemA = TEST_ED25519_KEYS.privateKeyPem;
    const publicKeyPemB = TEST_ED25519_KEYS.publicKeyPem;
    const privateKeyPemB = TEST_ED25519_KEYS.privateKeyPem;

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
      expect(capabilitiesA.status).toBe(200);

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
      expect(capabilitiesB.status).toBe(200);

      const createResponse = await remote.app.request("/v1/sessions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenA}`,
          "x-pi-connection-id": "conn-shared",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as { sessionId: string };

      const snapshotA = await remote.app.request(`/v1/sessions/${created.sessionId}/snapshot`, {
        headers: {
          authorization: `Bearer ${tokenA}`,
          "x-pi-connection-id": "conn-shared",
        },
      });
      expect(snapshotA.status).toBe(200);
      const bodyA = (await snapshotA.json()) as {
        presence: Array<{
          connectionId: string;
          clientCapabilities?: { primitives: { custom: boolean; setHeader: boolean } };
        }>;
      };
      expect(bodyA.presence[0]?.connectionId).toBe("conn-shared");
      expect(bodyA.presence[0]?.clientCapabilities?.primitives.custom).toBe(false);
      expect(bodyA.presence[0]?.clientCapabilities?.primitives.setHeader).toBe(false);

      const snapshotB = await remote.app.request(`/v1/sessions/${created.sessionId}/snapshot`, {
        headers: {
          authorization: `Bearer ${tokenB}`,
          "x-pi-connection-id": "conn-shared",
        },
      });
      expect(snapshotB.status).toBe(200);
      const bodyB = (await snapshotB.json()) as {
        presence: Array<{
          connectionId: string;
          clientCapabilities?: { primitives: { custom: boolean; setHeader: boolean } };
        }>;
      };
      expect(bodyB.presence[0]?.connectionId).toBe("conn-shared");
      expect(bodyB.presence[0]?.clientCapabilities?.primitives.custom).toBe(true);
      expect(bodyB.presence[0]?.clientCapabilities?.primitives.setHeader).toBe(true);
    } finally {
      await remote.dispose();
    }
  },
);

timedTest("remote kv store backend is pluggable", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
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

    expect(read.found).toBe(true);
    expect(read.value).toEqual({ active: true });
    expect(read.updatedAt).toBe(1_700_000_000_000);
  } finally {
    await remote.dispose();
  }
});

timedTest("default json-file kv backend persists global and user namespaces", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
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

      expect(typeof globalWrite.updatedAt).toBe("number");
      expect(typeof userWrite.updatedAt).toBe("number");
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

      expect(globalRead.found).toBe(true);
      expect(globalRead.value).toBe("host");
      expect(userRead.found).toBe(true);
      expect(userRead.value).toBe("cliproxy:work");
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
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
    const originalCwd = process.cwd();
    const harness = await createTempPersistedRuntimeHarness({
      prefix: "pi-remote-session-catalog-",
    });

    try {
      const remoteA = createRemoteApp({
        origin: "http://localhost:3000",
        allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
        runtimeFactory: harness.runtimeFactory,
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

        expect(createResponse.status).toBe(201);
        const created = (await createResponse.json()) as { sessionId: string };
        createdSessionId = created.sessionId;

        const apiClient = new RemoteApiClient({
          origin: "http://localhost:3000",
          auth: {
            keyId: "dev",
            privateKey: privateKeyPem,
          },
          fetchImpl: createInProcessFetch(remoteA.app),
        });
        await apiClient.authenticate();

        const promptResponse = await remoteA.app.request(
          `/v1/sessions/${createdSessionId}/prompt`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ text: "Persist catalog session" }),
          },
        );
        expect(promptResponse.status).toBe(202);
        await waitForRemoteSessionMessageCount(apiClient, createdSessionId, 2);

        const summaryResponse = await remoteA.app.request(
          `/v1/sessions/${createdSessionId}/summary`,
          {
            headers: { authorization: `Bearer ${token}` },
          },
        );
        expect(summaryResponse.status).toBe(200);
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
        expect(summary.sessionId).toBe(createdSessionId);
        expect(summary.sessionName).toBe("Persistent Catalog Session");
        expect(summary.cwd).toBe(harness.workspaceDir);
        expect(summary.parentSessionId).toBe(null);
        expect(summary.lifecycle.persistence).toBe("persistent");
        expect(summary.lifecycle.loaded).toBe(true);
        expect(summary.lifecycle.state).toBe("active");
      } finally {
        await remoteA.dispose();
      }

      const remoteB = createRemoteApp({
        origin: "http://localhost:3000",
        allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
        runtimeFactory: harness.runtimeFactory,
      });

      try {
        const token = await authenticate(remoteB.app, privateKeyPem);

        const snapshotResponse = await remoteB.app.request("/v1/app/snapshot", {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(snapshotResponse.status).toBe(200);
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

        expect(snapshot.defaultAttachSessionId).toBe(undefined);
        expect(snapshot.sessionSummaries.length).toBe(1);
        expect(snapshot.sessionSummaries[0]?.sessionId).toBe(createdSessionId);
        expect(snapshot.sessionSummaries[0]?.sessionName).toBe("Persistent Catalog Session");
        expect(snapshot.sessionSummaries[0]?.messageCount).toBe(2);
        expect(snapshot.sessionSummaries[0]?.cwd).toBe(harness.workspaceDir);
        expect(snapshot.sessionSummaries[0]?.parentSessionId).toBe(null);
        expect(snapshot.sessionSummaries[0]?.lifecycle.persistence).toBe("persistent");
        expect(snapshot.sessionSummaries[0]?.lifecycle.loaded).toBe(false);
        expect(snapshot.sessionSummaries[0]?.lifecycle.state).toBe("active");

        const summaryResponse = await remoteB.app.request(
          `/v1/sessions/${createdSessionId}/summary`,
          {
            headers: { authorization: `Bearer ${token}` },
          },
        );
        expect(summaryResponse.status).toBe(200);
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
        expect(summary.sessionId).toBe(createdSessionId);
        expect(summary.sessionName).toBe("Persistent Catalog Session");
        expect(summary.cwd).toBe(harness.workspaceDir);
        expect(summary.parentSessionId).toBe(null);
        expect(summary.lifecycle.persistence).toBe("persistent");
        expect(summary.lifecycle.loaded).toBe(false);
        expect(summary.lifecycle.state).toBe("active");
        expect("sessionFile" in summary).toBe(false);
      } finally {
        await remoteB.dispose();
      }
    } finally {
      process.chdir(originalCwd);
      await harness.cleanup();
    }
  },
);

timedTest("persistent remote session lazily loads runtime on attach after restart", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const originalCwd = process.cwd();
  const harness = await createTempPersistedRuntimeHarness({
    prefix: "pi-remote-lazy-attach-",
  });

  try {
    const runtimeFactoryA = new CountingRuntimeFactory(harness.runtimeFactory);
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

      expect(createResponse.status).toBe(201);
      createdSessionId = ((await createResponse.json()) as { sessionId: string }).sessionId;
      const apiClient = new RemoteApiClient({
        origin: "http://localhost:3000",
        auth: {
          keyId: "dev",
          privateKey: privateKeyPem,
        },
        fetchImpl: createInProcessFetch(remoteA.app),
      });
      await apiClient.authenticate();
      const promptResponse = await remoteA.app.request(`/v1/sessions/${createdSessionId}/prompt`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "Persist lazy attach session" }),
      });
      expect(promptResponse.status).toBe(202);
      await waitForRemoteSessionMessageCount(apiClient, createdSessionId, 2);
      expect(runtimeFactoryA.createCalls).toBe(1);
      expect(runtimeFactoryA.loadCalls).toBe(0);
    } finally {
      await remoteA.dispose();
    }

    const runtimeFactoryB = new CountingRuntimeFactory(harness.runtimeFactory);
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
      expect(appSnapshotResponse.status).toBe(200);
      const appSnapshot = (await appSnapshotResponse.json()) as {
        sessionSummaries: Array<{
          sessionId: string;
          cwd: string;
          lifecycle: { loaded: boolean };
        }>;
      };

      expect(appSnapshot.sessionSummaries[0]?.sessionId).toBe(createdSessionId);
      expect(appSnapshot.sessionSummaries[0]?.messageCount).toBe(2);
      expect(appSnapshot.sessionSummaries[0]?.cwd).toBe(harness.workspaceDir);
      expect(appSnapshot.sessionSummaries[0]?.lifecycle.loaded).toBe(false);
      expect(runtimeFactoryB.createCalls).toBe(0);
      expect(runtimeFactoryB.loadCalls).toBe(0);

      const sessionSnapshotResponse = await remoteB.app.request(
        `/v1/sessions/${createdSessionId}/snapshot`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      expect(sessionSnapshotResponse.status).toBe(200);
      const sessionSnapshot = (await sessionSnapshotResponse.json()) as {
        sessionId: string;
        cwd: string;
      };

      expect(sessionSnapshot.sessionId).toBe(createdSessionId);
      expect(sessionSnapshot.cwd).toBe(harness.workspaceDir);
      expect(runtimeFactoryB.createCalls).toBe(0);
      expect(runtimeFactoryB.loadCalls).toBe(0);

      const summaryResponse = await remoteB.app.request(
        `/v1/sessions/${createdSessionId}/summary`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      expect(summaryResponse.status).toBe(200);
      const summary = (await summaryResponse.json()) as {
        lifecycle: { loaded: boolean };
      };

      expect(summary.lifecycle.loaded).toBe(false);

      const secondSnapshotResponse = await remoteB.app.request(
        `/v1/sessions/${createdSessionId}/snapshot`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      expect(secondSnapshotResponse.status).toBe(200);
      expect(runtimeFactoryB.loadCalls).toBe(0);
    } finally {
      await remoteB.dispose();
    }
  } finally {
    process.chdir(originalCwd);
    await harness.cleanup();
  }
});

timedTest("persistent remote session lazily loads runtime for commands after restart", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const originalCwd = process.cwd();
  const harness = await createTempPersistedRuntimeHarness({
    prefix: "pi-remote-lazy-command-",
  });

  try {
    const remoteA = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: harness.runtimeFactory,
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

      expect(createResponse.status).toBe(201);
      createdSessionId = ((await createResponse.json()) as { sessionId: string }).sessionId;

      const apiClient = new RemoteApiClient({
        origin: "http://localhost:3000",
        auth: {
          keyId: "dev",
          privateKey: privateKeyPem,
        },
        fetchImpl: createInProcessFetch(remoteA.app),
      });
      await apiClient.authenticate();
      const promptResponse = await remoteA.app.request(`/v1/sessions/${createdSessionId}/prompt`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "Persist lazy command session" }),
      });
      expect(promptResponse.status).toBe(202);
      await waitForRemoteSessionMessageCount(apiClient, createdSessionId, 2);
    } finally {
      await remoteA.dispose();
    }

    const runtimeFactoryB = new CountingRuntimeFactory(harness.runtimeFactory);
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
      expect(promptResponse.status).toBe(202);
      expect(runtimeFactoryB.createCalls).toBe(0);
      expect(runtimeFactoryB.loadCalls).toBe(1);

      const summaryResponse = await remoteB.app.request(
        `/v1/sessions/${createdSessionId}/summary`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      expect(summaryResponse.status).toBe(200);
      const summary = (await summaryResponse.json()) as {
        cwd: string;
        lifecycle: { loaded: boolean };
      };

      expect(summary.cwd).toBe(harness.workspaceDir);
      expect(summary.lifecycle.loaded).toBe(true);
    } finally {
      await remoteB.dispose();
    }
  } finally {
    process.chdir(originalCwd);
    await harness.cleanup();
  }
});

timedTest(
  "session snapshot caps loaded history to recent 200 entries and transcript messages",
  async () => {
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
    const session = new RecordingSession();
    session.messages = Array.from({ length: 250 }, (_, index) => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text: `message ${index + 1}` }],
    }));
    session.sessionStats.totalMessages = 250;
    session.sessionStats.assistantMessages = 250;

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
      expect(createResponse.status).toBe(201);
      const sessionId = ((await createResponse.json()) as { sessionId: string }).sessionId;

      const response = await remote.app.request(`/v1/sessions/${sessionId}/snapshot`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      const snapshot = (await response.json()) as {
        entries: Array<{ id: string; message?: { content?: Array<{ text?: string }> } }>;
        transcript: Array<{ role: string; content?: Array<{ text?: string }> }>;
        sessionStats: { totalMessages: number };
      };

      expect(snapshot.entries).toHaveLength(100);
      expect(snapshot.transcript).toHaveLength(100);
      expect(snapshot.entries[0]?.id).toBe("message-151");
      expect(snapshot.entries.at(-1)?.id).toBe("message-250");
      expect(snapshot.transcript[0]?.content?.[0]?.text).toBe("message 151");
      expect(snapshot.transcript.at(-1)?.content?.[0]?.text).toBe("message 250");
      expect(snapshot.sessionStats.totalMessages).toBe(250);
    } finally {
      await remote.dispose();
    }
  },
);

timedTest("session entries endpoint respects per-request entries limit and offset", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const session = new RecordingSession();
  session.messages = Array.from({ length: 20 }, (_, index) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text: `message ${index + 1}` }],
  }));
  session.sessionStats.totalMessages = 20;
  session.sessionStats.assistantMessages = 20;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
    sessionSnapshotEntriesLimit: 12,
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
    expect(createResponse.status).toBe(201);
    const sessionId = ((await createResponse.json()) as { sessionId: string }).sessionId;

    const response = await remote.app.request(
      `/v1/sessions/${sessionId}/entries?entriesLimit=5&entriesOffset=3`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as {
      entries: Array<{ id: string }>;
      transcript: Array<{ content?: Array<{ text?: string }> }>;
    };

    expect(snapshot.entries).toHaveLength(5);
    expect(snapshot.entries[0]?.id).toBe("message-13");
    expect(snapshot.entries.at(-1)?.id).toBe("message-17");
    expect(snapshot.transcript[0]?.content?.[0]?.text).toBe("message 13");
    expect(snapshot.transcript.at(-1)?.content?.[0]?.text).toBe("message 17");
  } finally {
    await remote.dispose();
  }
});

timedTest(
  "session entries endpoint returns same committed history loaded and unloaded",
  async () => {
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
    const root = await mkdtemp(join(tmpdir(), "pi-remote-entries-deterministic-"));
    const agentDir = join(root, "agent");
    const workspaceDir = join(root, "workspace");

    await mkdir(workspaceDir, { recursive: true });

    let sessionId = "";
    let loadedEntries: Awaited<ReturnType<RemoteApiClient["getSessionEntries"]>> | undefined;

    try {
      const runtimeFactoryA = InMemoryPiRuntimeFactory({
        cwd: workspaceDir,
        agentDir,
        persistSessions: true,
      });
      const remoteA = createRemoteApp({
        origin: "http://localhost:3000",
        allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
        runtimeFactory: runtimeFactoryA,
      });

      try {
        const token = await authenticate(remoteA.app, privateKeyPem);
        const createResponse = await remoteA.app.request("/v1/sessions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ sessionName: "Deterministic Entries" }),
        });
        expect(createResponse.status).toBe(201);
        sessionId = ((await createResponse.json()) as { sessionId: string }).sessionId;

        const apiClient = new RemoteApiClient({
          origin: "http://localhost:3000",
          auth: {
            keyId: "dev",
            privateKey: privateKeyPem,
          },
          fetchImpl: createInProcessFetch(remoteA.app),
        });
        await apiClient.authenticate();

        const promptResponse = await remoteA.app.request(`/v1/sessions/${sessionId}/prompt`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ text: "Persist deterministic history" }),
        });
        expect(promptResponse.status).toBe(202);
        await waitForRemoteSessionMessageCount(apiClient, sessionId, 2);

        loadedEntries = await apiClient.getSessionEntries(sessionId, { entriesLimit: 100 });
      } finally {
        await remoteA.dispose();
      }

      const runtimeFactoryB = InMemoryPiRuntimeFactory({
        cwd: workspaceDir,
        agentDir,
        persistSessions: true,
      });
      const remoteB = createRemoteApp({
        origin: "http://localhost:3000",
        allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
        runtimeFactory: runtimeFactoryB,
      });

      try {
        const apiClient = new RemoteApiClient({
          origin: "http://localhost:3000",
          auth: {
            keyId: "dev",
            privateKey: privateKeyPem,
          },
          fetchImpl: createInProcessFetch(remoteB.app),
        });
        await apiClient.authenticate();

        const unloadedEntries = await apiClient.getSessionEntries(sessionId, { entriesLimit: 100 });

        expect(loadedEntries).toBeDefined();
        expect(unloadedEntries).toEqual(loadedEntries);
        expect(unloadedEntries.entries.every((entry) => entry.type !== "session_info")).toBe(true);
      } finally {
        await remoteB.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

timedTest("second runtime attach to loaded session hydrates recent session tail", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const session = new RecordingSession();
  session.messages = Array.from({ length: 250 }, (_, index) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text: `message ${index + 1}` }],
  }));
  session.sessionStats.totalMessages = 250;
  session.sessionStats.assistantMessages = 250;

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
    const sessionId = ((await createResponse.json()) as { sessionId: string }).sessionId;

    runtime = await createRemoteRuntime(remote.app, {
      privateKeyPem,
      sessionId,
    });

    const entries = runtime.session.sessionManager.getEntries();
    expect(entries).toHaveLength(100);
    expect(entries[0]?.id).toBe("message-151");
    expect(entries.at(-1)?.id).toBe("message-250");
    expect(runtime.session.messages).toHaveLength(100);
    expect(runtime.session.messages[0]?.role).toBe("assistant");
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote runtime attach honors configured entries limit and offset", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const session = new RecordingSession();
  session.messages = Array.from({ length: 20 }, (_, index) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text: `message ${index + 1}` }],
  }));
  session.sessionStats.totalMessages = 20;
  session.sessionStats.assistantMessages = 20;

  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: new RecordingRuntimeFactory(session),
    sessionSnapshotEntriesLimit: 12,
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
    const sessionId = ((await createResponse.json()) as { sessionId: string }).sessionId;

    runtime = await RemoteAgentSessionRuntime.create({
      origin: "http://localhost:3000",
      auth: { keyId: "dev", privateKey: privateKeyPem },
      sessionId,
      sessionEntriesLimit: 4,
      sessionEntriesOffset: 2,
      clientCapabilities: REMOTE_DEFAULT_CLIENT_CAPABILITIES,
      workspaceCwd: process.cwd(),
      cwd: process.cwd(),
      fetchImpl: createInProcessFetch(remote.app),
    });

    const entries = runtime.session.sessionManager.getEntries();
    expect(entries).toHaveLength(4);
    expect(entries[0]?.id).toBe("message-15");
    expect(entries.at(-1)?.id).toBe("message-18");
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote startup selection without flags creates new session", () => {
  const workspaceCwd = "/home/coder/dotai/agent";
  const selection = resolveRemoteSessionId({
    snapshot: {
      serverInfo: { name: "pi-remote", version: "0.1.0", now: Date.now() },
      currentClientAuthInfo: {
        clientId: "dev",
        keyId: "dev",
        tokenExpiresAt: Date.now() + 60_000,
      },
      sessionSummaries: [
        {
          sessionId: "older-other",
          sessionName: undefined,
          firstUserMessage: undefined,
          messageCount: 0,
          status: "idle",
          cwd: "/tmp/other",
          createdAt: 1,
          updatedAt: 10,
          parentSessionId: null,
          lifecycle: { persistence: "persistent", loaded: false, state: "active" },
          lastSessionStreamOffset: "0000000000000000_0000000000000001",
        },
        {
          sessionId: "latest-workspace",
          sessionName: undefined,
          firstUserMessage: undefined,
          messageCount: 3,
          status: "idle",
          cwd: workspaceCwd,
          createdAt: 2,
          updatedAt: 20,
          parentSessionId: null,
          lifecycle: { persistence: "persistent", loaded: false, state: "active" },
          lastSessionStreamOffset: "0000000000000000_0000000000000002",
        },
      ],
      recentNotices: [],
      defaultAttachSessionId: undefined,
    },
    parsed: {
      remoteOrigin: "http://localhost:3000",
      keyId: "dev",
      privateKey: undefined,
      privateKeyPath: undefined,
      sessionId: undefined,
      resume: false,
      continueSession: false,
      forkSessionId: undefined,
      noSession: false,
      exportPath: undefined,
      sessionDir: undefined,
      sessionName: undefined,
      workspaceCwd,
      verbose: false,
      initialMessage: undefined,
      initialMessages: [],
    },
  });

  expect(selection).toEqual({ createNewSession: true });
});

timedTest("remote runtime create does not infer session name from cwd", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: InMemoryPiRuntimeFactory({ cwd: process.cwd() }),
  });

  try {
    const runtime = await RemoteAgentSessionRuntime.create({
      origin: "http://localhost:3000",
      auth: { keyId: "dev", privateKey: privateKeyPem },
      createNewSession: true,
      workspaceCwd: process.cwd(),
      cwd: process.cwd(),
      clientCapabilities: REMOTE_DEFAULT_CLIENT_CAPABILITIES,
      fetchImpl: createInProcessFetch(remote.app),
    });

    try {
      expect(runtime.session.sessionManager.getSessionName()).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  } finally {
    await remote.dispose();
  }
});

timedTest("remote runtime create does not treat client cwd as workspace cwd", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: InMemoryPiRuntimeFactory({ cwd: "/srv/server-workspace" }),
  });

  try {
    await expect(
      RemoteAgentSessionRuntime.create({
        origin: "http://localhost:3000",
        auth: { keyId: "dev", privateKey: privateKeyPem },
        createNewSession: true,
        cwd: "/tmp/local-client-cwd",
        clientCapabilities: REMOTE_DEFAULT_CLIENT_CAPABILITIES,
        fetchImpl: createInProcessFetch(remote.app),
      }),
    ).rejects.toThrow("Remote new session requires workspaceCwd");
  } finally {
    await remote.dispose();
  }
});

timedTest("remote runtime create uses explicit workspace cwd only", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
    runtimeFactory: InMemoryPiRuntimeFactory({ cwd: "/srv/server-default" }),
  });

  let runtime: RemoteAgentSessionRuntime | undefined;
  try {
    runtime = await RemoteAgentSessionRuntime.create({
      origin: "http://localhost:3000",
      auth: { keyId: "dev", privateKey: privateKeyPem },
      createNewSession: true,
      cwd: "/tmp/local-client-cwd",
      workspaceCwd: "/srv/explicit-workspace",
      clientCapabilities: REMOTE_DEFAULT_CLIENT_CAPABILITIES,
      fetchImpl: createInProcessFetch(remote.app),
    });

    expect(runtime.session.sessionManager.getCwd()).toBe("/srv/explicit-workspace");
  } finally {
    await runtime?.dispose();
    await remote.dispose();
  }
});

timedTest("remote runtime restart recovery reauths same unnamed persisted session", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
  const originalCwd = process.cwd();
  const harness = await createTempPersistedRuntimeHarness({
    prefix: "pi-remote-runtime-reconnect-",
  });

  try {
    const remoteA = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: harness.runtimeFactory,
    });

    let sessionId = "";

    try {
      const runtime = await createRemoteRuntime(remoteA.app, {
        privateKeyPem,
        cwd: harness.workspaceDir,
      });
      const apiClient = new RemoteApiClient({
        origin: "http://localhost:3000",
        auth: {
          keyId: "dev",
          privateKey: privateKeyPem,
        },
        fetchImpl: createInProcessFetch(remoteA.app),
      });
      await apiClient.authenticate();
      await runtime.session.prompt("Persist reconnect session");
      await waitForRemoteSessionMessageCount(
        apiClient,
        runtime.session.sessionManager.getSessionId(),
        2,
      );
      sessionId = runtime.session.sessionManager.getSessionId();
      expect(runtime.session.sessionManager.getSessionName()).toBeUndefined();
      await runtime.dispose();
    } finally {
      await remoteA.dispose();
    }

    const remoteB = createRemoteApp({
      origin: "http://localhost:3000",
      allowedKeys: [{ keyId: "dev", publicKey: publicKeyPem }],
      runtimeFactory: harness.runtimeFactory,
    });

    try {
      const runtime = await createRemoteRuntime(remoteB.app, {
        privateKeyPem,
        sessionId,
        cwd: harness.workspaceDir,
      });

      try {
        expect(runtime.session.sessionManager.getSessionId()).toBe(sessionId);
        expect(runtime.session.sessionManager.getSessionName()).toBeUndefined();

        await runtime.session.prompt("first message names later");

        await waitForValue(
          async () => runtime.session.messages.length,
          (messageCount) => messageCount > 0,
        );

        expect(runtime.session.sessionManager.getSessionId()).toBe(sessionId);
        expect(runtime.session.sessionManager.getSessionName()).toBeUndefined();
      } finally {
        await runtime.dispose();
      }
    } finally {
      await remoteB.dispose();
    }
  } finally {
    process.chdir(originalCwd);
    await harness.cleanup();
  }
});

timedTest("missing session summary returns 404", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;

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

    expect(response.status).toBe(404);
  } finally {
    await remote.dispose();
  }
});

test(
  "remote session archive restore and delete lifecycle works for loaded and unloaded sessions",
  { timeout: 180_000 },
  async () => {
    const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
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
        expect(createAResponse.status).toBe(201);
        const sessionAId = ((await createAResponse.json()) as { sessionId: string }).sessionId;

        const apiClient = new RemoteApiClient({
          origin: "http://localhost:3000",
          auth: {
            keyId: "dev",
            privateKey: privateKeyPem,
          },
          fetchImpl: createInProcessFetch(remote.app),
        });
        await apiClient.authenticate();
        const persistAResponse = await remote.app.request(`/v1/sessions/${sessionAId}/prompt`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ text: "Persist before archive" }),
        });
        expect(persistAResponse.status).toBe(202);
        await waitForRemoteSessionMessageCount(apiClient, sessionAId, 2);

        const archivedResponse = await remote.app.request(`/v1/sessions/${sessionAId}/archive`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(archivedResponse.status).toBe(200);
        const archivedSummary = (await archivedResponse.json()) as {
          lifecycle: { loaded: boolean; state: string };
        };
        expect(archivedSummary.lifecycle.loaded).toBe(false);
        expect(archivedSummary.lifecycle.state).toBe("archived");

        const archivedCatalog = new SessionCatalog({ rootDir: catalogRoot });
        const archivedRecord = archivedCatalog.get(sessionAId);
        expect(archivedRecord).toBeTruthy();
        expect(archivedRecord?.sessionPath ?? "").toMatch(/\.archive/);
        await expect(readFile(archivedRecord?.sessionPath ?? "")).resolves.toBeDefined();

        const restoredResponse = await remote.app.request(`/v1/sessions/${sessionAId}/restore`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(restoredResponse.status).toBe(200);
        const restoredSummary = (await restoredResponse.json()) as {
          lifecycle: { loaded: boolean; state: string };
        };
        expect(restoredSummary.lifecycle.loaded).toBe(false);
        expect(restoredSummary.lifecycle.state).toBe("active");

        const restoredCatalog = new SessionCatalog({ rootDir: catalogRoot });
        const restoredRecord = restoredCatalog.get(sessionAId);
        expect(restoredRecord).toBeTruthy();
        expect(restoredRecord?.sessionPath ?? "").not.toMatch(/\.archive/);

        const deleteUnloadedResponse = await remote.app.request(`/v1/sessions/${sessionAId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(deleteUnloadedResponse.status).toBe(200);
        expect(await deleteUnloadedResponse.json()).toEqual({
          sessionId: sessionAId,
          deleted: true,
        });

        const deletedSummaryResponse = await remote.app.request(
          `/v1/sessions/${sessionAId}/summary`,
          {
            headers: { authorization: `Bearer ${token}` },
          },
        );
        expect(deletedSummaryResponse.status).toBe(404);

        const createBResponse = await remote.app.request("/v1/sessions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ sessionName: "Delete Me Loaded" }),
        });
        expect(createBResponse.status).toBe(201);
        const sessionBId = ((await createBResponse.json()) as { sessionId: string }).sessionId;

        await waitForRemoteSessionIdle(apiClient, sessionBId);

        const deleteLoadedResponse = await remote.app.request(`/v1/sessions/${sessionBId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(deleteLoadedResponse.status).toBe(200);
        expect(await deleteLoadedResponse.json()).toEqual({
          sessionId: sessionBId,
          deleted: true,
        });

        const snapshotResponse = await remote.app.request("/v1/app/snapshot", {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(snapshotResponse.status).toBe(200);
        const snapshot = (await snapshotResponse.json()) as {
          sessionSummaries: Array<{ sessionId: string }>;
        };
        expect(snapshot.sessionSummaries).toEqual([]);

        const appEventsResponse = await remote.app.request("/v1/streams/app-events", {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(appEventsResponse.status).toBe(404);
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
    expect(() => new SessionCatalog({ rootDir: filePath })).toThrow(/ENOTDIR/);
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
    expect(catalog.get("child-session")?.parentSessionId).toBe("parent-session");

    const archived = catalog.archive("child-session");
    expect(archived.parentSessionId).toBe("parent-session");
    expect(archived.lifecycleStatus).toBe("archived");

    const restored = catalog.restore("child-session");
    expect(restored.parentSessionId).toBe("parent-session");
    expect(restored.lifecycleStatus).toBe("active");
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
    expect(record).toBeTruthy();
    expect(record?.lifecycleStatus).toBe("archived");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote app watcher reconciles external session add change and remove", async () => {
  const { publicKeyPem, privateKeyPem } = TEST_ED25519_KEYS;
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
      firstUserMessage: "Inspect external session summary",
    });

    const addedSnapshot = await waitForValue(
      async () => {
        const response = await remote.app.request("/v1/app/snapshot", {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(200);
        return (await response.json()) as {
          sessionSummaries: Array<{
            sessionId: string;
            sessionName: string;
            firstUserMessage?: string;
            messageCount: number;
            cwd: string;
          }>;
        };
      },
      (snapshot) =>
        snapshot.sessionSummaries.some((summary) => summary.sessionId === "external-session"),
    );

    expect(addedSnapshot.sessionSummaries[0]?.sessionName).toBe("External Session");
    expect(addedSnapshot.sessionSummaries[0]?.firstUserMessage).toBe(
      "Inspect external session summary",
    );
    expect(addedSnapshot.sessionSummaries[0]?.messageCount).toBe(1);
    expect(addedSnapshot.sessionSummaries[0]?.cwd).toBe("/srv/external");

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
        expect(response.status).toBe(200);
        return (await response.json()) as { sessionName: string; cwd: string };
      },
      (summary) =>
        summary.sessionName === "External Session Updated" &&
        summary.cwd === "/srv/external-updated",
    );

    expect(updatedSummary.sessionName).toBe("External Session Updated");
    expect(updatedSummary.cwd).toBe("/srv/external-updated");

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

    const finalSnapshot = await remote.app.request("/v1/app/snapshot", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(finalSnapshot.status).toBe(200);
    const finalBody = (await finalSnapshot.json()) as {
      sessionSummaries: Array<{ sessionId: string }>;
    };
    expect(finalBody.sessionSummaries).toEqual([]);
  } finally {
    await remote.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

timedTest("sanitizeSessionEntry omits non-json custom data", async () => {
  const entry = sanitizeSessionEntry({
    type: "custom",
    id: "custom-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "test",
    data: {
      ok: true,
      invalid: () => "nope",
    },
  });

  expect("data" in entry).toBe(false);
  expect(Value.Check(RemoteSessionEntrySchema, entry)).toBe(true);
});

timedTest("sanitizeSessionEntry preserves json-safe custom payloads", async () => {
  const customEntry = sanitizeSessionEntry({
    type: "custom",
    id: "custom-2",
    parentId: "parent-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "test",
    data: {
      nested: ["value", 1, true, null],
    },
  });
  const customMessageEntry = sanitizeSessionEntry({
    type: "custom_message",
    id: "custom-message-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "test",
    content: "hello",
    details: {
      invalid: () => "nope",
    },
    display: true,
  });

  expect(customEntry).toMatchObject({
    type: "custom",
    customType: "test",
    data: {
      nested: ["value", 1, true, null],
    },
  });
  expect("details" in customMessageEntry).toBe(false);
  expect(Value.Check(RemoteSessionEntrySchema, customEntry)).toBe(true);
  expect(Value.Check(RemoteSessionEntrySchema, customMessageEntry)).toBe(true);
});

timedTest("SettingsUpdateRequestTransportSchema enforces tuple payloads", async () => {
  expect(
    Value.Check(SettingsUpdateRequestTransportSchema, {
      method: "setDefaultModelAndProvider",
      args: ["model-only"],
    }),
  ).toBe(false);
  expect(
    Value.Check(SettingsUpdateRequestTransportSchema, {
      method: "setDefaultModelAndProvider",
      args: ["model", "provider"],
      requestId: "request-1",
    }),
  ).toBe(true);
});
