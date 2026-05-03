import type { MiddlewareHandler } from "hono";
import type { JsonValue } from "../json-schema.js";
import {
  readRemoteExtensionSyncInfo,
  readSessionSyncPatchReplaceKey,
} from "../session-sync-metadata.js";
import { SessionSyncEventSchema, type SessionSyncEvent } from "../schemas.js";
import { applyToolPartialPatch, readToolOutputText } from "../tool-output-text.js";
import { RemoteError } from "../errors.js";
import { compareSessionVersions } from "../session-sync-patch-events.js";
import { assertType } from "../typebox.js";
import { authError } from "./auth.js";
import type { RemoteHonoEnv, RemoteRoutesDependencies } from "./types.js";

type HonoContext = Parameters<MiddlewareHandler<RemoteHonoEnv>>[0];

const MAX_PRE_SNAPSHOT_PATCH_EVENTS = 128;
const HEARTBEAT_INTERVAL_MS = 15_000;

function sseChunk(payload: SessionSyncEvent): string {
  return `event: data\ndata: ${JSON.stringify(payload)}\n\n`;
}

function buildHeaders(connectionId: string): Record<string, string> {
  return {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-pi-connection-id": connectionId,
  };
}

function getConnectionId(c: HonoContext): string {
  const providedConnectionId = c.req.header("x-pi-connection-id")?.trim();
  if (providedConnectionId !== undefined && providedConnectionId.length > 0) {
    return providedConnectionId;
  }
  return c.get("auth").token;
}

export async function handleSessionSync(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
): Promise<Response> {
  let unsubscribe: (() => void) | undefined;
  let connectionId: string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    connectionId = getConnectionId(c);
    dependencies.sessions.touchPresence(sessionId, c.get("auth"), connectionId);
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const bufferedPatchEvents: SessionSyncEvent[] = [];
    const bufferedPatchEventIndexesByKey = new Map<string, number>();

    const enqueuePatchEvent = (patchEvent: SessionSyncEvent): void => {
      if (controller === undefined) {
        bufferPatchEvent(bufferedPatchEvents, bufferedPatchEventIndexesByKey, patchEvent);
        return;
      }

      controller.enqueue(encoder.encode(sseChunk(patchEvent)));
    };

    unsubscribe = dependencies.liveEvents.subscribeSessionSyncEvent(sessionId, (event) => {
      assertType(SessionSyncEventSchema, event);
      enqueuePatchEvent(event);
    });

    const snapshot = await dependencies.sessions.loadSessionSnapshot(
      sessionId,
      c.get("auth"),
      connectionId,
    );

    const connectedPayload: SessionSyncEvent = {
      type: "server.connected",
      sessionId,
    };
    const snapshotPayload: SessionSyncEvent = {
      type: "snapshot",
      sessionId,
      version: snapshot.version,
      snapshot,
    };
    assertType(SessionSyncEventSchema, connectedPayload);
    assertType(SessionSyncEventSchema, snapshotPayload);

    const body = new ReadableStream<Uint8Array>({
      start(activeController) {
        controller = activeController;
        activeController.enqueue(encoder.encode(sseChunk(connectedPayload)));
        activeController.enqueue(encoder.encode(sseChunk(snapshotPayload)));
        heartbeat = setInterval(() => {
          if (controller === undefined) {
            return;
          }
          controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
        }, HEARTBEAT_INTERVAL_MS);
        for (const bufferedPatchEvent of bufferedPatchEvents) {
          if (isPatchCoveredBySnapshot(bufferedPatchEvent, snapshot)) {
            continue;
          }
          activeController.enqueue(encoder.encode(sseChunk(bufferedPatchEvent)));
        }
        bufferedPatchEvents.length = 0;
      },
      cancel() {
        if (heartbeat !== undefined) {
          clearInterval(heartbeat);
        }
        unsubscribe?.();
        controller = undefined;
        if (connectionId !== undefined) {
          detachPresenceIfPresent(dependencies, sessionId, connectionId);
        }
      },
    });

    return new Response(body, { headers: buildHeaders(connectionId) });
  } catch (error) {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
    }
    unsubscribe?.();
    if (connectionId !== undefined) {
      detachPresenceIfPresent(dependencies, sessionId, connectionId);
    }
    return authError(c, error);
  }
}

function detachPresenceIfPresent(
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
  connectionId: string,
): void {
  try {
    dependencies.sessions.detachPresence(sessionId, connectionId);
  } catch (error) {
    if (error instanceof RemoteError && error.status === 404) {
      return;
    }
    throw error;
  }
}

