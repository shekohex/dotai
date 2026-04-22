import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type {
  AgentSessionEvent,
  AgentSessionEventListener,
  ContextUsage,
  ExtensionUIContext,
  ModelRegistry,
  PromptTemplate,
  ResourceLoader,
  SessionStats,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { defaultSettings } from "../../../default-settings.js";
import type { RemoteApiClient } from "../../remote-api-client.js";
import type {
  ExtensionUiRequestEventPayload,
  RemoteExtensionMetadata,
  SessionSnapshot,
} from "../../schemas.js";
import {
  applyAuthoritativeCwd,
  applyRemoteExtensionsSnapshot,
  applyRemoteSettingsSnapshot,
  createInitialRemoteSessionState,
  getCombinedExtensionMetadata,
  handleRemoteUiRequest,
  initializeRemoteSessionMetadata,
  normalizeAvailableModels,
  readRemoteSettingsSnapshot,
  resolveModel,
  resolveThinkingLevel,
} from "../session-deps.js";
import type { RemoteModelSettingsState } from "../contracts.js";
import type { RemoteAgentSettings } from "../session-deps.js";
import { rehydrateMirroredSessionManager } from "../session-manager-mirror.js";
import {
  createRemoteLocalExtensionRunner,
  emitForwardableRemoteExtensionEvent,
  type ForwardableRemoteExtensionEvent,
  type RemoteLocalExtensionRunner,
  toForwardableRemoteExtensionEvent,
} from "./local-extension-runner.js";
import {
  describeManagedExtensionState,
  hydrateExtensionStateFromKv,
  isKvManagedExtensionState,
  persistManagedExtensionState,
} from "./extension-state-kv.js";

type RemoteExtensionCommandContextActions = {
  waitForIdle: () => Promise<void>;
  newSession: (options?: {
    parentSession?: string;
    setup?: (sessionManager: SessionManager) => Promise<void>;
  }) => Promise<{ cancelled: boolean }>;
  fork: (entryId: string) => Promise<{ cancelled: boolean; selectedText?: string }>;
  navigateTree: (
    targetId: string,
    options?: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    },
  ) => Promise<{ cancelled: boolean }>;
  switchSession: (sessionPath: string) => Promise<{ cancelled: boolean }>;
  reload: () => Promise<void>;
};

export abstract class RemoteAgentSessionSetupBase {
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  readonly modelRegistry: ModelRegistry;
  resourceLoader: ResourceLoader;
  promptTemplates: ReadonlyArray<PromptTemplate>;
  readonly state: {
    messages: AgentMessage[];
    pendingToolCalls: Set<string>;
    isStreaming: boolean;
    model: Model<Api> | undefined;
    thinkingLevel: ThinkingLevel;
    sessionStats: SessionStats;
    contextUsage: ContextUsage | undefined;
    usageCost: number;
    streamingMessage?: AgentMessage;
    errorMessage?: string;
  };
  readonly agent: {
    abort: () => Promise<void>;
    waitForIdle: () => Promise<void>;
    signal: AbortSignal | undefined;
  };

