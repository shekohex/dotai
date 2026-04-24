import type { SessionStats } from "@mariozechner/pi-coding-agent";
import { getAllToolsRemoteSession, getLastAssistantTextRemoteSession } from "../session-ops.js";
import {
  setActiveToolsRemoteSessionMethod,
  setSessionNameRemoteSessionMethod,
} from "./command-methods-ops.js";
import { RemoteAgentSessionInteractionApi } from "./interaction-api.js";

export abstract class RemoteAgentSessionCapabilitiesApi extends RemoteAgentSessionInteractionApi {
  setSteeringMode(mode: "all" | "one-at-a-time"): void {
    const previousMode = this._steeringMode;
    this._steeringMode = mode;
    this.enqueueMutation(
      () => this.client.updateSettings(this.sessionId, { method: "setSteeringMode", args: [mode] }),
      () => {
        this._steeringMode = previousMode;
      },
      "Update remote settings",
    );
  }

  setFollowUpMode(mode: "all" | "one-at-a-time"): void {
    const previousMode = this._followUpMode;
    this._followUpMode = mode;
    this.enqueueMutation(
      () => this.client.updateSettings(this.sessionId, { method: "setFollowUpMode", args: [mode] }),
      () => {
        this._followUpMode = previousMode;
      },
      "Update remote settings",
    );
  }

  compact(_customInstructions?: string): Promise<never> {
    return Promise.reject(new Error("Compaction is not supported by remote adapter yet"));
  }

  abortCompaction(): void {}

  abortBranchSummary(): void {}

  setAutoCompactionEnabled(enabled: boolean): void {
    const previousEnabled = this._autoCompactionEnabled;
    this._autoCompactionEnabled = enabled;
    this.enqueueMutation(
      () =>
        this.client.updateSettings(this.sessionId, {
          method: "setAutoCompactionEnabled",
          args: [enabled],
        }),
      () => {
        this._autoCompactionEnabled = previousEnabled;
      },
      "Update remote settings",
    );
  }

  setAutoRetryEnabled(enabled: boolean): void {
    this._autoRetryEnabled = enabled;
  }

  abortRetry(): void {}

  executeBash(
    _command: string,
    _onChunk?: (chunk: string) => void,
    _options?: {
      excludeFromContext?: boolean;
      operations?: unknown;
    },
  ): Promise<never> {
    return Promise.reject(
      new Error("Direct local bash execution is not supported by remote adapter"),
    );
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
    setSessionNameRemoteSessionMethod({
      name,
      previousName: this.sessionManager.getSessionName(),
      setSessionNameState: (nextName) => {
        this.sessionManager.appendSessionInfo(nextName);
      },
      enqueueMutation: (execute, rollback, label) => {
        this.enqueueMutation(execute, rollback, label);
      },
      client: this.client,
      sessionId: this.sessionId,
    });
  }

  navigateTree(
    _targetId: string,
    _options?: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    },
  ): Promise<{ cancelled: boolean }> {
    return Promise.resolve({ cancelled: true });
  }

  getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
    return [];
  }

  getSessionStats(): SessionStats {
    return cloneSessionStats(this.state.sessionStats);
  }

  getContextUsage() {
    return this.state.contextUsage;
  }

  exportToHtml(_outputPath?: string): Promise<never> {
    return Promise.reject(new Error("Export is not supported by remote adapter"));
  }

  exportToJsonl(_outputPath?: string): string {
    throw new Error("Export is not supported by remote adapter");
  }

  getLastAssistantText(): string | undefined {
    return getLastAssistantTextRemoteSession(this.state.messages);
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
    return this.allTools.length > 0
      ? [...this.allTools]
      : getAllToolsRemoteSession(this.activeTools);
  }

  getToolDefinition(name: string) {
    return this.localExtensionRunner.getToolDefinition(name);
  }

  setActiveToolsByName(toolNames: string[]): void {
    setActiveToolsRemoteSessionMethod({
      toolNames: [...toolNames],
      previousToolNames: [...this.activeTools],
      setActiveToolsState: (nextTools) => {
        this.activeTools = [...nextTools];
      },
      enqueueMutation: (execute, rollback, label) => {
        this.enqueueMutation(execute, rollback, label);
      },
      client: this.client,
      sessionId: this.sessionId,
    });
  }
}

function cloneSessionStats(stats: SessionStats): SessionStats {
  return {
    ...stats,
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
