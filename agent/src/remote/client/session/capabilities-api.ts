import type { SessionStats } from "@mariozechner/pi-coding-agent";
import {
  getAllToolsRemoteSession,
  getLastAssistantTextRemoteSession,
  getSessionStatsRemoteSession,
} from "../session-ops.js";
import { setSessionNameRemoteSessionMethod } from "./command-methods-ops.js";
import { RemoteAgentSessionInteractionApi } from "./interaction-api.js";

export abstract class RemoteAgentSessionCapabilitiesApi extends RemoteAgentSessionInteractionApi {
  setSteeringMode(mode: "all" | "one-at-a-time"): void {
    this._steeringMode = mode;
  }

  setFollowUpMode(mode: "all" | "one-at-a-time"): void {
    this._followUpMode = mode;
  }

  compact(_customInstructions?: string): Promise<never> {
    return Promise.reject(new Error("Compaction is not supported by remote adapter yet"));
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
    return getSessionStatsRemoteSession({
      sessionId: this.sessionId,
      messages: this.state.messages,
    });
  }

  getContextUsage(): undefined {
    return undefined;
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
    return getAllToolsRemoteSession(this.activeTools);
  }

  getToolDefinition(_name: string): undefined {
    return undefined;
  }

  setActiveToolsByName(toolNames: string[]): void {
    this.activeTools = [...toolNames];
  }
}