  protected readonly listeners = new Set<AgentSessionEventListener>();
  protected readonly client: RemoteApiClient;
  protected readonly sessionId: string;
  protected streamOffset: string;
  protected closed = false;
  protected pollingTask: Promise<void> | undefined;
  protected activeReadAbortController: AbortController | undefined;
  protected uiContext: ExtensionUIContext | undefined;
  protected readonly bufferedUiRequests: ExtensionUiRequestEventPayload[] = [];
  protected readonly pendingInteractiveRequests = new Map<string, AbortController>();
  protected queuedSteeringMessages: string[] = [];
  protected queuedFollowUpMessages: string[] = [];
  protected queueDepth = 0;
  protected activeTools: string[] = [];
  protected allTools: Array<{
    name: string;
    description: string;
    parameters: unknown;
    sourceInfo: unknown;
  }> = [];
  protected emitQueue: Promise<void> = Promise.resolve();
  protected mutationQueue: Promise<void> = Promise.resolve();
  protected idleResolvers = new Set<() => void>();
  protected _isRetrying = false;
  protected _isCompacting = false;
  protected _autoCompactionEnabled = false;
  protected _autoRetryEnabled = false;
  protected _steeringMode: "all" | "one-at-a-time" = "all";
  protected _followUpMode: "all" | "one-at-a-time" = "all";
  protected _model: Model<Api> | undefined;
  protected _thinkingLevel: ThinkingLevel = "medium";
  protected _retryAttempt = 0;
  protected remoteAvailableModels: Model<Api>[] = [];
  protected readonly remoteModelSettings: RemoteModelSettingsState = {};
  protected remoteSettings: RemoteAgentSettings = { ...defaultSettings };
  protected remoteExtensions: RemoteExtensionMetadata[] = [];
  protected readonly clientExtensions: RemoteExtensionMetadata[];
  protected readonly agentDir: string;
  protected localExtensionRunner: RemoteLocalExtensionRunner | undefined;
  protected localExtensionsStarted = false;
  protected extensionCommandContextActions: RemoteExtensionCommandContextActions | undefined;
  protected extensionShutdownHandler: (() => void) | undefined;
  protected extensionErrorListener: ((error: unknown) => void) | undefined;
  protected localExtensionErrorUnsubscriber: (() => void) | undefined;
  protected extensionStateHydrationTask: Promise<void> | undefined;
  protected localExtensionEventQueue: Promise<void> = Promise.resolve();
  protected readonly bufferedLocalExtensionEvents: ForwardableRemoteExtensionEvent[] = [];
  protected localExtensionTurnIndex = 0;

  protected constructor(
    client: RemoteApiClient,
    sessionId: string,
    snapshot: SessionSnapshot,
    settingsManager: SettingsManager,
    modelRegistry: ModelRegistry,
    sessionManager: SessionManager,
    resourceLoader: ResourceLoader,
    options: {
      agentDir: string;
      clientExtensions: RemoteExtensionMetadata[];
    },
  ) {
    this.client = client;
    this.sessionId = sessionId;
    this.streamOffset = snapshot.lastSessionStreamOffset;
    this.settingsManager = settingsManager;
    this.modelRegistry = modelRegistry;
    this.sessionManager = sessionManager;
    this.agentDir = options.agentDir;
    this.clientExtensions = options.clientExtensions;
    this.resourceLoader = resourceLoader;
    this.promptTemplates = this.resourceLoader.getPrompts().prompts;

    this.applyRemoteCatalogSnapshot(snapshot);
    applyRemoteSettingsSnapshot(this.remoteModelSettings, snapshot);
    this.remoteSettings = readRemoteSettingsSnapshot(snapshot);
    this.remoteExtensions = applyRemoteExtensionsSnapshot(snapshot);
    this._thinkingLevel = resolveThinkingLevel(snapshot.thinkingLevel, "medium");
    this._model = resolveModel({
      modelRef: snapshot.model,
      createModel: (provider, id) => this.modelRegistry.find(provider, id),
    });
    this.state = createInitialRemoteSessionState({
      snapshot,
      model: this._model,
      thinkingLevel: this._thinkingLevel,
    });
    this._autoCompactionEnabled = snapshot.autoCompactionEnabled;
    this._steeringMode = snapshot.steeringMode;
    this._followUpMode = snapshot.followUpMode;
    this.queueDepth = snapshot.queue.depth;
    this.activeTools = [...snapshot.activeTools];
    this.allTools = this.activeTools.map((toolName) => ({
      name: toolName,
      description: `${toolName} tool`,
      parameters: {},
      sourceInfo: { source: "remote" },
    }));
    this.agent = this.createAgentBindings();
    initializeRemoteSessionMetadata(this.sessionManager, snapshot);
    this.extensionStateHydrationTask = hydrateExtensionStateFromKv({
      client: this.client,
      sessionManager: this.sessionManager,
    });
    this.localExtensionRunner = this.createLocalExtensionRunner();
  }

