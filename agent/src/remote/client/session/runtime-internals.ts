import { SettingsManager } from "@mariozechner/pi-coding-agent";
import type { SessionStats } from "@mariozechner/pi-coding-agent";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { Value } from "typebox/value";
import type { SessionSyncEvent, StreamEventEnvelope } from "../../schemas.js";
import { fromTransportTranscript } from "../../transcript-transport.js";
import {
  applyRemoteSettingsSnapshotInPlace,
  applyRemoteExtensionsSnapshot,
  applyRemoteSettingsSnapshot,
  cancelRemoteUiRequest,
  readRemoteSettingsSnapshot,
  resolveThinkingLevel,
} from "../session-deps.js";
import { mirrorSessionEventMessage } from "../session-manager-mirror.js";
import {
  applyRemoteAgentEventAndEmit,
  enqueueRemoteSessionMutation,
  handleRemoteSessionErrorBridge,
} from "../session-mutation-ops.js";
import { initializeRemoteSessionMetadata } from "../session-bootstrap-ops.js";
import {
  createRemoteSessionPollingInput,
  createRemoteSessionPollingStateHandlers,
  handleRemoteSessionEnvelope,
  type PollRemoteSessionRuntimeInput,
} from "./polling-ops.js";
import { clearRemoteModesSnapshot, setRemoteModesSnapshot } from "../remote-modes-store.js";
import { RemoteApiError } from "../../runtime-api/utils.js";
import { RemoteAgentSessionSetupBase } from "./setup-base.js";
import { emitResourceLoaderEventLocally } from "../../event-bus-bridge.js";
import {
  applySessionSyncPatch,
  readSnapshotLiveState,
  replaySnapshotExtensionState,
  replaySnapshotLiveOverlay,
  replaySnapshotUiState,
} from "./runtime-sync-support.js";
import { RuntimeAgentSessionEventSchema } from "./runtime-agent-session-event-schema.js";

export abstract class RemoteAgentSessionRuntimeInternals extends RemoteAgentSessionSetupBase {
  private initialSyncReady = false;
  protected readonly activeBashChunkCounts = new Map<string, number>();
  private readonly appliedSnapshotExtensionState = new Map<string, string>();
  private readonly initialSyncReadyPromise = new Promise<void>((resolve) => {
    this.resolveInitialSyncReady = resolve;
  });
  private resolveInitialSyncReady: (() => void) | undefined;

  protected async resyncAfterReauthentication(): Promise<void> {
    let snapshot;
    try {
      snapshot = await this.client.getSessionSnapshot(this.sessionId);
    } catch (error) {
      if (error instanceof RemoteApiError && error.status === 404) {
        this.clearTransientWorkingState();
        return;
      }
      throw error;
    }
    this.applySnapshot(snapshot, { resetTransientBashState: true });
    await this.refreshRemoteToolCatalog();
    await this.refreshForkMessages();
  }

  async reload(): Promise<void> {
    await this.waitForPendingMutations();
    const snapshot = await this.client.reloadSession(this.sessionId);
    this.applySnapshot(snapshot, { resetTransientBashState: true });
    await this.refreshRemoteToolCatalog();
    await this.refreshForkMessages();
    await this.replayLocalExtensionReloadLifecycle();
  }

