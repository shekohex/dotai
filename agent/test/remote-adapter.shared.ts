import { expect, test } from "vitest";
export { expect, test } from "vitest";
import { sign } from "node:crypto";
export { sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
export { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
export { tmpdir } from "node:os";
import { dirname, join } from "node:path";
export { dirname, join } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
export { SessionManager } from "@mariozechner/pi-coding-agent";
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
export type {
  ExtensionFactory,
  ExtensionUIContext,
  LoadExtensionsResult,
  PromptTemplate,
  ResourceLoader,
  Skill,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { AuthService, createChallengePayload } from "../src/remote/auth.ts";
export { AuthService, createChallengePayload } from "../src/remote/auth.ts";
import { createRemoteApp } from "../src/remote/app.ts";
export { createRemoteApp } from "../src/remote/app.ts";
import { REMOTE_DEFAULT_CLIENT_CAPABILITIES } from "../src/remote/capabilities.ts";
export { REMOTE_DEFAULT_CLIENT_CAPABILITIES } from "../src/remote/capabilities.ts";
import { SessionCatalogWatcher } from "../src/remote/session-catalog-watcher.ts";
export { SessionCatalogWatcher } from "../src/remote/session-catalog-watcher.ts";
import { cancelRemoteUiRequest, handleRemoteUiRequest } from "../src/remote/client/session-ui.ts";
export { cancelRemoteUiRequest, handleRemoteUiRequest } from "../src/remote/client/session-ui.ts";
import { InMemoryRemoteKvStore } from "../src/remote/kv/in-memory-store.ts";
export { InMemoryRemoteKvStore } from "../src/remote/kv/in-memory-store.ts";
import { RemoteApiClient } from "../src/remote/runtime-api/client.ts";
export { RemoteApiClient } from "../src/remote/runtime-api/client.ts";
import { toRemoteSessionInfo } from "../src/remote/client/session-picker.ts";
export { toRemoteSessionInfo } from "../src/remote/client/session-picker.ts";
import {
  hydrateExtensionStateFromKv,
  isKvManagedExtensionState,
  persistExtensionStateToKv,
  persistManagedExtensionState,
} from "../src/remote/client/session/extension-state-kv.ts";
export {
  hydrateExtensionStateFromKv,
  isKvManagedExtensionState,
  persistExtensionStateToKv,
  persistManagedExtensionState,
} from "../src/remote/client/session/extension-state-kv.ts";
import type { ExtensionStateKvClient } from "../src/remote/client/session/extension-state-kv.ts";
export type { ExtensionStateKvClient } from "../src/remote/client/session/extension-state-kv.ts";
import { hasSessionPrimitiveCapability } from "../src/remote/session/capabilities.ts";
export { hasSessionPrimitiveCapability } from "../src/remote/session/capabilities.ts";
import { touchSessionPresence } from "../src/remote/session/presence-ops.ts";
export { touchSessionPresence } from "../src/remote/session/presence-ops.ts";
import { createRemoteUiContext } from "../src/remote/session/ui-context.ts";
export { createRemoteUiContext } from "../src/remote/session/ui-context.ts";
import { InMemoryPiRuntimeFactory } from "../src/remote/runtime-factory.ts";
export { InMemoryPiRuntimeFactory } from "../src/remote/runtime-factory.ts";
import type { RemoteRuntimeFactory } from "../src/remote/runtime-factory.ts";
export type { RemoteRuntimeFactory } from "../src/remote/runtime-factory.ts";
import { createRemoteThemeFromContent } from "../src/remote/client/remote-theme.ts";
export { createRemoteThemeFromContent } from "../src/remote/client/remote-theme.ts";
import { RemoteAgentSessionRuntime, createInProcessFetch } from "../src/remote/client-runtime.ts";
export { RemoteAgentSessionRuntime, createInProcessFetch } from "../src/remote/client-runtime.ts";
import {
  createRemoteRenameSessionHandler,
  parseRemoteArgs,
  resolveRemoteSessionId,
  resolveRemoteStartupSelection,
} from "../src/remote/client-interactive.ts";
export {
  createRemoteRenameSessionHandler,
  parseRemoteArgs,
  resolveRemoteSessionId,
  resolveRemoteStartupSelection,
} from "../src/remote/client-interactive.ts";
import { loadThemeFromPath } from "../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
export { loadThemeFromPath } from "../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {
  createBashToolOverrideDefinition,
  createReadToolOverrideDefinition,
} from "../src/extensions/coreui/tools.ts";
export {
  createBashToolOverrideDefinition,
  createReadToolOverrideDefinition,
} from "../src/extensions/coreui/tools.ts";
import { calculateTotalCost } from "../src/extensions/coreui/usage.ts";
export { calculateTotalCost } from "../src/extensions/coreui/usage.ts";
import type { ClientCapabilities, Presence } from "../src/remote/schemas.ts";
export type { ClientCapabilities, Presence } from "../src/remote/schemas.ts";
import { SessionRegistry } from "../src/remote/session-registry.ts";
export { SessionRegistry } from "../src/remote/session-registry.ts";
import { SessionCatalog } from "../src/remote/session-catalog.ts";
export { SessionCatalog } from "../src/remote/session-catalog.ts";
import { InMemoryDurableStreamStore, sessionEventsStreamId } from "../src/remote/streams.ts";
export { InMemoryDurableStreamStore, sessionEventsStreamId } from "../src/remote/streams.ts";
import { assertType } from "../src/remote/typebox.ts";
export { assertType } from "../src/remote/typebox.ts";
import { TEST_ED25519_KEYS } from "./remote-test-keys.ts";
export { TEST_ED25519_KEYS } from "./remote-test-keys.ts";
process.env.PI_REMOTE_ENABLE_LOGGER = "0";

const TEST_FAKE_RUNTIME_CWD = "/tmp/pi-remote-fake-runtime";

export const TEST_TIMEOUT_MS = 15_000;

export const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

export class FakeRuntimeFactory implements RemoteRuntimeFactory {
  async create() {
    return {
      cwd: TEST_FAKE_RUNTIME_CWD,
      dispose: async () => {},
    } as any;
  }

  async dispose(): Promise<void> {}
}

export class SlowRuntimeFactory implements RemoteRuntimeFactory {
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

export class CountingRuntimeFactory implements RemoteRuntimeFactory {
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

export class RecordingSession {
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

export class RacyPromptSession extends RecordingSession {
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

export class BlockingPromptSession extends RecordingSession {
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

export class UiRequestPromptSession extends RecordingSession {
  uiAnswers: Array<string | undefined> = [];

  override async prompt(text: string, options?: Record<string, unknown>): Promise<void> {
    if (this.remoteUiContext?.input) {
      const answer = await this.remoteUiContext.input("Remote question", "type answer");
      this.uiAnswers.push(answer);
    }
    await super.prompt(text, options);
  }
}

export class RuntimeExtensionEventsPromptSession extends RecordingSession {
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

export class AgentLifecyclePromptSession extends RecordingSession {
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

export class PassiveExtensionEventsPromptSession extends RecordingSession {
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

export class UiPrimitivesPromptSession extends RecordingSession {
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

export function createRecordingResourceLoader(session: RecordingSession): ResourceLoader {
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

export function createRecordingExtensionRuntime(): LoadExtensionsResult["runtime"] {
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

export function buildRecordingExtension(
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

export function buildRecordingSkill(session: RecordingSession): Skill {
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

export function buildRecordingPrompt(session: RecordingSession): PromptTemplate {
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

export function buildRecordingTheme(session: RecordingSession): Theme {
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

export class RecordingRuntimeFactory implements RemoteRuntimeFactory {
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

export class NoLoadRecordingRuntimeFactory implements RemoteRuntimeFactory {
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

export class SequencedRecordingRuntimeFactory implements RemoteRuntimeFactory {
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

export class FailingDisposeRuntimeFactory implements RemoteRuntimeFactory {
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

export class ThrowingAppEventStreamStore extends InMemoryDurableStreamStore {
  override append(streamId: string, input: Parameters<InMemoryDurableStreamStore["append"]>[1]) {
    if (streamId === "app-events" && input.kind === "session_closed") {
      throw new Error("append failed");
    }
    return super.append(streamId, input);
  }
}

export function testAuthSession() {
  return {
    token: "token-dev",
    clientId: "dev",
    keyId: "dev",
    expiresAt: Date.now() + 60_000,
  };
}

export async function createRemoteRuntime(
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
  let sessionId = options.sessionId;

  if (sessionId === undefined && workspaceCwd === undefined) {
    const client = new RemoteApiClient({
      origin: "http://localhost:3000",
      auth: {
        keyId: "dev",
        privateKey: options.privateKeyPem,
      },
      fetchImpl: createInProcessFetch(app),
    });
    await client.authenticate();
    const snapshot = await client.getAppSnapshot();
    sessionId =
      snapshot.defaultAttachSessionId ??
      snapshot.sessionSummaries.toSorted((left, right) => right.updatedAt - left.updatedAt)[0]
        ?.sessionId;
  }

  return RemoteAgentSessionRuntime.create({
    origin: "http://localhost:3000",
    auth: {
      keyId: "dev",
      privateKey: options.privateKeyPem,
    },
    clientCapabilities: REMOTE_DEFAULT_CLIENT_CAPABILITIES,
    ...(sessionId ? { sessionId } : {}),
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

export async function authenticate(
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

export async function postSessionCommand(
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

export async function writeRemoteKvValue(input: {
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

export async function readRemoteKvValue(input: {
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

export async function readSessionEvents(
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

export async function waitForSessionEvent(
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

export async function waitForValue<T>(
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
    case "assistant.message":
    case "tool.execution":
    case "queue.update":
    case "retry.status":
    case "agent.event":
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

export async function writeSessionFile(input: {
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