  private createLocalExtensionRunner(): RemoteLocalExtensionRunner | undefined {
    return createRemoteLocalExtensionRunner({
      resourceLoader: this.resourceLoader,
      cwd: this.sessionManager.getCwd(),
      sessionManager: this.sessionManager,
      modelRegistry: this.modelRegistry,
      promptTemplates: this.promptTemplates,
      readSkills: () => this.resourceLoader.getSkills().skills,
      readModel: () => this.model,
      isIdle: () => !this.isStreaming,
      readSignal: () => this.agent.signal,
      abort: async () => {
        await this.abort();
      },
      hasPendingMessages: () => this.pendingMessageCount > 0,
      shutdown: () => {
        this.extensionShutdownHandler?.();
      },
      getContextUsage: () => this.getContextUsage(),
      compact: () => {},
      getSystemPrompt: () => this.systemPrompt,
      sendCustomMessage: async (message, sendOptions) => {
        await this.sendCustomMessage(message, sendOptions);
      },
      sendUserMessage: async (content, sendOptions) => {
        await this.sendUserMessage(content, sendOptions);
      },
      appendEntry: (customType, data) => {
        if (!isKvManagedExtensionState(customType)) {
          this.sessionManager.appendCustomEntry(customType, data);
          return;
        }

        void persistManagedExtensionState({
          client: this.client,
          sessionManager: this.sessionManager,
          customType,
          value: data,
        }).catch((error) => {
          const stateLabel = describeManagedExtensionState(customType) ?? customType;
          const errorMessage = error instanceof Error ? error.message : String(error);
          const message = `Failed to persist managed extension state (${stateLabel}): ${errorMessage}`;
          this.uiContext?.notify(message, "error");
          this.localExtensionRunner?.emitError({
            extensionPath: "<runtime>",
            event: "append_entry",
            error: message,
          });
        });
      },
      setSessionName: (name) => {
        this.setSessionName(name);
      },
      getSessionName: () => this.sessionManager.getSessionName(),
      setLabel: (entryId, label) => {
        this.sessionManager.appendLabelChange(entryId, label);
      },
      getActiveToolNames: () => this.getActiveToolNames(),
      getAllTools: () => this.getAllTools(),
      refreshTools: async () => {
        await this.refreshRemoteToolCatalog();
      },
      setActiveToolsByName: (toolNames) => {
        this.setActiveToolsByName(toolNames);
      },
      resolveModel: (provider, id) => this.modelRegistry.find(provider, id),
      setModel: async (model) => {
        await this.setModel(model);
      },
      hasConfiguredAuth: (model) => this.modelRegistry.hasConfiguredAuth(model),
      getThinkingLevel: () => this.thinkingLevel,
      setThinkingLevel: (level) => {
        this.setThinkingLevel(level);
      },
    });
  }

  private refreshLocalExtensionRunnerAfterCwdChange(): void {
    const previousRunner = this.localExtensionRunner;
    const wasStarted = this.localExtensionsStarted;
    if (previousRunner && wasStarted) {
      void previousRunner.emit({ type: "session_shutdown" });
    }

    this.localExtensionErrorUnsubscriber?.();
    this.localExtensionErrorUnsubscriber = undefined;
    this.localExtensionRunner = this.createLocalExtensionRunner();
    this.localExtensionsStarted = false;
    this.localExtensionEventQueue = Promise.resolve();
    this.bufferedLocalExtensionEvents.length = 0;
    this.localExtensionTurnIndex = 0;
    this.applyLocalExtensionBindings();
    if (wasStarted) {
      void this.ensureLocalExtensionsStarted();
    }
  }