  protected applySnapshot(
    snapshot: Parameters<typeof applyRemoteSettingsSnapshot>[1],
    options?: { resetTransientBashState?: boolean },
  ): void {
    const liveState = readSnapshotLiveState(snapshot);
    this.sessionVersion = snapshot.version;
    if (options?.resetTransientBashState === true) {
      this.activeBashExecutions.clear();
      this.activeBashRequests.clear();
    }
    this.applyAuthoritativeCwdUpdate(snapshot.cwd);
    this.applyRemoteCatalogSnapshot(snapshot);
    applyRemoteSettingsSnapshot(this.remoteModelSettings, snapshot);
    this.remoteSettings = readRemoteSettingsSnapshot(snapshot);
    this.settingsManager = SettingsManager.inMemory(this.remoteSettings);
    this.installSettingsManagerBindings(this.settingsManager);
    this.remoteExtensions = applyRemoteExtensionsSnapshot(snapshot);
    this._thinkingLevel = resolveThinkingLevel(snapshot.thinkingLevel, this._thinkingLevel);
    this.state.thinkingLevel = this._thinkingLevel;
    this.setResolvedModel(snapshot.model);
    this.state.messages = fromTransportTranscript(snapshot.transcript);
    this.state.pendingToolCalls = new Set(snapshot.pendingToolCalls);
    this.state.isStreaming = snapshot.streamingState === "streaming";
    this.state.streamingMessage =
      liveState.streamingMessage === undefined
        ? undefined
        : fromTransportTranscript([liveState.streamingMessage])[0];
    this._isBashRunning = snapshot.isBashRunning;
    this._hasPendingBashMessages = snapshot.hasPendingBashMessages;
    this.state.sessionStats = cloneSessionStats(snapshot.sessionStats);
    this.state.contextUsage = this.state.sessionStats.contextUsage ?? snapshot.contextUsage;
    this.state.usageCost = this.state.sessionStats.cost;
    this.state.errorMessage = snapshot.errorMessage ?? undefined;
    this._autoCompactionEnabled = snapshot.autoCompactionEnabled;
    this._steeringMode = snapshot.steeringMode;
    this._followUpMode = snapshot.followUpMode;
    this._isRetrying = snapshot.retry.status === "running";
    this._retryAttempt = liveState.retryAttempt;
    this._isCompacting = snapshot.compaction.status === "running";
    this.queuedSteeringMessages = [...liveState.queuedSteeringMessages];
    this.queuedFollowUpMessages = [...liveState.queuedFollowUpMessages];
    this.reloadResourceLoader(snapshot);
    this.activeTools = [...snapshot.activeTools];
    initializeRemoteSessionMetadata(this.sessionManager, snapshot);
    this.queueDepth = snapshot.queue.depth;
    replaySnapshotUiState({
      pendingUiRequests: snapshot.pendingUiRequests,
      uiState: snapshot.uiState,
      applyImmediateUiState: (request) => {
        if (!this.uiContext) {
          this.bufferedUiRequests.push(request);
          return;
        }
        void this.handleUiRequest(request);
      },
      replaceBufferedUiRequests: (requests) => {
        this.bufferedUiRequests.length = 0;
        this.bufferedUiRequests.push(...requests);
      },
    });
    replaySnapshotExtensionState({
      extensionState: snapshot.durableExtensionState,
      appliedSnapshotExtensionState: this.appliedSnapshotExtensionState,
      emit: (channel, data) => {
        emitResourceLoaderEventLocally(
          this.resourceLoader,
          channel,
          data,
          "RemoteAgentSessionRuntimeInternals.applySnapshot",
        );
      },
    });
    replaySnapshotLiveOverlay({
      snapshot,
      forwardAgentSessionEventToLocalExtensions: (event) => {
        this.forwardAgentSessionEventToLocalExtensions(event);
      },
    });
  }

  protected async waitForPendingMutations(): Promise<void> {
    await this.mutationQueue;
  }