export function bufferPatchEvent(
  bufferedPatchEvents: SessionSyncEvent[],
  bufferedPatchEventIndexesByKey: Map<string, number>,
  patchEvent: SessionSyncEvent,
): void {
  const replaceKey = readBufferedPatchReplaceKey(patchEvent);
  if (replaceKey !== undefined) {
    const existingIndex = bufferedPatchEventIndexesByKey.get(replaceKey);
    if (existingIndex !== undefined) {
      bufferedPatchEvents[existingIndex] = patchEvent;
      return;
    }
  }

  bufferedPatchEvents.push(patchEvent);
  if (replaceKey !== undefined) {
    bufferedPatchEventIndexesByKey.set(replaceKey, bufferedPatchEvents.length - 1);
  }

  if (bufferedPatchEvents.length <= MAX_PRE_SNAPSHOT_PATCH_EVENTS) {
    return;
  }

  bufferedPatchEvents.shift();
  rebuildBufferedPatchEventIndexes(bufferedPatchEvents, bufferedPatchEventIndexesByKey);
}

function rebuildBufferedPatchEventIndexes(
  bufferedPatchEvents: SessionSyncEvent[],
  bufferedPatchEventIndexesByKey: Map<string, number>,
): void {
  bufferedPatchEventIndexesByKey.clear();
  for (const [index, bufferedPatchEvent] of bufferedPatchEvents.entries()) {
    const replaceKey = readBufferedPatchReplaceKey(bufferedPatchEvent);
    if (replaceKey !== undefined) {
      bufferedPatchEventIndexesByKey.set(replaceKey, index);
    }
  }
}

export function isPatchCoveredBySnapshot(
  patchEvent: SessionSyncEvent,
  snapshot: Extract<SessionSyncEvent, { type: "snapshot" }>["snapshot"],
): boolean {
  if (
    patchEvent.type !== "patch" ||
    compareSessionVersions(patchEvent.version, snapshot.version) > 0
  ) {
    return false;
  }

  switch (patchEvent.patch.patchType) {
    case "assistant.message":
      return isAssistantMessagePatchCoveredBySnapshot(patchEvent.patch.payload, snapshot);
    case "tool.execution":
      return isToolExecutionPatchCoveredBySnapshot(patchEvent.patch.payload, snapshot);
    case "queue.update":
      return (
        arraysEqual(snapshot.live.queuedSteeringMessages, patchEvent.patch.payload.steering) &&
        arraysEqual(snapshot.live.queuedFollowUpMessages, patchEvent.patch.payload.followUp)
      );
    case "retry.status":
      return isRetryStatusPatchCoveredBySnapshot(patchEvent.patch.payload, snapshot);
    case "compaction.status":
      return isCompactionStatusPatchCoveredBySnapshot(patchEvent.patch.payload, snapshot);
    case "agent.lifecycle":
      return true;
    case "extension.custom": {
      const patchSyncInfo = readRemoteExtensionSyncInfo(
        patchEvent.patch.payload.channel,
        patchEvent.patch.payload.data,
      );
      if (patchSyncInfo.sync !== "durable") {
        return false;
      }

      return true;
    }
    case "bash.chunk":
    case "bash.end":
    case "bash.flush":
    case "bash.start":
    case "command.accepted":
    case "extension.error":
    case "extension.event":
    case "extension.ui.request":
    case "extension.ui.resolved":
    case "session.state":
      return true;
  }

  return false;
}

function isToolExecutionPatchCoveredBySnapshot(
  payload: Extract<
    Extract<SessionSyncEvent, { type: "patch" }>["patch"],
    { patchType: "tool.execution" }
  >["payload"],
  snapshot: Extract<SessionSyncEvent, { type: "snapshot" }>["snapshot"],
): boolean {
  const activeExecution = snapshot.live.activeToolExecutions.find(
    (execution) => execution.toolCallId === payload.toolCallId,
  );

  if (payload.type === "tool_execution_end") {
    return activeExecution === undefined && !snapshot.pendingToolCalls.includes(payload.toolCallId);
  }

  if (payload.type === "tool_execution_start") {
    if (activeExecution !== undefined) {
      return (
        activeExecution.toolName === payload.toolName &&
        serializedSyncValue(activeExecution.args) === serializedSyncValue(payload.args)
      );
    }

    return !snapshot.pendingToolCalls.includes(payload.toolCallId);
  }

  if (payload.type === "tool_execution_output_delta") {
    if (activeExecution === undefined) {
      return !snapshot.pendingToolCalls.includes(payload.toolCallId);
    }

    return toolOutputDeltaCoveredBySnapshot(
      activeExecution.partialResult,
      payload.delta,
      payload.start,
    );
  }

  if (payload.type === "tool_execution_partial_patch") {
    if (activeExecution === undefined) {
      return !snapshot.pendingToolCalls.includes(payload.toolCallId);
    }

    const patchedResult = applyToolPartialPatch(activeExecution.partialResult, payload.ops);
    return (
      patchedResult !== undefined &&
      serializedSyncValue(activeExecution.partialResult) === serializedSyncValue(patchedResult)
    );
  }

  if (activeExecution !== undefined) {
    return (
      serializedSyncValue(activeExecution.partialResult) ===
      serializedSyncValue(payload.partialResult)
    );
  }

  return !snapshot.pendingToolCalls.includes(payload.toolCallId);
}

