import { sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { hc } from "hono/client";
import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ImageContent, Model, TextContent } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  getAgentDir,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type AgentSessionRuntime,
  type ExtensionUIContext,
  type SessionStats,
} from "@mariozechner/pi-coding-agent";
import { createChallengePayload } from "./auth.js";
import type { createV1Routes } from "./routes.js";
import type {
  AppSnapshot,
  ClearQueueResponse,
  CreateSessionResponse,
  ExtensionUiRequestEventPayload,
  SessionSnapshot,
  StreamEventEnvelope,
  UiResponseRequest,
} from "./schemas.js";
import { ExtensionUiRequestEventPayloadSchema, StreamEventEnvelopeSchema } from "./schemas.js";
import { parseSseStream } from "./sse.js";
import { assertType } from "./typebox.js";

type RemoteV1Routes = ReturnType<typeof createV1Routes>;

class RemoteApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RemoteApiError";
    this.status = status;
  }
}

export interface RemoteRuntimeAuthOptions {
  keyId: string;
  privateKey: string;
}

export interface RemoteRuntimeOptions {
  origin: string;
  auth: RemoteRuntimeAuthOptions;
  sessionId?: string;
  sessionName?: string;
  connectionId?: string;
  cwd?: string;
  agentDir?: string;
  fetchImpl?: typeof fetch;
}

interface StreamReadResult {
  events: StreamEventEnvelope[];
  nextOffset: string;
  streamClosed: boolean;
}

interface ReadSessionEventsOptions {
  signal?: AbortSignal;
  onEvent?: (event: StreamEventEnvelope) => Promise<void> | void;
  onControl?: (control: {
    nextOffset: string;
    streamClosed: boolean;
    streamCursor?: string;
  }) => void;
}

interface RemoteApiClientOptions {
  origin: string;
  auth: RemoteRuntimeAuthOptions;
  connectionId?: string;
  fetchImpl?: typeof fetch;
}

interface RemoteSessionContract {
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  modelRegistry: ModelRegistry;
  bindExtensions: AgentSession["bindExtensions"];
  subscribe: AgentSession["subscribe"];
  prompt: AgentSession["prompt"];
  steer: AgentSession["steer"];
  followUp: AgentSession["followUp"];
  sendUserMessage: AgentSession["sendUserMessage"];
  setModel: AgentSession["setModel"];
  cycleModel: AgentSession["cycleModel"];
  setThinkingLevel: AgentSession["setThinkingLevel"];
  cycleThinkingLevel: AgentSession["cycleThinkingLevel"];
  getAvailableThinkingLevels: AgentSession["getAvailableThinkingLevels"];
  setSessionName: AgentSession["setSessionName"];
  getActiveToolNames: AgentSession["getActiveToolNames"];
  getToolDefinition: AgentSession["getToolDefinition"];
  reload: AgentSession["reload"];
}

interface RemoteModelSettingsState {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  enabledModels?: string[];
}

export interface RemoteRuntimeContract {
  session: RemoteSessionContract;
  diagnostics: AgentSessionRuntime["diagnostics"];
  modelFallbackMessage: AgentSessionRuntime["modelFallbackMessage"];
  services: {
    settingsManager: SettingsManager;
    modelRegistry: ModelRegistry;
    resourceLoader: unknown;
  };
  newSession: AgentSessionRuntime["newSession"];
  switchSession: AgentSessionRuntime["switchSession"];
  fork: AgentSessionRuntime["fork"];
  importFromJsonl: AgentSessionRuntime["importFromJsonl"];
  dispose: AgentSessionRuntime["dispose"];
}

class RemoteApiClient {
  private readonly rpcClient: ReturnType<typeof hc<RemoteV1Routes>>;
  private readonly auth: RemoteRuntimeAuthOptions;
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private token: string | undefined;
  private connectionId: string | undefined;
  private readonly sessionStreamCursors = new Map<string, string>();

  constructor(options: RemoteApiClientOptions) {
    const origin = options.origin.replace(/\/$/, "");
    this.origin = origin;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.rpcClient = hc<RemoteV1Routes>(`${origin}/v1`, {
      fetch: options.fetchImpl,
    });
    this.auth = options.auth;
    this.connectionId = options.connectionId;
  }

  async authenticate(): Promise<void> {
    const challengeResponse = await this.rpcClient.auth.challenge.$post({
      json: { keyId: this.auth.keyId },
    });
    this.captureConnectionId(challengeResponse);
    if (challengeResponse.status !== 200) {
      throw await this.toHttpError(challengeResponse);
    }
    const challenge = await challengeResponse.json();

    const signature = sign(
      null,
      Buffer.from(
        createChallengePayload({
          challengeId: challenge.challengeId,
          keyId: this.auth.keyId,
          nonce: challenge.nonce,
          origin: challenge.origin,
          expiresAt: challenge.expiresAt,
        }),
      ),
      this.auth.privateKey,
    ).toString("base64");

    const verifyResponse = await this.rpcClient.auth.verify.$post({
      json: {
        challengeId: challenge.challengeId,
        keyId: this.auth.keyId,
        signature,
      },
    });
    this.captureConnectionId(verifyResponse);
    if (verifyResponse.status !== 200) {
      throw await this.toHttpError(verifyResponse);
    }
    const verified = await verifyResponse.json();

    this.token = verified.token;
  }

  async getAppSnapshot(): Promise<AppSnapshot> {
    const response = await this.rpcClient.app.snapshot.$get(undefined, {
      headers: await this.getAuthHeaders(),
    });
    this.captureConnectionId(response);
    if (response.status !== 200) {
      throw await this.toHttpError(response);
    }
    return await response.json();
  }