  protected async refreshRemoteToolCatalog(): Promise<void> {
    const response = await this.client.getSessionTools(this.sessionId);
    this.allTools = response.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      sourceInfo: tool.sourceInfo,
    }));
  }

  protected createAgentBindings(): RemoteAgentSessionSetupBase["agent"] {
    return {
      abort: async () => {
        await this.abort();
      },
      waitForIdle: async () => {
        await this.waitForIdle();
      },
      signal: undefined,
    };
  }

  getRemoteAvailableModels(): readonly Model<Api>[] {
    return this.remoteAvailableModels;
  }

  getRemoteModelSettings(): RemoteModelSettingsState {
    return this.remoteModelSettings;
  }

  protected getCombinedExtensionsMetadata(): RemoteExtensionMetadata[] {
    return getCombinedExtensionMetadata({
      remoteExtensions: this.remoteExtensions,
      clientExtensions: this.clientExtensions,
    });
  }

  protected applyRemoteCatalogSnapshot(snapshot: SessionSnapshot): void {
    this.remoteAvailableModels = normalizeAvailableModels(snapshot.availableModels);
  }

  protected setResolvedModel(modelRef: string): void {
    this._model = resolveModel({
      modelRef,
      createModel: (provider, id) => this.modelRegistry.find(provider, id),
    });
    this.state.model = this._model;
  }

  protected applyAuthoritativeCwdUpdate(nextCwd: string): void {
    const currentSessionName = this.sessionManager.getSessionName();
    const cwdResult = applyAuthoritativeCwd({
      currentCwd: this.sessionManager.getCwd(),
      nextCwd,
      sessionId: this.sessionId,
      currentSessionName,
      remoteSettings: this.remoteSettings,
      remoteModelSettings: this.remoteModelSettings,
    });
    if (!cwdResult) {
      return;
    }

    this.sessionManager = cwdResult.sessionManager;
    rehydrateMirroredSessionManager({
      sessionManager: this.sessionManager,
      sessionId: this.sessionId,
      sessionName: currentSessionName,
      messages: this.state.messages,
    });
    this.settingsManager = cwdResult.settingsManager;
    this.refreshLocalExtensionRunnerAfterCwdChange();
  }

  get model(): Model<Api> | undefined {
    return this._model;
  }

  get thinkingLevel(): ThinkingLevel {
    return this._thinkingLevel;
  }

  get isStreaming(): boolean {
    return this.state.isStreaming;
  }

  get isCompacting(): boolean {
    return this._isCompacting;
  }

  get isRetrying(): boolean {
    return this._isRetrying;
  }

  get retryAttempt(): number {
    return this._retryAttempt;
  }

  get pendingMessageCount(): number {
    return this.queueDepth;
  }

  get autoCompactionEnabled(): boolean {
    return this._autoCompactionEnabled;
  }

  get autoRetryEnabled(): boolean {
    return this._autoRetryEnabled;
  }

  get steeringMode(): "all" | "one-at-a-time" {
    return this._steeringMode;
  }

  get followUpMode(): "all" | "one-at-a-time" {
    return this._followUpMode;
  }

  get sessionName(): string | undefined {
    return this.sessionManager.getSessionName();
  }

  get messages(): AgentMessage[] {
    return this.state.messages;
  }

  get systemPrompt(): string {
    return "";
  }

  get extensionRunner(): unknown {
    return this.localExtensionRunner;
  }

  get scopedModels(): ReadonlyArray<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> {
    return [];
  }

  setScopedModels(
    _scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>,
  ): void {}

  async bindExtensions(bindings: {
    uiContext?: ExtensionUIContext;
    commandContextActions?: RemoteExtensionCommandContextActions;
    shutdownHandler?: () => void;
    onError?: (error: unknown) => void;
  }): Promise<void> {
    this.uiContext = bindings.uiContext;
    try {
      await this.extensionStateHydrationTask;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown extension state hydration error";
      this.uiContext?.notify(`Failed to hydrate extension state: ${message}`, "warning");
      throw new Error(`Failed to hydrate extension state: ${message}`, { cause: error });
    }
    this.extensionStateHydrationTask = undefined;
    await this.refreshRemoteToolCatalog();
    this.extensionCommandContextActions = bindings.commandContextActions;
    this.extensionShutdownHandler = bindings.shutdownHandler;
    this.extensionErrorListener = bindings.onError;
    this.applyLocalExtensionBindings();
    await this.ensureLocalExtensionsStarted();
    while (this.bufferedUiRequests.length > 0) {
      const request = this.bufferedUiRequests.shift();
      if (!request) {
        break;
      }
      void this.handleUiRequest(request);
    }
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  protected async handleUiRequest(request: ExtensionUiRequestEventPayload): Promise<void> {
    if (!this.uiContext) {
      return;
    }

    await handleRemoteUiRequest({
      uiContext: this.uiContext,
      request,
      client: this.client,
      sessionId: this.sessionId,
      pendingInteractiveRequests: this.pendingInteractiveRequests,
    });
  }

  protected async tryExecuteLocalExtensionCommand(text: string): Promise<boolean> {
    if (!text.startsWith("/") || this.localExtensionRunner === undefined) {
      return false;
    }

    await this.ensureLocalExtensionsStarted();

    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);
    const command = this.localExtensionRunner.getCommand(commandName);
    if (!command) {
      return false;
    }

    try {
      await command.handler(args, this.localExtensionRunner.createCommandContext());
      return true;
    } catch (error) {
      this.localExtensionRunner.emitError({
        extensionPath: `command:${commandName}`,
        event: "command",
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  protected async shutdownLocalExtensions(): Promise<void> {
    if (this.localExtensionRunner === undefined) {
      return;
    }

    await this.localExtensionEventQueue;
    if (this.localExtensionsStarted) {
      await this.localExtensionRunner.emit({ type: "session_shutdown" });
      this.localExtensionsStarted = false;
    }
    this.localExtensionErrorUnsubscriber?.();
    this.localExtensionErrorUnsubscriber = undefined;
  }

  private applyLocalExtensionBindings(): void {
    if (this.localExtensionRunner === undefined) {
      return;
    }

    this.localExtensionRunner.setUIContext(this.uiContext);
    this.localExtensionRunner.bindCommandContext(this.extensionCommandContextActions);
    this.localExtensionErrorUnsubscriber?.();
    this.localExtensionErrorUnsubscriber = this.extensionErrorListener
      ? this.localExtensionRunner.onError(this.extensionErrorListener)
      : undefined;
  }

  private async ensureLocalExtensionsStarted(): Promise<void> {
    if (this.localExtensionRunner === undefined || this.localExtensionsStarted) {
      return;
    }

    await this.localExtensionRunner.emit({ type: "session_start", reason: "startup" });
    this.localExtensionsStarted = true;

    while (this.bufferedLocalExtensionEvents.length > 0) {
      const event = this.bufferedLocalExtensionEvents.shift();
      if (!event) {
        break;
      }
      this.enqueueLocalExtensionEvent(event);
    }
  }

  protected forwardAgentSessionEventToLocalExtensions(event: AgentSessionEvent): void {
    if (event.type === "agent_start") {
      this.localExtensionTurnIndex = 0;
    }

    const mappedEvent = toForwardableRemoteExtensionEvent(
      event,
      this.localExtensionTurnIndex,
      Date.now(),
    );
    if (!mappedEvent) {
      return;
    }

    if (event.type === "turn_end") {
      this.localExtensionTurnIndex += 1;
    }

    if (!this.localExtensionRunner || !this.localExtensionsStarted) {
      this.bufferedLocalExtensionEvents.push(mappedEvent);
      return;
    }

    this.enqueueLocalExtensionEvent(mappedEvent);
  }

  private enqueueLocalExtensionEvent(event: ForwardableRemoteExtensionEvent): void {
    this.localExtensionEventQueue = this.localExtensionEventQueue.then(async () => {
      await this.emitLocalExtensionEvent(event);
    });
    this.localExtensionEventQueue = this.localExtensionEventQueue.catch(() => {});
  }

  private async emitLocalExtensionEvent(event: ForwardableRemoteExtensionEvent): Promise<void> {
    if (!this.localExtensionRunner || !this.localExtensionsStarted) {
      return;
    }

    try {
      await emitForwardableRemoteExtensionEvent(this.localExtensionRunner, event);
    } catch (error) {
      this.localExtensionRunner.emitError({
        extensionPath: "<runtime>",
        event: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  abstract getContextUsage(): ContextUsage | undefined;
  abstract sendCustomMessage(
    message: {
      customType: string;
      content: string | Array<{ type: string; text?: string }>;
      display: boolean;
      details?: unknown;
    },
    options?: {
      triggerTurn?: boolean;
      deliverAs?: "steer" | "followUp" | "nextTurn";
    },
  ): Promise<void>;
  abstract sendUserMessage(
    content: string | Array<{ type: string; text?: string }>,
    options?: { deliverAs?: "steer" | "followUp" },
  ): Promise<void>;
  abstract setSessionName(name: string): void;
  abstract getActiveToolNames(): string[];
  abstract getAllTools(): Array<{
    name: string;
    description: string;
    parameters: unknown;
    sourceInfo: unknown;
  }>;
  abstract setActiveToolsByName(toolNames: string[]): void;
  abstract setModel(model: Model<Api>): Promise<void>;
  abstract setThinkingLevel(level: ThinkingLevel): void;

  abstract abort(): Promise<void>;
  abstract waitForIdle(): Promise<void>;
}