  protected clearTransientWorkingState(): void {
    this.state.isStreaming = false;
    this._isRetrying = false;
    this._retryAttempt = 0;
    this._isCompacting = false;
    this.queueDepth = 0;
    this.queuedSteeringMessages = [];
    this.queuedFollowUpMessages = [];
    this.state.pendingToolCalls = new Set();
    if (this.idleResolvers.size > 0) {
      const resolvers = [...this.idleResolvers.values()];
      this.idleResolvers.clear();
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }

  dispose(): Promise<void> {
    this.closed = true;
    clearRemoteModesSnapshot(this.sessionManager);
    for (const pendingRequest of this.pendingInteractiveRequests.values()) {
      abortControllerSafely(pendingRequest);
    }
    this.pendingInteractiveRequests.clear();
    abortControllerSafely(this.activeReadAbortController);
    this.activeReadAbortController = undefined;
    const task = this.pollingTask;
    if (!task) {
      return this.shutdownLocalExtensions();
    }
    return task
      .then(
        () => {},
        () => {},
      )
      .then(() => this.shutdownLocalExtensions());
  }

  protected startPolling(): void {
    this.pollingTask = this.pollEvents();
  }

  protected async pollEvents(): Promise<void> {
    while (!this.closed) {
      const controller = new AbortController();
      this.activeReadAbortController = controller;

      try {
        await this.client.readSessionSync(this.sessionId, {
          signal: controller.signal,
          onSyncEvent: async (event) => {
            await this.handleSyncEvent(event);
          },
        });
        if (!this.closed) {
          await delay(250);
        }
      } catch (error) {
        if (controller.signal.aborted || this.closed) {
          return;
        }

        if (error instanceof RemoteApiError && error.status === 401) {
          const recovered = await this.recoverAuthentication();
          if (recovered) {
            continue;
          }
          return;
        }

        const status = readErrorStatus(error);
        let retryable: boolean;
        if (status === undefined) {
          retryable = error instanceof TypeError;
        } else {
          retryable = isRetryableStatus(status);
        }
        if (retryable) {
          await delay(250);
          continue;
        }

        this.handleRemoteError(`Remote stream polling failed: ${readErrorMessage(error)}`);
        return;
      } finally {
        if (this.activeReadAbortController === controller) {
          this.activeReadAbortController = undefined;
        }
      }
    }
  }

  protected async handleSyncEvent(event: SessionSyncEvent): Promise<void> {
    if (event.type === "server.connected") {
      for (const pendingRequest of this.pendingInteractiveRequests.values()) {
        pendingRequest.abort();
      }
      this.pendingInteractiveRequests.clear();
      return;
    }

    const previousVersion = this.sessionVersion;
    const previousErrorMessage = this.state.errorMessage;
    this.sessionVersion = event.version;

    if (event.type === "snapshot") {
      this.applySnapshot(event.snapshot, { resetTransientBashState: true });
      this.markInitialSyncReady();
      if (
        previousErrorMessage !== undefined &&
        previousErrorMessage.length > 0 &&
        event.snapshot.errorMessage === null &&
        previousVersion === event.version
      ) {
        this.state.errorMessage = previousErrorMessage;
      }
      return;
    }

    await this.handleSyncPatch(event.patch);
  }

  protected async handleSyncPatch(
    event: Extract<SessionSyncEvent, { type: "patch" }>["patch"],
  ): Promise<void> {
    await applySessionSyncPatch({
      sessionId: this.sessionId,
      streamOffset: this.sessionVersion,
      patch: event,
      handleEnvelope: (envelope) => this.handleEnvelope(envelope),
      handleAgentSessionEvent: (agentEvent) => {
        this.applyAgentSessionEvent(agentEvent);
      },
      emitExtensionCustom: (channel, data) => {
        emitResourceLoaderEventLocally(
          this.resourceLoader,
          channel,
          data,
          "RemoteAgentSessionRuntimeInternals.handleSyncPatch",
        );
      },
      handleUiRequest: (request) => this.handleUiRequest(request),
      cancelUiRequest: (requestId) => {
        cancelRemoteUiRequest(this.pendingInteractiveRequests, requestId);
      },
    });
  }

  protected async handleEnvelope(envelope: StreamEventEnvelope): Promise<void> {
    await handleRemoteSessionEnvelope(this.createPollingRuntimeInput(), envelope);
  }

  protected createPollingRuntimeInput(): PollRemoteSessionRuntimeInput {
    return createRemoteSessionPollingInput({
      handleRemoteError: (message) => {
        this.handleRemoteError(message);
      },
      applyAgentSessionEvent: (event) => {
        if (!isRuntimeAgentSessionEvent(event)) {
          return;
        }
        this.applyAgentSessionEvent(event);
      },
      isForwardableRemoteExtensionEvent: (value) => {
        return this.isForwardableRemoteExtensionEvent(value);
      },
      applyExtensionEvent: (event) => {
        this.forwardRemoteExtensionEventToLocalExtensions(event);
      },
      applyExtensionCustomEvent: (channel: string, data: unknown) => {
        emitResourceLoaderEventLocally(
          this.resourceLoader,
          channel,
          data,
          "RemoteAgentSessionRuntimeInternals",
        );
      },
      handleEnvelope: async (envelope) => {
        await this.handleEnvelope(envelope);
      },
      remoteModelSettings: this.remoteModelSettings,
      stateHandlers: this.createPollingStateHandlers(),
      client: this.client,
      sessionId: this.sessionId,
      handleBashStart: (payload) => {
        this._isBashRunning = true;
        this.activeBashExecutions.set(payload.executionId, {
          executionId: payload.executionId,
          command: payload.command,
          output: "",
          clientRequestId: payload.clientRequestId,
        });
        if (payload.clientRequestId === undefined) {
          return;
        }
        if (!this.activeBashRequests.has(payload.clientRequestId)) {
          this.activeBashRequests.set(payload.clientRequestId, {});
        }
      },
      handleBashChunk: (payload) => {
        const currentExecution = this.activeBashExecutions.get(payload.executionId);
        if (currentExecution) {
          currentExecution.output += payload.chunk;
        }
        if (payload.clientRequestId === undefined) {
          return;
        }
        const activeRequest = this.activeBashRequests.get(payload.clientRequestId);
        if (!activeRequest) {
          return;
        }
        this.activeBashChunkCounts.set(
          payload.clientRequestId,
          (this.activeBashChunkCounts.get(payload.clientRequestId) ?? 0) + 1,
        );
        activeRequest.onChunk?.(payload.chunk);
      },
      handleBashEnd: (payload) => {
        this._isBashRunning = false;
        this.activeBashExecutions.delete(payload.executionId);
        if (payload.message !== undefined) {
          const message = toBashExecutionMessage(payload.message);
          this.state.messages = [...this.state.messages, message];
          this.sessionManager.appendMessage(message);
        }
        if (payload.clientRequestId !== undefined) {
          this.activeBashChunkCounts.delete(payload.clientRequestId);
          this.activeBashRequests.delete(payload.clientRequestId);
        }
      },
      handleBashFlush: (payload) => {
        this._hasPendingBashMessages = false;
        for (const message of payload.messages) {
          const bashExecutionMessage = toBashExecutionMessage(message);
          this.state.messages = [...this.state.messages, bashExecutionMessage];
          this.sessionManager.appendMessage(bashExecutionMessage);
        }
      },
    });
  }

  protected createPollingStateHandlers(): ReturnType<
    typeof createRemoteSessionPollingStateHandlers
  > {
    return createRemoteSessionPollingStateHandlers({
      setRemoteAvailableModels: (models) => {
        this.remoteAvailableModels = models;
      },
      setResolvedModel: (modelRef) => {
        this.setResolvedModel(modelRef);
      },
      setThinkingLevel: (thinkingLevel) => {
        this._thinkingLevel = thinkingLevel;
        this.state.thinkingLevel = thinkingLevel;
      },
      applyAuthoritativeCwd: (cwd) => {
        this.applyAuthoritativeCwdUpdate(cwd);
      },
      setRemoteExtensions: (extensions) => {
        this.remoteExtensions = extensions;
      },
      setRemoteResources: (resources) => {
        setRemoteModesSnapshot(this.sessionManager, resources.modes);
      },
      setSessionName: (sessionName) => {
        if (sessionName !== undefined) {
          this.sessionManager.appendSessionInfo(sessionName);
        }
      },
      setActiveTools: (activeTools) => {
        this.activeTools = [...activeTools];
      },
      setContextUsage: (contextUsage) => {
        this.state.contextUsage = contextUsage;
      },
      setSessionStats: (sessionStats) => {
        this.state.sessionStats = cloneSessionStats(sessionStats);
        this.state.contextUsage = this.state.sessionStats.contextUsage;
        this.state.usageCost = this.state.sessionStats.cost;
      },
      setUsageCost: (usageCost) => {
        this.state.usageCost = usageCost;
      },
      setIsBashRunning: (isBashRunning) => {
        this._isBashRunning = isBashRunning;
      },
      setHasPendingBashMessages: (hasPendingBashMessages) => {
        this._hasPendingBashMessages = hasPendingBashMessages;
      },
      setAutoCompactionEnabled: (enabled) => {
        this._autoCompactionEnabled = enabled;
      },
      setSteeringMode: (mode) => {
        this._steeringMode = mode;
      },
      setFollowUpMode: (mode) => {
        this._followUpMode = mode;
      },
      setRemoteSettings: (settings) => {
        this.remoteSettings = { ...settings };
        applyRemoteSettingsSnapshotInPlace(this.settingsManager, this.remoteSettings);
      },
      getUiContext: () => this.uiContext,
      bufferUiRequest: (request) => {
        this.bufferedUiRequests.push(request);
      },
      pendingInteractiveRequests: this.pendingInteractiveRequests,
      cancelUiRequest: (requestId) => {
        cancelRemoteUiRequest(this.pendingInteractiveRequests, requestId);
      },
    });
  }

  protected enqueueMutation(
    execute: () => Promise<void>,
    rollback: () => void,
    label: string,
  ): void {
    enqueueRemoteSessionMutation({
      currentMutationQueue: this.mutationQueue,
      execute,
      rollback,
      label,
      handleRemoteError: (message) => {
        this.handleRemoteError(message);
      },
      setMutationQueue: (next) => {
        this.mutationQueue = next;
      },
    });
  }

  protected handleRemoteError(message: string): void {
    handleRemoteSessionErrorBridge({
      message,
      setErrorMessage: (nextMessage) => {
        this.state.errorMessage = nextMessage;
      },
      uiContext: this.uiContext,
      applyAgentSessionEvent: (event) => {
        this.applyAgentSessionEvent(event);
      },
    });
  }

  protected handleRemoteWarning(message: string): void {
    this.uiContext?.notify(message, "warning");
  }

  protected applyAgentSessionEvent(event: AgentSessionEvent): void {
    mirrorSessionEventMessage(this.sessionManager, event);
    if (event.type === "message_start" && event.message.role === "bashExecution") {
      this._hasPendingBashMessages = false;
    }
    if (event.type === "turn_end") {
      void this.refreshForkMessages();
    }
    this.forwardAgentSessionEventToLocalExtensions(event);
    const next = applyRemoteAgentEventAndEmit({
      event,
      state: this.state,
      currentDerivedState: {
        queuedSteeringMessages: this.queuedSteeringMessages,
        queuedFollowUpMessages: this.queuedFollowUpMessages,
        queueDepth: this.queueDepth,
        isRetrying: this._isRetrying,
        retryAttempt: this._retryAttempt,
        isCompacting: this._isCompacting,
      },
      listeners: this.listeners,
      isStreaming: this.isStreaming,
      queueDepth: this.queueDepth,
      idleResolvers: this.idleResolvers,
    });
    this.queuedSteeringMessages = next.queuedSteeringMessages;
    this.queuedFollowUpMessages = next.queuedFollowUpMessages;
    this.queueDepth = next.queueDepth;
    this._isRetrying = next.isRetrying;
    this._retryAttempt = next.retryAttempt;
    this._isCompacting = next.isCompacting;
  }

  getActiveBashExecutions(): Array<{
    executionId: string;
    command: string;
    output: string;
    clientRequestId?: string;
  }> {
    return [...this.activeBashExecutions.values()].map((execution) => ({ ...execution }));
  }

  async waitForInitialSyncReady(): Promise<void> {
    if (this.initialSyncReady) {
      return;
    }

    await this.initialSyncReadyPromise;
  }

  private async recoverAuthentication(): Promise<boolean> {
    this.handleRemoteWarning("Remote auth token invalid or expired. Reconnecting...");
    let attempt = 0;

    while (!this.closed) {
      try {
        await this.client.reauthenticate();
        await this.resyncAfterReauthentication();
        this.handleRemoteWarning("Remote connection restored.");
        return true;
      } catch (error) {
        if (this.closed) {
          return false;
        }

        const status = readErrorStatus(error);
        if (status === 401 || status === 403) {
          this.handleRemoteError(`Remote authentication denied: ${formatRemoteError(error)}`);
          return false;
        }

        let retryable: boolean;
        if (status === undefined) {
          retryable = error instanceof TypeError;
        } else {
          retryable = isRetryableStatus(status);
        }
        if (retryable) {
          attempt += 1;
          await delay(getBackoffDelayMs(attempt));
          continue;
        }

        this.handleRemoteError(`Remote authentication refresh failed: ${formatRemoteError(error)}`);
        return false;
      }
    }

    return false;
  }

  private markInitialSyncReady(): void {
    if (this.initialSyncReady) {
      return;
    }

    this.initialSyncReady = true;
    this.resolveInitialSyncReady?.();
    this.resolveInitialSyncReady = undefined;
  }
}

function isRuntimeAgentSessionEvent(
  value: Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"],
): value is AgentSessionEvent {
  return Value.Check(RuntimeAgentSessionEventSchema, value);
}

type BashExecutionMessagePayload = {
  command: string;
  output: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  timestamp: number;
  excludeFromContext?: boolean;
};

function abortControllerSafely(controller: AbortController | undefined): void {
  if (!controller) {
    return;
  }

  try {
    controller.abort();
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }

    throw error;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function cloneSessionStats(
  stats: Omit<SessionStats, "sessionFile"> & { sessionFile?: string },
): RemoteAgentSessionRuntimeInternals["state"]["sessionStats"] {
  return {
    ...stats,
    sessionFile: stats.sessionFile,
    tokens: {
      input: stats.tokens.input,
      output: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
      total: stats.tokens.total,
    },
    ...(stats.contextUsage ? { contextUsage: { ...stats.contextUsage } } : {}),
  };
}

function toBashExecutionMessage(
  payload: BashExecutionMessagePayload,
): Extract<
  RemoteAgentSessionRuntimeInternals["state"]["messages"][number],
  { role: "bashExecution" }
> {
  return {
    role: "bashExecution",
    command: payload.command,
    output: payload.output,
    exitCode: payload.exitCode,
    cancelled: payload.cancelled,
    truncated: payload.truncated,
    timestamp: payload.timestamp,
    ...(payload.fullOutputPath === undefined ? {} : { fullOutputPath: payload.fullOutputPath }),
    ...(payload.excludeFromContext === undefined
      ? {}
      : { excludeFromContext: payload.excludeFromContext }),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  if (!("status" in error)) {
    return undefined;
  }

  const status = error.status;
  return typeof status === "number" ? status : undefined;
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 425 || status === 429;
}

function formatRemoteError(error: unknown): string {
  const status = readErrorStatus(error);
  const message = readErrorMessage(error);
  if (status === undefined) {
    return message;
  }
  return `${message} (HTTP ${status})`;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getBackoffDelayMs(attempt: number): number {
  const factor = 2 ** Math.max(0, attempt - 1);
  return Math.min(500 * factor, 30_000);
}