  async createSession(sessionName?: string): Promise<CreateSessionResponse> {
    const response = await this.rpcClient.sessions.$post(
      {
        json: sessionName ? { sessionName } : {},
      },
      {
        headers: await this.getAuthHeaders(),
      },
    );
    this.captureConnectionId(response);
    if (response.status !== 201) {
      throw await this.toHttpError(response);
    }
    return await response.json();
  }

  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const response = await this.rpcClient.sessions[":sessionId"].snapshot.$get(
      {
        param: { sessionId },
      },
      {
        headers: await this.getAuthHeaders(),
      },
    );
    this.captureConnectionId(response);
    if (response.status !== 200) {
      throw await this.toHttpError(response);
    }
    return await response.json();
  }

  async prompt(sessionId: string, body: { text: string; attachments?: string[] }): Promise<void> {
    const response = await this.rpcClient.sessions[":sessionId"].prompt.$post(
      {
        param: { sessionId },
        json: body,
      },
      {
        headers: await this.getAuthHeaders(),
      },
    );
    this.captureConnectionId(response);
    if (!response.ok) {
      throw await this.toHttpError(response);
    }
  }

  async steer(sessionId: string, body: { text: string; attachments?: string[] }): Promise<void> {
    const response = await this.rpcClient.sessions[":sessionId"].steer.$post(
      {
        param: { sessionId },
        json: body,
      },
      {
        headers: await this.getAuthHeaders(),
      },
    );
    this.captureConnectionId(response);
    if (!response.ok) {
      throw await this.toHttpError(response);
    }
  }

  async followUp(sessionId: string, body: { text: string; attachments?: string[] }): Promise<void> {
    const response = await this.rpcClient.sessions[":sessionId"]["follow-up"].$post(
      {
        param: { sessionId },
        json: body,
      },
      {
        headers: await this.getAuthHeaders(),
      },
    );
    this.captureConnectionId(response);
    if (!response.ok) {
      throw await this.toHttpError(response);
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const response = await this.rpcClient.sessions[":sessionId"].interrupt.$post(
      {
        param: { sessionId },
        json: {},
      },
      {
        headers: await this.getAuthHeaders(),
      },
    );
    this.captureConnectionId(response);
    if (!response.ok) {
      throw await this.toHttpError(response);
    }
  }

  async updateModel(
    sessionId: string,
    body: { model: string; thinkingLevel?: string },
  ): Promise<void> {
    const response = await this.rpcClient.sessions[":sessionId"].model.$post(
      {
        param: { sessionId },
        json: body,
      },
      {
        headers: await this.getAuthHeaders(),
      },
    );
    this.captureConnectionId(response);
    if (!response.ok) {
      throw await this.toHttpError(response);
    }
  }

  async updateSessionName(sessionId: string, sessionName: string): Promise<void> {
    const response = await this.rpcClient.sessions[":sessionId"]["session-name"].$post(
      {
        param: { sessionId },
        json: { sessionName },
      },
      {
        headers: await this.getAuthHeaders(),
      },
    );
    this.captureConnectionId(response);
    if (!response.ok) {
      throw await this.toHttpError(response);
    }
  }

  async postUiResponse(sessionId: string, response: UiResponseRequest): Promise<void> {
    const request = await this.rpcClient.sessions[":sessionId"]["ui-response"].$post(
      {
        param: { sessionId },
        json: response,
      },
      {
        headers: await this.getAuthHeaders(),
      },
    );
    this.captureConnectionId(request);
    if (!request.ok) {
      throw await this.toHttpError(request);
    }
  }

  async clearQueue(sessionId: string): Promise<ClearQueueResponse> {
    const response = await this.rpcClient.sessions[":sessionId"]["clear-queue"].$post(
      {
        param: { sessionId },
      },
      {
        headers: await this.getAuthHeaders(),
      },
    );
    this.captureConnectionId(response);
    if (response.status !== 200) {
      throw await this.toHttpError(response);
    }
    return await response.json();
  }

  async readSessionEvents(
    sessionId: string,
    offset: string,
    options?: ReadSessionEventsOptions,
  ): Promise<StreamReadResult> {
    const cursor = this.sessionStreamCursors.get(sessionId);
    const query = new URLSearchParams({
      live: "sse",
      offset,
      ...(cursor ? { cursor } : {}),
    });
    const response = await this.fetchImpl(
      `${this.origin}/v1/streams/sessions/${encodeURIComponent(sessionId)}/events?${query.toString()}`,
      {
        method: "GET",
        headers: await this.getAuthHeaders(),
        signal: options?.signal,
      },
    );
    this.captureConnectionId(response);

    if (response.status === 204) {
      const nextOffset = response.headers.get("Stream-Next-Offset") ?? offset;
      const nextCursor = response.headers.get("Stream-Cursor") ?? undefined;
      if (nextCursor) {
        this.sessionStreamCursors.set(sessionId, nextCursor);
      } else {
        this.sessionStreamCursors.delete(sessionId);
      }
      return {
        events: [],
        nextOffset,
        streamClosed: response.headers.get("Stream-Closed") === "true",
      };
    }

    if (!response.ok) {
      throw await this.toHttpError(response);
    }

    const sseRead = await this.readSessionEventsFromSse(
      response,
      offset,
      options?.onEvent,
      options?.onControl,
      options?.signal,
    );
    if (sseRead.streamCursor) {
      this.sessionStreamCursors.set(sessionId, sseRead.streamCursor);
    } else {
      this.sessionStreamCursors.delete(sessionId);
    }

    return {
      events: sseRead.events,
      nextOffset: sseRead.nextOffset,
      streamClosed: sseRead.streamClosed,
    };
  }

  private async readSessionEventsFromSse(
    response: Response,
    fallbackOffset: string,
    onEvent?: (event: StreamEventEnvelope) => Promise<void> | void,
    onControl?: (control: {
      nextOffset: string;
      streamClosed: boolean;
      streamCursor?: string;
    }) => void,
    signal?: AbortSignal,
  ): Promise<StreamReadResult & { streamCursor?: string }> {
    const stream = response.body;
    const initialCursor = response.headers.get("Stream-Cursor") ?? undefined;
    if (!stream) {
      return {
        events: [],
        nextOffset: response.headers.get("Stream-Next-Offset") ?? fallbackOffset,
        streamClosed: response.headers.get("Stream-Closed") === "true",
        streamCursor: initialCursor,
      };
    }

    const events: StreamEventEnvelope[] = [];
    let nextOffset = response.headers.get("Stream-Next-Offset") ?? fallbackOffset;
    let streamCursor = initialCursor;
    let streamClosed = response.headers.get("Stream-Closed") === "true";

    for await (const event of parseSseStream(stream, signal)) {
      if (event.type === "data") {
        const parsed = JSON.parse(event.data);
        assertType(StreamEventEnvelopeSchema, parsed);
        if (onEvent) {
          await onEvent(parsed);
        } else {
          events.push(parsed);
        }
        continue;
      }

      nextOffset = event.streamNextOffset;
      if (event.streamCursor) {
        streamCursor = event.streamCursor;
      }
      if (event.streamClosed === true) {
        streamClosed = true;
      }
      onControl?.({
        nextOffset,
        streamClosed,
        streamCursor,
      });
      if (streamClosed) {
        break;
      }
    }

    return {
      events,
      nextOffset,
      streamClosed,
      streamCursor,
    };
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    if (!this.token) {
      throw new Error("Remote auth token is missing");
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
    };
    if (this.connectionId) {
      headers["x-pi-connection-id"] = this.connectionId;
    }
    return headers;
  }

  private captureConnectionId(response: Response): void {
    const header = response.headers.get("x-pi-connection-id");
    if (header) {
      this.connectionId = header;
    }
  }

  private async toHttpError(response: Response): Promise<RemoteApiError> {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        const body = await response.json();
        const errorMessage =
          body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error
            : undefined;
        const detailsMessage =
          body && typeof body === "object" && "details" in body && typeof body.details === "string"
            ? body.details
            : undefined;
        const message =
          errorMessage && detailsMessage
            ? `${errorMessage}: ${detailsMessage}`
            : (errorMessage ?? response.statusText);
        return new RemoteApiError(response.status, message);
      } catch {
        return new RemoteApiError(
          response.status,
          response.statusText || `HTTP ${response.status}`,
        );
      }
    }
    return new RemoteApiError(response.status, response.statusText || `HTTP ${response.status}`);
  }
}

