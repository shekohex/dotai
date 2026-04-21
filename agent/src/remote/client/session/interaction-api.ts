import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@mariozechner/pi-ai";
import {
  abortRemoteSessionMethod,
  clearQueueRemoteSessionMethod,
  cycleModelRemoteSessionMethod,
  followUpRemoteSessionMethod,
  promptRemoteSessionMethod,
  sendUserMessageRemoteSessionMethod,
  setModelRemoteSessionMethod,
  setThinkingLevelRemoteSessionMethod,
  steerRemoteSessionMethod,
  waitForIdleRemoteSessionMethod,
} from "./command-methods-ops.js";
import { RemoteAgentSessionRuntimeInternals } from "./runtime-internals.js";
import { getAvailableThinkingLevelsRemoteSession } from "../session-ops.js";

export abstract class RemoteAgentSessionInteractionApi extends RemoteAgentSessionRuntimeInternals {
  async prompt(
    text: string,
    options?: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" },
  ): Promise<void> {
    if (text.startsWith("/") && (await this.tryExecuteLocalExtensionCommand(text))) {
      return;
    }

    await promptRemoteSessionMethod({
      waitForPendingMutations: () => this.waitForPendingMutations(),
      isStreaming: this.isStreaming,
      steer: (nextText, images) => this.steer(nextText, images),
      followUp: (nextText, images) => this.followUp(nextText, images),
      client: this.client,
      sessionId: this.sessionId,
      text,
      options,
    });
  }

  async steer(text: string, images?: ImageContent[]): Promise<void> {
    await steerRemoteSessionMethod({
      waitForPendingMutations: () => this.waitForPendingMutations(),
      client: this.client,
      sessionId: this.sessionId,
      text,
      images,
    });
  }

  async followUp(text: string, images?: ImageContent[]): Promise<void> {
    await followUpRemoteSessionMethod({
      waitForPendingMutations: () => this.waitForPendingMutations(),
      client: this.client,
      sessionId: this.sessionId,
      text,
      images,
    });
  }

  async sendUserMessage(
    content: string | (TextContent | ImageContent)[],
    options?: { deliverAs?: "steer" | "followUp" },
  ): Promise<void> {
    await sendUserMessageRemoteSessionMethod({
      waitForPendingMutations: () => this.waitForPendingMutations(),
      isStreaming: this.isStreaming,
      content,
      options,
      steer: (text, images) => this.steer(text, images),
      followUp: (text, images) => this.followUp(text, images),
      prompt: (text, promptOptions) => this.prompt(text, promptOptions),
    });
  }

  sendCustomMessage<T = unknown>(
    message: {
      customType: string;
      content: string | (TextContent | ImageContent)[];
      display: boolean;
      details?: T;
    },
    _options?: {
      triggerTurn?: boolean;
      deliverAs?: "steer" | "followUp" | "nextTurn";
    },
  ): Promise<void> {
    const messageEvent = {
      role: "custom" as const,
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
      timestamp: Date.now(),
    };

    this.applyAgentSessionEvent({
      type: "message_start",
      message: messageEvent,
    });
    this.applyAgentSessionEvent({
      type: "message_end",
      message: messageEvent,
    });
    return Promise.resolve();
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    return clearQueueRemoteSessionMethod({
      queuedSteeringMessages: this.queuedSteeringMessages,
      queuedFollowUpMessages: this.queuedFollowUpMessages,
      queueDepth: this.queueDepth,
      setQueueState: (state) => {
        this.queuedSteeringMessages = state.steering;
        this.queuedFollowUpMessages = state.followUp;
        this.queueDepth = state.queueDepth;
      },
      enqueueMutation: (execute, rollback, label) => {
        this.enqueueMutation(execute, rollback, label);
      },
      client: this.client,
      sessionId: this.sessionId,
    });
  }

  getSteeringMessages(): readonly string[] {
    return this.queuedSteeringMessages;
  }

  getFollowUpMessages(): readonly string[] {
    return this.queuedFollowUpMessages;
  }

  async waitForIdle(): Promise<void> {
    await waitForIdleRemoteSessionMethod({
      isStreaming: this.isStreaming,
      queueDepth: this.queueDepth,
      idleResolvers: this.idleResolvers,
    });
  }

  async abort(): Promise<void> {
    await abortRemoteSessionMethod({
      waitForPendingMutations: () => this.waitForPendingMutations(),
      client: this.client,
      sessionId: this.sessionId,
    });
  }

  async setModel(model: Model<Api>): Promise<void> {
    await setModelRemoteSessionMethod({
      client: this.client,
      sessionId: this.sessionId,
      model,
      setModelState: (nextModel) => {
        this._model = nextModel;
        this.state.model = nextModel;
      },
      setDefaultModel: (provider, modelId) => {
        this.remoteModelSettings.defaultProvider = provider;
        this.remoteModelSettings.defaultModel = modelId;
      },
    });
  }

  cycleModel(
    direction: "forward" | "backward" = "forward",
  ): Promise<{ model: Model<Api>; thinkingLevel: ThinkingLevel; isScoped: boolean } | undefined> {
    return cycleModelRemoteSessionMethod({
      modelRegistry: this.modelRegistry,
      model: this.model,
      direction,
      setModel: (nextModel) => this.setModel(nextModel),
      thinkingLevel: this.thinkingLevel,
    });
  }

  setThinkingLevel(level: ThinkingLevel): void {
    setThinkingLevelRemoteSessionMethod({
      level,
      previousThinkingLevel: this._thinkingLevel,
      modelRef: this.model ? `${this.model.provider}/${this.model.id}` : "unknown/unknown",
      setThinkingLevelState: (nextLevel) => {
        this._thinkingLevel = nextLevel;
        this.state.thinkingLevel = nextLevel;
      },
      enqueueMutation: (execute, rollback, label) => {
        this.enqueueMutation(execute, rollback, label);
      },
      client: this.client,
      sessionId: this.sessionId,
      setDefaultThinkingLevel: (thinkingLevel) => {
        this.remoteModelSettings.defaultThinkingLevel = thinkingLevel;
      },
    });
  }

  cycleThinkingLevel(): ThinkingLevel | undefined {
    const levels: ThinkingLevel[] = this.getAvailableThinkingLevels();
    if (levels.length === 0) {
      return undefined;
    }
    const index = levels.indexOf(this.thinkingLevel);
    const next = levels[(index + 1) % levels.length];
    if (next === undefined) {
      return undefined;
    }
    this.setThinkingLevel(next);
    return next;
  }

  getAvailableThinkingLevels(): ThinkingLevel[] {
    return getAvailableThinkingLevelsRemoteSession(this.model);
  }

  supportsThinking(): boolean {
    return Boolean(this.model?.reasoning);
  }

  supportsXhighThinking(): boolean {
    return this.supportsThinking();
  }
}
