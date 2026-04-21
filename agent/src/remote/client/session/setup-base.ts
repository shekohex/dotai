import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type {
  AgentSessionEventListener,
  ExtensionUIContext,
  ModelRegistry,
  PromptTemplate,
  ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
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
  createRemoteResourceLoader,
  getCombinedExtensionMetadata,
  handleRemoteUiRequest,
  initializeRemoteSessionMetadata,
  normalizeAvailableModels,
  resolveModel,
  resolveThinkingLevel,
} from "../session-deps.js";
import type { RemoteModelSettingsState } from "../contracts.js";

export abstract class RemoteAgentSessionSetupBase {
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  readonly modelRegistry: ModelRegistry;
  readonly resourceLoader: ResourceLoader;
  readonly promptTemplates: ReadonlyArray<PromptTemplate> = [];
  readonly state: {
    messages: AgentMessage[];
    pendingToolCalls: Set<string>;
    isStreaming: boolean;
    model: Model<Api> | undefined;
    thinkingLevel: ThinkingLevel;
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
  protected queuedSteeringMessages: string[] = [];
  protected queuedFollowUpMessages: string[] = [];
  protected queueDepth = 0;
  protected activeTools: string[] = [];
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
  protected remoteExtensions: RemoteExtensionMetadata[] = [];
  protected readonly clientExtensions: RemoteExtensionMetadata[];
  protected readonly agentDir: string;

  protected constructor(
    client: RemoteApiClient,
    sessionId: string,
    snapshot: SessionSnapshot,
    settingsManager: SettingsManager,
    modelRegistry: ModelRegistry,
    sessionManager: SessionManager,
    options: { agentDir: string; clientExtensions: RemoteExtensionMetadata[] },
  ) {
    this.client = client;
    this.sessionId = sessionId;
    this.streamOffset = snapshot.lastSessionStreamOffset;
    this.settingsManager = settingsManager;
    this.modelRegistry = modelRegistry;
    this.sessionManager = sessionManager;
    this.agentDir = options.agentDir;
    this.clientExtensions = options.clientExtensions;
    this.resourceLoader = createRemoteResourceLoader(() =>
      getCombinedExtensionMetadata({
        remoteExtensions: this.remoteExtensions,
        clientExtensions: this.clientExtensions,
      }),
    );

    this.applyRemoteCatalogSnapshot(snapshot);
    applyRemoteSettingsSnapshot(this.remoteModelSettings, snapshot);
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
    this.queueDepth = snapshot.queue.depth;
    this.activeTools = [...snapshot.activeTools];
    this.agent = this.createAgentBindings();
    initializeRemoteSessionMetadata(this.sessionManager, snapshot);
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
    const cwdResult = applyAuthoritativeCwd({
      currentCwd: this.sessionManager.getCwd(),
      nextCwd,
      sessionId: this.sessionId,
      currentSessionName: this.sessionManager.getSessionName(),
      agentDir: this.agentDir,
      remoteModelSettings: this.remoteModelSettings,
    });
    if (!cwdResult) {
      return;
    }

    this.sessionManager = cwdResult.sessionManager;
    this.settingsManager = cwdResult.settingsManager;
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

  get extensionRunner(): undefined {
    return undefined;
  }

  get scopedModels(): ReadonlyArray<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> {
    return [];
  }

  setScopedModels(
    _scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>,
  ): void {}

  bindExtensions(bindings: { uiContext?: ExtensionUIContext }): Promise<void> {
    this.uiContext = bindings.uiContext;
    while (this.bufferedUiRequests.length > 0) {
      const request = this.bufferedUiRequests.shift();
      if (!request) {
        break;
      }
      void this.handleUiRequest(request);
    }
    return Promise.resolve();
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
    });
  }

  abstract abort(): Promise<void>;
  abstract waitForIdle(): Promise<void>;
}