function parseModelRef(value: string): { provider: string; modelId: string } {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator >= value.length - 1) {
    return {
      provider: "unknown",
      modelId: value,
    };
  }

  return {
    provider: value.slice(0, separator),
    modelId: value.slice(separator + 1),
  };
}

function createFallbackModel(provider: string, modelId: string): Model<any> {
  return {
    provider,
    id: modelId,
    name: `${provider}/${modelId}`,
    baseUrl: "https://remote.invalid",
    api: "responses",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 0,
    maxTokens: 0,
  };
}

function cloneModel(model: Model<any>): Model<any> {
  return {
    ...model,
    input: [...model.input],
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(model.compat !== undefined ? { compat: model.compat as Model<any>["compat"] } : {}),
  };
}

function patchModelRegistryForRemoteCatalog(
  modelRegistry: ModelRegistry,
  getAvailableModels: () => readonly Model<any>[],
): void {
  modelRegistry.refresh = () => {};
  modelRegistry.getError = () => undefined;
  modelRegistry.getAll = () => getAvailableModels().map((model) => cloneModel(model));
  modelRegistry.getAvailable = () => getAvailableModels().map((model) => cloneModel(model));
  modelRegistry.find = (provider: string, modelId: string) => {
    const model = getAvailableModels().find(
      (candidate) => candidate.provider === provider && candidate.id === modelId,
    );
    return model ? cloneModel(model) : undefined;
  };
  modelRegistry.getApiKeyForProvider = async (provider: string) => {
    return getAvailableModels().some((model) => model.provider === provider)
      ? "remote-managed"
      : undefined;
  };
  modelRegistry.hasConfiguredAuth = (_model: Model<any>) => true;
}

function patchSettingsManagerForRemoteModelSettings(
  settingsManager: SettingsManager,
  getRemoteSettings: () => RemoteModelSettingsState,
): void {
  settingsManager.getDefaultProvider = () => getRemoteSettings().defaultProvider;
  settingsManager.getDefaultModel = () => getRemoteSettings().defaultModel;
  settingsManager.getDefaultThinkingLevel = () => getRemoteSettings().defaultThinkingLevel;
  settingsManager.getEnabledModels = () => {
    const enabled = getRemoteSettings().enabledModels;
    return enabled ? [...enabled] : undefined;
  };
  settingsManager.setDefaultProvider = (provider: string) => {
    getRemoteSettings().defaultProvider = provider;
  };
  settingsManager.setDefaultModel = (modelId: string) => {
    getRemoteSettings().defaultModel = modelId;
  };
  settingsManager.setDefaultModelAndProvider = (provider: string, modelId: string) => {
    const remote = getRemoteSettings();
    remote.defaultProvider = provider;
    remote.defaultModel = modelId;
  };
  settingsManager.setDefaultThinkingLevel = (
    level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
  ) => {
    getRemoteSettings().defaultThinkingLevel = level;
  };
  settingsManager.setEnabledModels = (patterns: string[] | undefined) => {
    getRemoteSettings().enabledModels = patterns ? [...patterns] : undefined;
  };
}

function normalizeAttachments(images: ImageContent[] | undefined): string[] | undefined {
  if (!images || images.length === 0) {
    return undefined;
  }
  return images.map((image) => `data:${image.mimeType};base64,${image.data}`);
}

function contentToTextAndImages(content: string | (TextContent | ImageContent)[]): {
  text: string;
  images: ImageContent[];
} {
  if (typeof content === "string") {
    return {
      text: content,
      images: [],
    };
  }

  const text = content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const images = content.filter((part): part is ImageContent => part.type === "image");
  return {
    text,
    images,
  };
}