function toolOutputDeltaCoveredBySnapshot(
  partialResult: JsonValue | undefined,
  delta: string,
  start: number,
): boolean {
  const text = readToolOutputText(partialResult);
  return text !== undefined && text.slice(start, start + delta.length) === delta;
}

function isAssistantMessagePatchCoveredBySnapshot(
  payload: Extract<
    Extract<SessionSyncEvent, { type: "patch" }>["patch"],
    { patchType: "assistant.message" }
  >["payload"],
  snapshot: Extract<SessionSyncEvent, { type: "snapshot" }>["snapshot"],
): boolean {
  if (snapshot.live.streamingMessage !== undefined) {
    return assistantMessageEventCoveredBySnapshot(
      snapshot.live.streamingMessage,
      payload.assistantMessageEvent,
    );
  }

  const assistantMessageEvent = payload.assistantMessageEvent;
  return (
    assistantMessageEvent.type === "done" ||
    assistantMessageEvent.type === "error" ||
    snapshot.streamingState !== "streaming"
  );
}

function readAssistantPatchMessage(
  payload: Extract<
    Extract<SessionSyncEvent, { type: "patch" }>["patch"],
    { patchType: "assistant.message" }
  >["payload"],
): ReturnType<typeof readAssistantPatchEventMessage> {
  return readAssistantPatchEventMessage(payload.assistantMessageEvent);
}

function readAssistantPatchEventMessage(
  event: Extract<
    Extract<SessionSyncEvent, { type: "patch" }>["patch"],
    { patchType: "assistant.message" }
  >["payload"]["assistantMessageEvent"],
): Extract<SessionSyncEvent, { type: "snapshot" }>["snapshot"]["live"]["streamingMessage"] | null {
  switch (event.type) {
    case "start":
      return event.partial;
    case "toolcall_start":
    case "toolcall_delta":
      return null;
    case "done":
      return event.message;
    case "error":
      return event.error;
    case "text_start":
    case "text_delta":
    case "text_end":
    case "thinking_start":
    case "thinking_delta":
    case "thinking_end":
    case "toolcall_end":
      return null;
    default:
      throw new Error("Unsupported assistant patch message event");
  }
}

function assistantMessageEventCoveredBySnapshot(
  snapshotMessage: Extract<
    SessionSyncEvent,
    { type: "snapshot" }
  >["snapshot"]["live"]["streamingMessage"],
  patchEvent: Extract<
    Extract<SessionSyncEvent, { type: "patch" }>["patch"],
    { patchType: "assistant.message" }
  >["payload"]["assistantMessageEvent"],
): boolean {
  if (snapshotMessage === undefined) {
    return false;
  }

  const snapshotBlock =
    "contentIndex" in patchEvent ? snapshotMessage.content[patchEvent.contentIndex] : undefined;

  switch (patchEvent.type) {
    case "start":
      return assistantMessageCovers(snapshotMessage, patchEvent.partial);
    case "text_start":
      return snapshotBlock?.type === "text";
    case "text_delta":
      return (
        snapshotBlock?.type === "text" &&
        snapshotBlock.text.slice(patchEvent.start, patchEvent.start + patchEvent.delta.length) ===
          patchEvent.delta
      );
    case "text_end":
      return snapshotBlock?.type === "text" && snapshotBlock.text === patchEvent.content;
    case "thinking_start":
      return snapshotBlock?.type === "thinking";
    case "thinking_delta":
      return (
        snapshotBlock?.type === "thinking" &&
        snapshotBlock.thinking.slice(
          patchEvent.start,
          patchEvent.start + patchEvent.delta.length,
        ) === patchEvent.delta
      );
    case "thinking_end":
      return snapshotBlock?.type === "thinking" && snapshotBlock.thinking === patchEvent.content;
    case "toolcall_start":
      return (
        snapshotBlock?.type === "toolCall" &&
        serializedSyncValue(snapshotBlock) === serializedSyncValue(patchEvent.toolCall)
      );
    case "toolcall_delta":
      return (
        snapshotBlock?.type === "toolCall" &&
        serializedSyncValue(snapshotBlock) === serializedSyncValue(patchEvent.toolCall)
      );
    case "toolcall_end":
      return (
        snapshotBlock?.type === "toolCall" &&
        serializedSyncValue(snapshotBlock) === serializedSyncValue(patchEvent.toolCall)
      );
    case "done":
      return false;
    case "error":
      return false;
    default:
      return false;
  }
}

