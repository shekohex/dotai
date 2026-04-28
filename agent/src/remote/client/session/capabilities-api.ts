import type { AgentSession, SessionStats } from "@mariozechner/pi-coding-agent";
import { SessionSnapshotSchema } from "../../schemas.js";
import { assertType } from "../../typebox.js";
import { getAllToolsRemoteSession, getLastAssistantTextRemoteSession } from "../session-ops.js";
import {
  setActiveToolsRemoteSessionMethod,
  setSessionNameRemoteSessionMethod,
} from "./command-methods-ops.js";
import { buildRemoteToolDefinition } from "./remote-tool-definitions.js";
import { RemoteAgentSessionInteractionApi } from "./interaction-api.js";

export abstract class RemoteAgentSessionCapabilitiesApi extends RemoteAgentSessionInteractionApi {
  private surfaceAsyncAbortFailure(action: "compaction" | "bash", error: unknown): void {
    this.handleRemoteError(
      error instanceof Error ? error.message : `Failed to abort remote ${action}`,
    );
  }

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

  async compact(
    customInstructions?: Parameters<AgentSession["compact"]>[0],
  ): ReturnType<AgentSession["compact"]> {
    const result = await this.client.compactSession(this.sessionId, { customInstructions });
    if (result.snapshot !== undefined) {
      assertType(SessionSnapshotSchema, result.snapshot);
      this.applySnapshot(result.snapshot);
    }
    return {
      summary: result.summary,
      firstKeptEntryId: result.firstKeptEntryId,
      tokensBefore: result.tokensBefore,
      details: result.details,
    };
  }

  abortCompaction(): void {
    void this.client.abortCompaction(this.sessionId).catch((error: unknown) => {
      this.surfaceAsyncAbortFailure("compaction", error);
    });
  }

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
    command: string,
    onChunk?: (chunk: string) => void,
    options?: {
      excludeFromContext?: boolean;
      operations?: unknown;
    },
  ): ReturnType<AgentSession["executeBash"]> {
    if (options?.operations !== undefined) {
      return Promise.reject(
        new Error("Remote adapter does not support custom bash operations transport"),
      );
    }
    const clientRequestId = `bash-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.activeBashRequests.set(clientRequestId, { onChunk });
    this._isBashRunning = true;
    return this.client
      .executeBash(this.sessionId, {
        command,
        excludeFromContext: options?.excludeFromContext,
        clientRequestId,
      })
      .then((result) => {
        if (result.snapshot !== undefined) {
          assertType(SessionSnapshotSchema, result.snapshot);
          this.applySnapshot(result.snapshot);
        }
        return {
          output: result.output,
          exitCode: result.exitCode,
          cancelled: result.cancelled,
          truncated: result.truncated,
          fullOutputPath: result.fullOutputPath,
        };
      })
      .finally(() => {
        this.activeBashRequests.delete(clientRequestId);
        this._isBashRunning = false;
      });
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
    void this.client
      .recordBashResult(this.sessionId, {
        command,
        result,
        excludeFromContext: options?.excludeFromContext,
      })
      .then((response) => {
        if (response.snapshot !== undefined) {
          assertType(SessionSnapshotSchema, response.snapshot);
          this.applySnapshot(response.snapshot);
        }
      })
      .catch((error: unknown) => {
        this.handleRemoteError(
          error instanceof Error ? error.message : "Failed to record remote bash result",
        );
      });
  }

  abortBash(): void {
    void this.client.abortBash(this.sessionId).catch((error: unknown) => {
      this.surfaceAsyncAbortFailure("bash", error);
    });
  }

  get isBashRunning(): boolean {
    return this._isBashRunning;
  }

  get hasPendingBashMessages(): boolean {
    return this._hasPendingBashMessages;
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
    targetId: string,
    options?: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    },
  ): ReturnType<AgentSession["navigateTree"]> {
    return this.client
      .navigateTree(this.sessionId, {
        targetId,
        summarize: options?.summarize,
        customInstructions: options?.customInstructions,
        replaceInstructions: options?.replaceInstructions,
        label: options?.label,
      })
      .then(async (result) => {
        if (result.snapshot === undefined) {
          await this.reload();
        } else {
          assertType(SessionSnapshotSchema, result.snapshot);
          this.applySnapshot(result.snapshot);
          await this.refreshRemoteToolCatalog();
          await this.refreshForkMessages();
          await this.replayLocalExtensionReloadLifecycle();
        }
        return {
          editorText: result.editorText,
          cancelled: result.cancelled,
          aborted: result.aborted,
          summaryEntry: result.summaryEntry,
        };
      });
  }

  getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
    return this.forkMessages.map((message) => ({ ...message }));
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

  hasExtensionHandlers(eventType: string): boolean {
    return this.localExtensionRunner.hasHandlers(eventType);
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
    const localDefinition = this.localExtensionRunner.getToolDefinition(name);
    if (localDefinition) {
      return localDefinition;
    }
    const remoteDefinition = this.getRemoteToolDefinition(name);
    return remoteDefinition ? buildRemoteToolDefinition(remoteDefinition) : undefined;
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