export class RemoteAgentSession implements RemoteSessionContract {
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;
  readonly modelRegistry: ModelRegistry;
  readonly resourceLoader: {
    getSkills: () => { skills: any[]; diagnostics: any[] };
    getPrompts: () => { prompts: any[]; diagnostics: any[] };
    getThemes: () => { themes: any[]; diagnostics: any[] };
    getExtensions: () => { extensions: any[]; errors: any[] };
    getAgentsFiles: () => { agentsFiles: any[] };
  };
  readonly promptTemplates: any[] = [];
  readonly state: {
    messages: AgentMessage[];
    pendingToolCalls: Set<string>;
    isStreaming: boolean;
    model: Model<any> | undefined;
    thinkingLevel: ThinkingLevel;
    streamingMessage?: AgentMessage;
    errorMessage?: string;
  };
  readonly agent: {
    abort: () => Promise<void>;
    waitForIdle: () => Promise<void>;
    signal: AbortSignal | undefined;
  };

  private readonly listeners = new Set<AgentSessionEventListener>();
  private readonly client: RemoteApiClient;
  private readonly sessionId: string;
  private streamOffset: string;
  private closed = false;
  private pollingTask: Promise<void> | undefined;
  private activeReadAbortController: AbortController | undefined;
  private uiContext: ExtensionUIContext | undefined;
  private readonly bufferedUiRequests: ExtensionUiRequestEventPayload[] = [];
  private queuedSteeringMessages: string[] = [];
  private queuedFollowUpMessages: string[] = [];
  private queueDepth = 0;
  private activeTools: string[] = [];
  private emitQueue: Promise<void> = Promise.resolve();
  private mutationQueue: Promise<void> = Promise.resolve();
  private idleResolvers = new Set<() => void>();
  private _isRetrying = false;
  private _isCompacting = false;
  private _autoCompactionEnabled = false;
  private _autoRetryEnabled = false;
  private _steeringMode: "all" | "one-at-a-time" = "all";
  private _followUpMode: "all" | "one-at-a-time" = "all";
  private _model: Model<any> | undefined;
  private _thinkingLevel: ThinkingLevel = "medium";
  private _retryAttempt = 0;
  private remoteAvailableModels: Model<any>[] = [];
  private readonly remoteModelSettings: RemoteModelSettingsState = {};

