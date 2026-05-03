import { createLocalBashOperations } from "@mariozechner/pi-coding-agent";
import { executeBashWithOperations } from "../../../node_modules/@mariozechner/pi-coding-agent/dist/core/bash-executor.js";
import type { AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import type { AuthSession } from "../auth.js";
import { readResourceLoaderEventBus } from "../event-bus-bridge.js";
import { appendAndPublish, sessionEventsStreamId } from "../streams.js";
import type {
  BashExecuteRequest,
  BashExecuteResponse,
  BashRecordRequest,
  BashRecordResponse,
  CompactRequest,
  CompactResponse,
  NavigateTreeRequest,
  NavigateTreeResponse,
  SessionSyncEvent,
  ToolDefinitionMetadata,
} from "../schemas.js";
import { RemoteError } from "../errors.js";
import type { JsonValue } from "../json-schema.js";
import { sanitizeBranchSummaryEntry, sanitizeCompactDetails } from "../schema-normalization.js";
import { SessionRegistryPromptCommands } from "./registry-prompt-commands.js";
import { serializeToolDefinition } from "./tool-definition-metadata.js";
import type { SessionRecord } from "./types.js";

function publishSessionSyncPatch(
  liveEvents: SessionRegistryRuntimeOps["liveEvents"],
  sessionId: string,
  event: Extract<SessionSyncEvent, { type: "patch" }>,
): void {
  liveEvents?.publishSessionSyncEvent(sessionId, event);
}

export class SessionRegistryRuntimeOps extends SessionRegistryPromptCommands {
  async emitSessionExtensionCustomEvent(
    sessionId: string,
    input: { channel: string; data: JsonValue },
    client: AuthSession,
    connectionId?: string,
  ): Promise<void> {
    const record = await this.ensureLoaded(sessionId);
    this.touchPresence(sessionId, client, connectionId);
    this.syncFromRuntime(record, { updateTimestamp: false, syncResources: true });
    const session = this.requireRuntimeSession(record);
    readResourceLoaderEventBus(session.resourceLoader)?.emit(input.channel, input.data);
  }

  async getSessionToolDefinition(
    sessionId: string,
    toolName: string,
    client: AuthSession,
    connectionId?: string,
  ): Promise<ToolDefinitionMetadata> {
    const record = await this.ensureLoaded(sessionId);
    this.touchPresence(sessionId, client, connectionId);
    this.syncFromRuntime(record, { updateTimestamp: false, syncResources: true });
    const session = this.getRuntimeSession(record);
    if (!session) {
      throw new RemoteError("Session runtime is unavailable", 409);
    }
    const tool = session.getAllTools().find((candidate) => candidate.name === toolName);
    const definition = serializeToolDefinition(
      session.getToolDefinition(toolName),
      tool?.sourceInfo,
    );
    if (!definition) {
      throw new RemoteError("Tool not found", 404);
    }
    return definition;
  }

  async navigateTree(
    sessionId: string,
    request: NavigateTreeRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<NavigateTreeResponse> {
    const record = await this.ensureLoaded(sessionId);
    this.touchPresence(sessionId, client, connectionId);
    const session = this.requireRuntimeSession(record);
    const result = await session.navigateTree(request.targetId, {
      summarize: request.summarize,
      customInstructions: request.customInstructions,
      replaceInstructions: request.replaceInstructions,
      label: request.label,
    });
    this.syncFromRuntime(record, { updateTimestamp: true, syncResources: true });
    const summaryEntry =
      result.summaryEntry === undefined
        ? undefined
        : sanitizeBranchSummaryEntry(result.summaryEntry);
    return {
      editorText: result.editorText,
      cancelled: result.cancelled,
      ...(result.aborted === undefined ? {} : { aborted: result.aborted }),
      ...(summaryEntry === undefined ? {} : { summaryEntry }),
      snapshot: this.toSessionSnapshot(record),
    };
  }

  async compactSession(
    sessionId: string,
    request: CompactRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CompactResponse> {
    const record = await this.ensureLoaded(sessionId);
    this.touchPresence(sessionId, client, connectionId);
    const session = this.requireRuntimeSession(record);
    const result = await session.compact(request.customInstructions);
    this.syncFromRuntime(record, { updateTimestamp: true, syncResources: true });
    const details = sanitizeCompactDetails(result.details);
    return {
      summary: result.summary,
      firstKeptEntryId: result.firstKeptEntryId,
      tokensBefore: result.tokensBefore,
      ...(details === undefined ? {} : { details }),
      snapshot: this.toSessionSnapshot(record),
    };
  }

  async abortCompaction(
    sessionId: string,
    client: AuthSession,
    connectionId?: string,
  ): Promise<void> {
    const record = await this.ensureLoaded(sessionId);
    this.touchPresence(sessionId, client, connectionId);
    this.requireRuntimeSession(record).abortCompaction();
    this.syncFromRuntime(record, { updateTimestamp: true, syncResources: false });
  }

  async executeBash(
    sessionId: string,
    request: BashExecuteRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<BashExecuteResponse> {
    const record = await this.ensureLoaded(sessionId);
    this.touchPresence(sessionId, client, connectionId);
    const session = this.requireRuntimeSession(record);
    const executionId = `bash-${this.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.appendBashStartEvent(record, executionId, request);
    this.syncFromRuntime(record, { updateTimestamp: true, syncResources: false });
    this.appendBashStatePatch(record);
    const chunks: string[] = [];
    const result = await this.executeRuntimeBash(session, request, (chunk) => {
      chunks.push(chunk);
      this.appendBashChunkEvent(record, executionId, chunk, request.clientRequestId);
    });
    this.syncFromRuntime(record, { updateTimestamp: true, syncResources: true });
    this.appendBashEndEvent(record, executionId, request, result);
    this.appendBashStatePatch(record);
    return {
      ...result,
      chunks,
      clientRequestId: request.clientRequestId,
      snapshot: this.toSessionSnapshot(record),
    };
  }

  private async executeRuntimeBash(
    session: NonNullable<AgentSessionRuntime["session"]>,
    request: BashExecuteRequest,
    onChunk: (chunk: string) => void,
  ): Promise<Omit<BashExecuteResponse, "snapshot" | "clientRequestId">> {
    if (request.timeout === undefined || !supportsDirectTimedBashExecution(session)) {
      return session.executeBash(request.command, onChunk, {
        excludeFromContext: request.excludeFromContext,
      });
    }

    const bashAbortController = new AbortController();
    Reflect.set(session, "_bashAbortController", bashAbortController);
    const shellPath = session.settingsManager.getShellPath();
    const commandPrefix = session.settingsManager.getShellCommandPrefix();
    const resolvedCommand =
      commandPrefix !== undefined && commandPrefix.length > 0
        ? `${commandPrefix}\n${request.command}`
        : request.command;
    const localBashOperations = createLocalBashOperations({ shellPath });

    try {
      const result = await executeBashWithOperations(
        resolvedCommand,
        session.sessionManager.getCwd(),
        {
          exec: (command, cwd, options) =>
            localBashOperations.exec(command, cwd, {
              ...options,
              timeout: request.timeout,
            }),
        },
        {
          onChunk,
          signal: bashAbortController.signal,
        },
      ).catch((error: unknown) => {
        if (error instanceof Error && error.message.startsWith("timeout:")) {
          throw new Error(`Command timed out after ${request.timeout} seconds`, { cause: error });
        }
        throw error;
      });
      session.recordBashResult(request.command, result, {
        excludeFromContext: request.excludeFromContext,
      });
      return result;
    } finally {
      Reflect.set(session, "_bashAbortController", undefined);
    }
  }

  async abortBash(sessionId: string, client: AuthSession, connectionId?: string): Promise<void> {
    const record = await this.ensureLoaded(sessionId);
    this.touchPresence(sessionId, client, connectionId);
    this.requireRuntimeSession(record).abortBash();
    this.syncFromRuntime(record, { updateTimestamp: true, syncResources: false });
  }

  async recordBashResult(
    sessionId: string,
    request: BashRecordRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<BashRecordResponse> {
    const record = await this.ensureLoaded(sessionId);
    this.touchPresence(sessionId, client, connectionId);
    const session = this.requireRuntimeSession(record);
    const bashResult = {
      output: request.result.output,
      exitCode: request.result.exitCode,
      cancelled: request.result.cancelled,
      truncated: request.result.truncated,
      ...(request.result.fullOutputPath === undefined
        ? {}
        : { fullOutputPath: request.result.fullOutputPath }),
    };
    session.recordBashResult(request.command, bashResult, {
      excludeFromContext: request.excludeFromContext,
    });
    this.syncFromRuntime(record, { updateTimestamp: true, syncResources: true });
    this.appendBashStatePatch(record);
    return {
      snapshot: this.toSessionSnapshot(record),
    };
  }

  private appendBashStartEvent(
    record: Parameters<typeof this.toSessionSnapshot>[0],
    executionId: string,
    request: BashExecuteRequest,
  ): void {
    const payload = {
      executionId,
      command: request.command,
      clientRequestId: request.clientRequestId,
      excludeFromContext: request.excludeFromContext,
    };
    appendAndPublish(this.streams, this.liveEvents, sessionEventsStreamId(record.sessionId), {
      sessionId: record.sessionId,
      kind: "bash_start",
      sessionVersion: String(record.lastDurableSessionVersion),
      payload,
      ts: this.now(),
    });
    publishSessionSyncPatch(this.liveEvents, record.sessionId, {
      type: "patch",
      sessionId: record.sessionId,
      version: String(record.lastDurableSessionVersion),
      patch: { patchType: "bash.start", payload },
    });
  }

  private appendBashChunkEvent(
    record: Parameters<typeof this.toSessionSnapshot>[0],
    executionId: string,
    chunk: string,
    clientRequestId?: string,
  ): void {
    const payload = {
      executionId,
      chunk,
      clientRequestId,
    };
    appendAndPublish(this.streams, this.liveEvents, sessionEventsStreamId(record.sessionId), {
      sessionId: record.sessionId,
      kind: "bash_chunk",
      sessionVersion: String(record.lastDurableSessionVersion),
      payload,
      ts: this.now(),
    });
    publishSessionSyncPatch(this.liveEvents, record.sessionId, {
      type: "patch",
      sessionId: record.sessionId,
      version: String(record.lastDurableSessionVersion),
      patch: { patchType: "bash.chunk", payload },
    });
  }

  private appendBashEndEvent(
    record: Parameters<typeof this.toSessionSnapshot>[0],
    executionId: string,
    request: BashExecuteRequest,
    result: Omit<BashExecuteResponse, "snapshot" | "clientRequestId">,
  ): void {
    const bashMessage = readLastBashExecutionMessage(record.transcript);
    const payload = {
      executionId,
      clientRequestId: request.clientRequestId,
      result,
      deferredUntilTurnEnd: record.hasPendingBashMessages,
      ...(bashMessage ? { message: bashMessage } : {}),
    };
    appendAndPublish(this.streams, this.liveEvents, sessionEventsStreamId(record.sessionId), {
      sessionId: record.sessionId,
      kind: "bash_end",
      sessionVersion: String(record.lastDurableSessionVersion),
      payload,
      ts: this.now(),
    });
    publishSessionSyncPatch(this.liveEvents, record.sessionId, {
      type: "patch",
      sessionId: record.sessionId,
      version: String(record.lastDurableSessionVersion),
      patch: { patchType: "bash.end", payload },
    });
  }

  private appendBashStatePatch(record: Parameters<typeof this.toSessionSnapshot>[0]): void {
    const payload = {
      commandId: "server-state-sync",
      sequence: record.queue.nextSequence,
      patch: {
        isBashRunning: record.isBashRunning,
        hasPendingBashMessages: record.hasPendingBashMessages,
        sessionStats: {
          ...record.sessionStats,
          tokens: {
            input: record.sessionStats.tokens.input,
            output: record.sessionStats.tokens.output,
            cacheRead: record.sessionStats.tokens.cacheRead,
            cacheWrite: record.sessionStats.tokens.cacheWrite,
            total: record.sessionStats.tokens.total,
          },
          ...(record.sessionStats.contextUsage
            ? { contextUsage: { ...record.sessionStats.contextUsage } }
            : {}),
        },
      },
    };
    appendAndPublish(this.streams, this.liveEvents, sessionEventsStreamId(record.sessionId), {
      sessionId: record.sessionId,
      kind: "session_state_patch",
      sessionVersion: String(record.lastDurableSessionVersion),
      payload,
      ts: this.now(),
    });
    publishSessionSyncPatch(this.liveEvents, record.sessionId, {
      type: "patch",
      sessionId: record.sessionId,
      version: String(record.lastDurableSessionVersion),
      patch: { patchType: "session.state", payload },
    });
  }
}

function readLastBashExecutionMessage(
  transcript: SessionRecord["transcript"],
): Extract<SessionRecord["transcript"][number], { role: "bashExecution" }> | undefined {
  const lastMessage = transcript.at(-1);
  if (!lastMessage || lastMessage.role !== "bashExecution") {
    return undefined;
  }
  return lastMessage;
}

function supportsDirectTimedBashExecution(
  session: NonNullable<AgentSessionRuntime["session"]>,
): session is NonNullable<AgentSessionRuntime["session"]> & {
  sessionManager: { getCwd: () => string };
  settingsManager: {
    getShellPath: () => string | undefined;
    getShellCommandPrefix: () => string | undefined;
  };
  recordBashResult: NonNullable<AgentSessionRuntime["session"]>["recordBashResult"];
} {
  return (
    typeof session === "object" &&
    session !== null &&
    typeof session.sessionManager?.getCwd === "function" &&
    typeof session.settingsManager?.getShellPath === "function" &&
    typeof session.settingsManager?.getShellCommandPrefix === "function" &&
    typeof session.recordBashResult === "function"
  );
}