function readBufferedPatchReplaceKey(patchEvent: SessionSyncEvent): string | undefined {
  if (patchEvent.type !== "patch") {
    return undefined;
  }

  const replaceKey = readSessionSyncPatchReplaceKey(patchEvent.patch);
  if (replaceKey !== undefined) {
    return replaceKey;
  }

  if (patchEvent.patch.patchType !== "extension.custom") {
    return undefined;
  }

  const syncInfo = readRemoteExtensionSyncInfo(
    patchEvent.patch.payload.channel,
    patchEvent.patch.payload.data,
  );
  if (syncInfo.sync !== "replaceable") {
    return undefined;
  }

  return `extension_custom_event:${syncInfo.stateKey}`;
}

function isRetryStatusPatchCoveredBySnapshot(
  payload: Extract<
    Extract<SessionSyncEvent, { type: "patch" }>["patch"],
    { patchType: "retry.status" }
  >["payload"],
  snapshot: Extract<SessionSyncEvent, { type: "snapshot" }>["snapshot"],
): boolean {
  if (payload.type === "auto_retry_start") {
    if (snapshot.retry.status === "running") {
      return snapshot.live.retryAttempt === payload.attempt;
    }
    return snapshot.live.retryAttempt >= payload.attempt;
  }

  return snapshot.retry.status !== "running" && snapshot.live.retryAttempt === payload.attempt;
}

function isCompactionStatusPatchCoveredBySnapshot(
  payload: Extract<
    Extract<SessionSyncEvent, { type: "patch" }>["patch"],
    { patchType: "compaction.status" }
  >["payload"],
  snapshot: Extract<SessionSyncEvent, { type: "snapshot" }>["snapshot"],
): boolean {
  if (payload.type === "compaction_start") {
    return snapshot.compaction.status === "running";
  }

  return snapshot.compaction.status !== "running";
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function serializedSyncValue(value: unknown): string {
  return JSON.stringify(value);
}

function assistantMessageCovers(
  snapshotMessage: Extract<
    SessionSyncEvent,
    { type: "snapshot" }
  >["snapshot"]["live"]["streamingMessage"],
  patchMessage: ReturnType<typeof readAssistantPatchMessage>,
): boolean {
  if (snapshotMessage === undefined || patchMessage === null || patchMessage === undefined) {
    return false;
  }

  if (
    snapshotMessage.api !== patchMessage.api ||
    snapshotMessage.provider !== patchMessage.provider ||
    snapshotMessage.model !== patchMessage.model ||
    snapshotMessage.stopReason !== patchMessage.stopReason ||
    snapshotMessage.responseId !== patchMessage.responseId ||
    snapshotMessage.content.length < patchMessage.content.length
  ) {
    return false;
  }

  return patchMessage.content.every((patchBlock, index) => {
    const snapshotBlock = snapshotMessage.content[index];
    if (snapshotBlock === undefined) {
      return false;
    }

    if (serializedSyncValue(snapshotBlock) === serializedSyncValue(patchBlock)) {
      return true;
    }

    switch (patchBlock.type) {
      case "text":
        if (snapshotBlock.type !== "text") {
          return false;
        }
        return snapshotBlock.text.startsWith(patchBlock.text);
      case "thinking":
        if (snapshotBlock.type !== "thinking") {
          return false;
        }
        return (
          snapshotBlock.thinking.startsWith(patchBlock.thinking) &&
          snapshotBlock.redacted === patchBlock.redacted
        );
      case "toolCall":
        if (snapshotBlock.type !== "toolCall") {
          return false;
        }
        return false;
      default:
        return false;
    }
  });
}