  private constructor(
    client: RemoteApiClient,
    sessionId: string,
    snapshot: SessionSnapshot,
    settingsManager: SettingsManager,
    modelRegistry: ModelRegistry,
    sessionManager: SessionManager,
  ) {
    this.client = client;
    this.sessionId = sessionId;
    this.streamOffset = snapshot.lastSessionStreamOffset;
    this.settingsManager = settingsManager;
    this.modelRegistry = modelRegistry;
    this.sessionManager = sessionManager;
    this.resourceLoader = {
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getExtensions: () => ({ extensions: [], errors: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
    };

    this.applyRemoteCatalogSnapshot(snapshot);
    this.applyRemoteSettingsSnapshot(snapshot);
    this._thinkingLevel = (snapshot.thinkingLevel as ThinkingLevel) ?? "medium";
    this._model = this.resolveModel(snapshot.model);

    this.state = {
      messages: [...(snapshot.transcript as AgentMessage[])],
      pendingToolCalls: new Set(
        snapshot.pendingToolCalls
          .map((call) => {
            if (typeof call === "string") {
              return call;
            }
            if (call && typeof call === "object") {
              const toolCallId = (call as { toolCallId?: string }).toolCallId;
              const id = (call as { id?: string }).id;
              return toolCallId ?? id;
            }
            return undefined;
          })
          .filter((value): value is string => Boolean(value)),
      ),
      isStreaming: snapshot.streamingState === "streaming",
      model: this._model,
      thinkingLevel: this._thinkingLevel,
      errorMessage: snapshot.errorMessage ?? undefined,
    };

    this.queueDepth = snapshot.queue.depth;
    this.activeTools = [...snapshot.activeTools];

    this.agent = {
      abort: async () => {
        await this.abort();
      },
      waitForIdle: async () => {
        await this.waitForIdle();
      },
      signal: undefined,
    };

    this.sessionManager.newSession({ id: snapshot.sessionId });
    this.sessionManager.appendSessionInfo(snapshot.sessionName);
  }

  static async create(
    client: RemoteApiClient,
    sessionId: string,
    options: { cwd: string; agentDir: string },
  ): Promise<RemoteAgentSession> {
    const snapshot = await client.getSessionSnapshot(sessionId);
    const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    let session: RemoteAgentSession | undefined;
    patchModelRegistryForRemoteCatalog(
      modelRegistry,
      () => session?.getRemoteAvailableModels() ?? [],
    );
    patchSettingsManagerForRemoteModelSettings(
      settingsManager,
      () => session?.getRemoteModelSettings() ?? {},
    );
    const sessionManager = SessionManager.inMemory(options.cwd);
    session = new RemoteAgentSession(
      client,
      snapshot.sessionId,
      snapshot,
      settingsManager,
      modelRegistry,
      sessionManager,
    );
    session.startPolling();
    return session;
  }

  getRemoteAvailableModels(): readonly Model<any>[] {
    return this.remoteAvailableModels;
  }

  getRemoteModelSettings(): RemoteModelSettingsState {
    return this.remoteModelSettings;
  }

  private applyRemoteCatalogSnapshot(snapshot: SessionSnapshot): void {
    this.remoteAvailableModels = snapshot.availableModels.map((model) =>
      cloneModel(model as Model<any>),
    );
  }

  private applyRemoteSettingsSnapshot(snapshot: SessionSnapshot): void {
    this.remoteModelSettings.defaultProvider = snapshot.modelSettings.defaultProvider ?? undefined;
    this.remoteModelSettings.defaultModel = snapshot.modelSettings.defaultModel ?? undefined;
    this.remoteModelSettings.defaultThinkingLevel =
      (snapshot.modelSettings.defaultThinkingLevel as ThinkingLevel | null) ?? undefined;
    this.remoteModelSettings.enabledModels = snapshot.modelSettings.enabledModels
      ? [...snapshot.modelSettings.enabledModels]
      : undefined;
  }

  private resolveModel(modelRefValue: string): Model<any> {
    const modelRef = parseModelRef(modelRefValue);
    const model = this.remoteAvailableModels.find(
      (candidate) => candidate.provider === modelRef.provider && candidate.id === modelRef.modelId,
    );
    if (model) {
      return cloneModel(model);
    }
    return createFallbackModel(modelRef.provider, modelRef.modelId);
  }

  get model(): Model<any> | undefined {
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

  get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
    return [];
  }

  setScopedModels(
    _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>,
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

  async prompt(
    text: string,
    options?: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" },
  ): Promise<void> {
    await this.waitForPendingMutations();
    if (this.isStreaming) {
      if (!options?.streamingBehavior) {
        throw new Error("Prompt requires streamingBehavior while remote session is streaming");
      }
      if (options.streamingBehavior === "steer") {
        await this.steer(text, options.images);
      } else {
        await this.followUp(text, options.images);
      }
      return;
    }

    await this.client.prompt(this.sessionId, {
      text,
      attachments: normalizeAttachments(options?.images),
    });
  }

  async steer(text: string, images?: ImageContent[]): Promise<void> {
    await this.waitForPendingMutations();
    await this.client.steer(this.sessionId, {
      text,
      attachments: normalizeAttachments(images),
    });
  }

  async followUp(text: string, images?: ImageContent[]): Promise<void> {
    await this.waitForPendingMutations();
    await this.client.followUp(this.sessionId, {
      text,
      attachments: normalizeAttachments(images),
    });
  }

  async sendUserMessage(
    content: string | (TextContent | ImageContent)[],
    options?: { deliverAs?: "steer" | "followUp" },
  ): Promise<void> {
    await this.waitForPendingMutations();
    const { text, images } = contentToTextAndImages(content);
    if (this.isStreaming) {
      if (options?.deliverAs === "steer") {
        await this.steer(text, images);
      } else {
        await this.followUp(text, images);
      }
      return;
    }

    await this.prompt(text, { images });
  }

  async sendCustomMessage<T = unknown>(
    _message: {
      customType: string;
      content: string | (TextContent | ImageContent)[];
      display: boolean;
      details?: T;
    },
    _options?: {
      triggerTurn?: boolean;
      deliverAs?: "steer" | "followUp" | "nextTurn";
    },
  ): Promise<void> {}

  clearQueue(): { steering: string[]; followUp: string[] } {
    const steering = [...this.queuedSteeringMessages];
    const followUp = [...this.queuedFollowUpMessages];
    const previousQueueDepth = this.queueDepth;
    this.queuedSteeringMessages = [];
    this.queuedFollowUpMessages = [];
    this.queueDepth = 0;
    this.enqueueMutation(
      async () => {
        await this.client.clearQueue(this.sessionId);
      },
      () => {
        this.queuedSteeringMessages = steering;
        this.queuedFollowUpMessages = followUp;
        this.queueDepth = previousQueueDepth;
      },
      "Failed to clear queued messages",
    );
    return { steering, followUp };
  }

  getSteeringMessages(): readonly string[] {
    return this.queuedSteeringMessages;
  }

  getFollowUpMessages(): readonly string[] {
    return this.queuedFollowUpMessages;
  }

  async waitForIdle(): Promise<void> {
    if (!this.isStreaming && this.queueDepth === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.idleResolvers.add(resolve);
    });
  }

  async abort(): Promise<void> {
    await this.waitForPendingMutations();
    await this.client.interrupt(this.sessionId);
  }

  async setModel(model: Model<any>): Promise<void> {
    await this.client.updateModel(this.sessionId, {
      model: `${model.provider}/${model.id}`,
    });
    this._model = model;
    this.state.model = model;
    this.remoteModelSettings.defaultProvider = model.provider;
    this.remoteModelSettings.defaultModel = model.id;
  }

  async cycleModel(
    direction: "forward" | "backward" = "forward",
  ): Promise<{ model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | undefined> {
    this.modelRegistry.refresh();
    const available = this.modelRegistry.getAvailable();
    if (available.length <= 1 || !this.model) {
      return undefined;
    }

    const currentIndex = available.findIndex(
      (candidate) => candidate.provider === this.model?.provider && candidate.id === this.model?.id,
    );
    const resolvedCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
    const delta = direction === "forward" ? 1 : -1;
    const nextIndex = (resolvedCurrentIndex + delta + available.length) % available.length;
    const nextModel = available[nextIndex];
    if (!nextModel) {
      return undefined;
    }

    await this.setModel(nextModel);
    return {
      model: nextModel,
      thinkingLevel: this.thinkingLevel,
      isScoped: false,
    };
  }

  setThinkingLevel(level: ThinkingLevel): void {
    const previousThinkingLevel = this._thinkingLevel;
    const modelRef = this.model ? `${this.model.provider}/${this.model.id}` : "unknown/unknown";
    this._thinkingLevel = level;
    this.state.thinkingLevel = level;
    this.enqueueMutation(
      async () => {
        await this.client.updateModel(this.sessionId, {
          model: modelRef,
          thinkingLevel: level,
        });
        this.remoteModelSettings.defaultThinkingLevel = level;
      },
      () => {
        this._thinkingLevel = previousThinkingLevel;
        this.state.thinkingLevel = previousThinkingLevel;
      },
      "Failed to update thinking level",
    );
  }

  cycleThinkingLevel(): ThinkingLevel | undefined {
    const levels: ThinkingLevel[] = this.getAvailableThinkingLevels();
    if (levels.length === 0) {
      return undefined;
    }
    const index = levels.indexOf(this.thinkingLevel);
    const next = levels[(index + 1) % levels.length];
    if (!next) {
      return undefined;
    }
    this.setThinkingLevel(next);
    return next;
  }

  getAvailableThinkingLevels(): ThinkingLevel[] {
    if (!this.model?.reasoning) {
      return ["off"];
    }
    return ["off", "minimal", "low", "medium", "high", "xhigh"];
  }

  supportsThinking(): boolean {
    return Boolean(this.model?.reasoning);
  }

  supportsXhighThinking(): boolean {
    return this.supportsThinking();
  }

  setSteeringMode(mode: "all" | "one-at-a-time"): void {
    this._steeringMode = mode;
  }

  setFollowUpMode(mode: "all" | "one-at-a-time"): void {
    this._followUpMode = mode;
  }

  async compact(_customInstructions?: string): Promise<never> {
    throw new Error("Compaction is not supported by remote adapter yet");
  }

  abortCompaction(): void {}

  abortBranchSummary(): void {}

  setAutoCompactionEnabled(enabled: boolean): void {
    this._autoCompactionEnabled = enabled;
  }

  setAutoRetryEnabled(enabled: boolean): void {
    this._autoRetryEnabled = enabled;
  }

  abortRetry(): void {}

  async executeBash(
    _command: string,
    _onChunk?: (chunk: string) => void,
    _options?: {
      excludeFromContext?: boolean;
      operations?: unknown;
    },
  ): Promise<never> {
    throw new Error("Direct local bash execution is not supported by remote adapter");
  }

  recordBashResult(
    _command: string,
    _result: unknown,
    _options?: { excludeFromContext?: boolean },
  ): void {}

  abortBash(): void {}

  get isBashRunning(): boolean {
    return false;
  }

  get hasPendingBashMessages(): boolean {
    return false;
  }

  setSessionName(name: string): void {
    const previousName = this.sessionManager.getSessionName();
    this.sessionManager.appendSessionInfo(name);
    this.enqueueMutation(
      async () => {
        await this.client.updateSessionName(this.sessionId, name);
      },
      () => {
        this.sessionManager.appendSessionInfo(previousName ?? "");
      },
      "Failed to update session name",
    );
  }

  async navigateTree(
    _targetId: string,
    _options?: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    },
  ): Promise<{ cancelled: boolean }> {
    return { cancelled: true };
  }

  getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
    return [];
  }

  getSessionStats(): SessionStats {
    const assistantMessages = this.state.messages.filter(
      (message) => message.role === "assistant",
    ).length;
    const userMessages = this.state.messages.filter((message) => message.role === "user").length;
    return {
      sessionFile: undefined,
      sessionId: this.sessionId,
      userMessages,
      assistantMessages,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: this.state.messages.length,
      tokens: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
      cost: 0,
      contextUsage: undefined,
    };
  }

  getContextUsage(): undefined {
    return undefined;
  }

  async exportToHtml(_outputPath?: string): Promise<never> {
    throw new Error("Export is not supported by remote adapter");
  }

  exportToJsonl(_outputPath?: string): string {
    throw new Error("Export is not supported by remote adapter");
  }

  getLastAssistantText(): string | undefined {
    const assistant = [...this.state.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (!assistant || assistant.role !== "assistant") {
      return undefined;
    }
    const text = assistant.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n");
    return text || undefined;
  }

  hasExtensionHandlers(_eventType: string): boolean {
    return false;
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
      sourceInfo: {
        source: "remote",
      },
    }));
  }

  getToolDefinition(_name: string): undefined {
    return undefined;
  }

  setActiveToolsByName(toolNames: string[]): void {
    this.activeTools = [...toolNames];
  }

  async reload(): Promise<void> {
    await this.waitForPendingMutations();
    const snapshot = await this.client.getSessionSnapshot(this.sessionId);
    this.applyRemoteCatalogSnapshot(snapshot);
    this.applyRemoteSettingsSnapshot(snapshot);
    this._thinkingLevel = (snapshot.thinkingLevel as ThinkingLevel) ?? this._thinkingLevel;
    this.state.thinkingLevel = this._thinkingLevel;
    this._model = this.resolveModel(snapshot.model);
    this.state.model = this._model;
    this.activeTools = [...snapshot.activeTools];
    this.queueDepth = snapshot.queue.depth;
    this.sessionManager.appendSessionInfo(snapshot.sessionName);
  }

  private async waitForPendingMutations(): Promise<void> {
    await this.mutationQueue;
  }

  dispose(): Promise<void> {
    this.closed = true;
    this.activeReadAbortController?.abort();
    this.activeReadAbortController = undefined;
    const task = this.pollingTask;
    if (!task) {
      return Promise.resolve();
    }
    return task.then(
      () => undefined,
      () => undefined,
    );
  }

  private startPolling(): void {
    this.pollingTask = this.pollEvents();
  }

  private async pollEvents(): Promise<void> {
    while (!this.closed) {
      let activeController: AbortController | undefined;
      try {
        activeController = new AbortController();
        this.activeReadAbortController = activeController;
        const read = await this.client.readSessionEvents(this.sessionId, this.streamOffset, {
          signal: activeController.signal,
          onEvent: async (envelope) => {
            await this.handleEnvelope(envelope);
          },
          onControl: (control) => {
            this.streamOffset = control.nextOffset;
          },
        });
        if (this.closed) {
          return;
        }
        for (const envelope of read.events) {
          await this.handleEnvelope(envelope);
        }
        this.streamOffset = read.nextOffset;
        if (read.streamClosed) {
          return;
        }
        if (read.events.length === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
      } catch (error) {
        if (this.closed) {
          return;
        }
        if (!this.isRetryablePollingError(error)) {
          this.handleRemoteError(`Remote stream polling failed: ${this.getErrorMessage(error)}`);
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      } finally {
        if (this.activeReadAbortController === activeController) {
          this.activeReadAbortController = undefined;
        }
      }
    }
  }

  private isRetryablePollingError(error: unknown): boolean {
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : undefined;

    if (status === undefined) {
      return error instanceof TypeError;
    }

    if (status >= 500) {
      return true;
    }

    return status === 408 || status === 425 || status === 429;
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private async handleEnvelope(envelope: StreamEventEnvelope): Promise<void> {
    if (envelope.kind === "agent_session_event") {
      this.applyAgentSessionEvent(envelope.payload as AgentSessionEvent);
      return;
    }

    if (envelope.kind === "session_state_patch") {
      const patch = (
        envelope.payload as {
          patch?: {
            model?: string;
            thinkingLevel?: string;
            sessionName?: string;
            availableModels?: Model<any>[];
            modelSettings?: {
              defaultProvider: string | null;
              defaultModel: string | null;
              defaultThinkingLevel: string | null;
              enabledModels: string[] | null;
            };
          };
        }
      ).patch;
      if (patch?.availableModels) {
        this.remoteAvailableModels = patch.availableModels.map((model) => cloneModel(model));
      }
      if (patch?.modelSettings) {
        this.remoteModelSettings.defaultProvider = patch.modelSettings.defaultProvider ?? undefined;
        this.remoteModelSettings.defaultModel = patch.modelSettings.defaultModel ?? undefined;
        this.remoteModelSettings.defaultThinkingLevel =
          (patch.modelSettings.defaultThinkingLevel as ThinkingLevel | null) ?? undefined;
        this.remoteModelSettings.enabledModels = patch.modelSettings.enabledModels
          ? [...patch.modelSettings.enabledModels]
          : undefined;
      }
      if (patch?.model) {
        this._model = this.resolveModel(patch.model);
        this.state.model = this._model;
      }
      if (patch?.thinkingLevel) {
        this._thinkingLevel = patch.thinkingLevel as ThinkingLevel;
        this.state.thinkingLevel = this._thinkingLevel;
      }
      if (patch?.sessionName) {
        this.sessionManager.appendSessionInfo(patch.sessionName);
      }
      return;
    }

    if (envelope.kind === "extension_error") {
      const payload = envelope.payload as { error?: string };
      this.handleRemoteError(payload.error ?? "Remote command execution failed");
      return;
    }

    if (envelope.kind === "extension_ui_request") {
      const payload = envelope.payload;
      try {
        assertType(ExtensionUiRequestEventPayloadSchema, payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid UI request payload";
        this.handleRemoteError(`Invalid extension UI request payload: ${message}`);
        return;
      }
      if (!this.uiContext) {
        this.bufferedUiRequests.push(payload);
        return;
      }
      await this.handleUiRequest(payload);
      return;
    }
  }

  private async handleUiRequest(request: ExtensionUiRequestEventPayload): Promise<void> {
    if (!this.uiContext) {
      return;
    }

    const id = request.id;
    const method = request.method;

    if (method === "notify") {
      this.uiContext.notify(request.message, request.notifyType);
      return;
    }

    if (method === "setStatus") {
      this.uiContext.setStatus(request.statusKey, request.statusText);
      return;
    }

    if (method === "setWidget") {
      this.uiContext.setWidget(request.widgetKey, request.widgetLines, {
        placement: request.widgetPlacement,
      });
      return;
    }

    if (method === "setTitle") {
      this.uiContext.setTitle(request.title);
      return;
    }

    if (method === "set_editor_text") {
      this.uiContext.setEditorText(request.text);
      return;
    }

    try {
      if (method === "select") {
        const value = await this.uiContext.select(request.title, request.options, {
          timeout: request.timeout,
        });
        await this.client.postUiResponse(
          this.sessionId,
          value === undefined ? { id, cancelled: true } : { id, value },
        );
        return;
      }

      if (method === "confirm") {
        const confirmed = await this.uiContext.confirm(request.title, request.message, {
          timeout: request.timeout,
        });
        await this.client.postUiResponse(this.sessionId, { id, confirmed });
        return;
      }

      if (method === "input") {
        const value = await this.uiContext.input(request.title, request.placeholder, {
          timeout: request.timeout,
        });
        await this.client.postUiResponse(
          this.sessionId,
          value === undefined ? { id, cancelled: true } : { id, value },
        );
        return;
      }

      if (method === "editor") {
        const value = await this.uiContext.editor(request.title, request.prefill);
        await this.client.postUiResponse(
          this.sessionId,
          value === undefined ? { id, cancelled: true } : { id, value },
        );
        return;
      }
    } catch {
      await this.client.postUiResponse(this.sessionId, { id, cancelled: true });
    }
  }

  private enqueueMutation(execute: () => Promise<void>, rollback: () => void, label: string): void {
    this.mutationQueue = this.mutationQueue.then(execute).catch((error) => {
      rollback();
      const message = error instanceof Error ? error.message : String(error);
      this.handleRemoteError(`${label}: ${message}`);
    });
  }

  private handleRemoteError(message: string): void {
    this.state.errorMessage = message;
    this.uiContext?.notify(message, "error");
    const entry = {
      role: "custom",
      customType: "remote_error",
      content: message,
      display: true,
      details: {
        source: "remote",
      },
    } as AgentMessage;
    this.applyAgentSessionEvent({ type: "message_start", message: entry });
    this.applyAgentSessionEvent({ type: "message_end", message: entry });
  }

  private applyAgentSessionEvent(event: AgentSessionEvent): void {
    if (event.type === "agent_start") {
      this.state.isStreaming = true;
    }

    if (event.type === "agent_end") {
      this.state.isStreaming = false;
      this.state.streamingMessage = undefined;
      this.state.pendingToolCalls.clear();
    }

    if (event.type === "message_start") {
      if (event.message.role === "assistant") {
        this.state.streamingMessage = event.message;
      }
      if (event.message.role === "user" || event.message.role === "custom") {
        this.state.messages = [...this.state.messages, event.message];
      }
    }

    if (event.type === "message_update" && event.message.role === "assistant") {
      this.state.streamingMessage = event.message;
    }

    if (event.type === "message_end") {
      if (event.message.role === "assistant") {
        this.state.streamingMessage = undefined;
        this.state.messages = [...this.state.messages, event.message];
      }
    }

    if (event.type === "tool_execution_start") {
      this.state.pendingToolCalls.add(event.toolCallId);
    }

    if (event.type === "tool_execution_end") {
      this.state.pendingToolCalls.delete(event.toolCallId);
    }

    if (event.type === "queue_update") {
      this.queuedSteeringMessages = [...event.steering];
      this.queuedFollowUpMessages = [...event.followUp];
      this.queueDepth = this.queuedSteeringMessages.length + this.queuedFollowUpMessages.length;
    }

    if (event.type === "auto_retry_start") {
      this._isRetrying = true;
      this._retryAttempt = event.attempt;
    }

    if (event.type === "auto_retry_end") {
      this._isRetrying = false;
      this._retryAttempt = event.attempt;
    }

    if (event.type === "compaction_start") {
      this._isCompacting = true;
    }

    if (event.type === "compaction_end") {
      this._isCompacting = false;
    }

    this.emitQueue = this.emitQueue
      .then(async () => {
        for (const listener of this.listeners) {
          await listener(event);
        }
      })
      .catch(() => undefined)
      .then(async () => {
        if (!this.isStreaming && this.queueDepth === 0 && this.idleResolvers.size > 0) {
          const resolvers = [...this.idleResolvers.values()];
          this.idleResolvers.clear();
          for (const resolve of resolvers) {
            resolve();
          }
        }
      });
  }
}

export class RemoteAgentSessionRuntime implements RemoteRuntimeContract {
  private readonly client: RemoteApiClient;
  private readonly cwd: string;
  private readonly agentDir: string;
  private _session: RemoteAgentSession;

  private constructor(
    client: RemoteApiClient,
    session: RemoteAgentSession,
    options: { cwd: string; agentDir: string },
  ) {
    this.client = client;
    this._session = session;
    this.cwd = options.cwd;
    this.agentDir = options.agentDir;
  }

  static async create(options: RemoteRuntimeOptions): Promise<RemoteAgentSessionRuntime> {
    const cwd = options.cwd ?? process.cwd();
    const agentDir = options.agentDir ?? getAgentDir();
    const client = new RemoteApiClient({
      origin: options.origin,
      auth: options.auth,
      connectionId: options.connectionId,
      fetchImpl: options.fetchImpl,
    });

    await client.authenticate();
    const appSnapshot = await client.getAppSnapshot();
    const resolvedSessionId = options.sessionId ?? appSnapshot.defaultAttachSessionId;
    const attachedSessionId =
      resolvedSessionId ?? (await client.createSession(options.sessionName)).sessionId;

    const session = await RemoteAgentSession.create(client, attachedSessionId, {
      cwd,
      agentDir,
    });

    return new RemoteAgentSessionRuntime(client, session, {
      cwd,
      agentDir,
    });
  }

  get session(): RemoteAgentSession {
    return this._session;
  }

  get diagnostics(): readonly [] {
    return [];
  }

  get modelFallbackMessage(): undefined {
    return undefined;
  }

  get services(): {
    settingsManager: SettingsManager;
    modelRegistry: ModelRegistry;
    resourceLoader: RemoteAgentSession["resourceLoader"];
  } {
    return {
      settingsManager: this._session.settingsManager,
      modelRegistry: this._session.modelRegistry,
      resourceLoader: this._session.resourceLoader,
    };
  }

  async newSession(options?: {
    parentSession?: string;
    setup?: (sessionManager: SessionManager) => Promise<void>;
  }): Promise<{ cancelled: boolean }> {
    const created = await this.client.createSession();
    await this.switchToSession(created.sessionId);
    if (options?.setup) {
      await options.setup(this._session.sessionManager);
    }
    return { cancelled: false };
  }

  async switchSession(sessionPath: string, _cwdOverride?: string): Promise<{ cancelled: boolean }> {
    await this.switchToSession(sessionPath);
    return { cancelled: false };
  }

  async fork(_entryId: string): Promise<{ cancelled: boolean; selectedText?: string }> {
    return { cancelled: true };
  }

  async importFromJsonl(
    _inputPath: string,
    _cwdOverride?: string,
  ): Promise<{ cancelled: boolean }> {
    return { cancelled: true };
  }

  async dispose(): Promise<void> {
    await this._session.dispose();
  }

  private async switchToSession(sessionId: string): Promise<void> {
    const previous = this._session;
    const next = await RemoteAgentSession.create(this.client, sessionId, {
      cwd: this.cwd,
      agentDir: this.agentDir,
    });
    this._session = next;
    await previous.dispose();
  }
}

export async function readRemotePrivateKey(options: {
  privateKey?: string;
  privateKeyPath?: string;
}): Promise<string> {
  if (options.privateKey && options.privateKey.trim().length > 0) {
    return options.privateKey;
  }
  if (options.privateKeyPath) {
    return await readFile(options.privateKeyPath, "utf8");
  }
  throw new Error("Missing PI_REMOTE_PRIVATE_KEY or PI_REMOTE_PRIVATE_KEY_PATH");
}

export function createInProcessFetch(app: {
  request: (input: string, init?: RequestInit) => Promise<Response>;
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl = typeof input === "string" ? new URL(input) : new URL(input.toString());
    const path = `${requestUrl.pathname}${requestUrl.search}`;
    return app.request(path, init);
  }) as typeof fetch;
}

export function defaultSessionNameFromCwd(cwd: string): string {
  return basename(cwd) || "Remote Session";
}
