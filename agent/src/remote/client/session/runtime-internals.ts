import { SettingsManager } from "@mariozechner/pi-coding-agent";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { StreamEventEnvelope } from "../../schemas.js";
import {
  applyRemoteExtensionsSnapshot,
  applyRemoteSettingsSnapshot,
  cancelRemoteUiRequest,
  isAgentMessageLike,
  isAgentSessionEventLike,
  patchSettingsManagerForRemoteModelSettings,
  readRemoteSettingsSnapshot,
  readErrorMessage,
  resolveThinkingLevel,
} from "../session-deps.js";
import {
  applyRemoteAgentEventAndEmit,
  enqueueRemoteSessionMutation,
  handleRemoteSessionErrorBridge,
} from "../session-mutation-ops.js";
import {
  createRemoteSessionPollingInput,
  createRemoteSessionPollingStateHandlers,
  handleRemoteSessionEnvelope,
  pollRemoteSessionRuntime,
} from "./polling-ops.js";
import { RemoteAgentSessionSetupBase } from "./setup-base.js";

export abstract class RemoteAgentSessionRuntimeInternals extends RemoteAgentSessionSetupBase {
  async reload(): Promise<void> {
    await this.waitForPendingMutations();
    const snapshot = await this.client.getSessionSnapshot(this.sessionId);
    this.applyAuthoritativeCwdUpdate(snapshot.cwd);
    this.applyRemoteCatalogSnapshot(snapshot);
    applyRemoteSettingsSnapshot(this.remoteModelSettings, snapshot);
    this.remoteSettings = readRemoteSettingsSnapshot(snapshot);
    this.settingsManager = SettingsManager.inMemory(this.remoteSettings);
    patchSettingsManagerForRemoteModelSettings(
      this.settingsManager,
      () => this.remoteModelSettings,
    );
    this.remoteExtensions = applyRemoteExtensionsSnapshot(snapshot);
    this._thinkingLevel = resolveThinkingLevel(snapshot.thinkingLevel, this._thinkingLevel);
    this.state.thinkingLevel = this._thinkingLevel;
    this.setResolvedModel(snapshot.model);
    this.activeTools = [...snapshot.activeTools];
    await this.refreshRemoteToolCatalog();
    this.queueDepth = snapshot.queue.depth;
    this.sessionManager.appendSessionInfo(snapshot.sessionName);
  }

  protected async waitForPendingMutations(): Promise<void> {
    await this.mutationQueue;
  }

  dispose(): Promise<void> {
    this.closed = true;
    for (const pendingRequest of this.pendingInteractiveRequests.values()) {
      pendingRequest.abort();
    }
    this.pendingInteractiveRequests.clear();
    this.activeReadAbortController?.abort();
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
    await pollRemoteSessionRuntime(this.createPollingRuntimeInput());
  }

  protected async handleEnvelope(envelope: StreamEventEnvelope): Promise<void> {
    await handleRemoteSessionEnvelope(this.createPollingRuntimeInput(), envelope);
  }

  protected createPollingRuntimeInput(): Parameters<typeof pollRemoteSessionRuntime>[0] {
    return createRemoteSessionPollingInput({
      isClosed: () => this.closed,
      getStreamOffset: () => this.streamOffset,
      setStreamOffset: (offset) => {
        this.streamOffset = offset;
      },
      setActiveReadAbortController: (controller) => {
        this.activeReadAbortController = controller;
      },
      readSessionEvents: (options) =>
        this.client.readSessionEvents(this.sessionId, options.offset, {
          signal: options.signal,
          onEvent: options.onEvent,
          onControl: (control) => {
            options.onControl(control.nextOffset);
          },
        }),
      handleRemoteError: (message) => {
        this.handleRemoteError(message);
      },
      handleRemoteWarning: (message) => {
        this.handleRemoteWarning(message);
      },
      reauthenticate: () => this.client.reauthenticate(),
      isAgentSessionEventLike,
      readErrorMessage,
      applyAgentSessionEvent: (event) => {
        this.applyAgentSessionEvent(event);
      },
      handleEnvelope: async (envelope) => {
        await this.handleEnvelope(envelope);
      },
      remoteModelSettings: this.remoteModelSettings,
      stateHandlers: this.createPollingStateHandlers(),
      client: this.client,
      sessionId: this.sessionId,
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
      setSessionName: (sessionName) => {
        this.sessionManager.appendSessionInfo(sessionName);
      },
      setActiveTools: (activeTools) => {
        this.activeTools = [...activeTools];
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
      isAgentMessageLike,
      applyAgentSessionEvent: (event) => {
        this.applyAgentSessionEvent(event);
      },
    });
  }

  protected handleRemoteWarning(message: string): void {
    this.uiContext?.notify(message, "warning");
  }

  protected applyAgentSessionEvent(event: AgentSessionEvent): void {
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
      currentEmitQueue: this.emitQueue,
      setEmitQueue: (nextEmitQueue) => {
        this.emitQueue = nextEmitQueue;
      },
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
}
