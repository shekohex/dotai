import type { MiddlewareHandler } from "hono";
import {
  readRemoteExtensionSyncInfo,
  readSessionSyncPatchReplaceKey,
} from "../session-sync-metadata.js";
import {
  SessionSyncEventSchema,
  type SessionSyncEvent,
  type StreamEventEnvelope,
} from "../schemas.js";
import { RemoteError } from "../errors.js";
import { sessionEventsStreamId } from "../streams.js";
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
    const streamId = sessionEventsStreamId(sessionId);
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

    unsubscribe = dependencies.liveEvents.subscribe(streamId, (event) => {
      const payload = toSessionSyncPatchEvent(sessionId, event);
      if (payload === undefined) {
        return;
      }
      assertType(SessionSyncEventSchema, payload);
      enqueuePatchEvent(payload);
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

function bufferPatchEvent(
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

function isPatchCoveredBySnapshot(
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
      return snapshot.live.streamingMessage !== undefined;
    case "tool.execution":
      return isToolExecutionPatchCoveredBySnapshot(patchEvent.patch.payload, snapshot);
    case "queue.update":
      return (
        arraysEqual(snapshot.live.queuedSteeringMessages, patchEvent.patch.payload.steering) &&
        arraysEqual(snapshot.live.queuedFollowUpMessages, patchEvent.patch.payload.followUp)
      );
    case "retry.status":
      return isRetryStatusPatchCoveredBySnapshot(patchEvent.patch.payload, snapshot);
    case "extension.custom": {
      const patchSyncInfo = readRemoteExtensionSyncInfo(
        patchEvent.patch.payload.channel,
        patchEvent.patch.payload.data,
      );
      if (patchSyncInfo.sync !== "durable") {
        return false;
      }

      const patchKey = patchSyncInfo.stateKey;
      return snapshot.durableExtensionState.some(
        (entry) => readRemoteExtensionSyncInfo(entry.channel, entry.data).stateKey === patchKey,
      );
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
    case "agent.event":
      return false;
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

  return activeExecution !== undefined;
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

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function toSessionSyncPatchEvent(
  sessionId: string,
  event: StreamEventEnvelope,
): Extract<SessionSyncEvent, { type: "patch" }> | undefined {
  const base = {
    type: "patch" as const,
    sessionId,
    version: event.sessionVersion ?? event.streamOffset,
  };

  switch (event.kind) {
    case "session_state_patch":
      return { ...base, patch: { patchType: "session.state", payload: event.payload } };
    case "agent_session_event":
      if (isAssistantMessageUpdatePayload(event.payload)) {
        return {
          ...base,
          patch: {
            patchType: "assistant.message",
            payload: {
              type: "message_update",
              message: event.payload.message,
              assistantMessageEvent: event.payload.assistantMessageEvent,
            },
          },
        };
      }

      if (
        event.payload.type === "tool_execution_start" ||
        event.payload.type === "tool_execution_update" ||
        event.payload.type === "tool_execution_end"
      ) {
        return {
          ...base,
          patch: { patchType: "tool.execution", payload: event.payload },
        };
      }

      if (event.payload.type === "queue_update") {
        return {
          ...base,
          patch: {
            patchType: "queue.update",
            payload: {
              type: "queue_update",
              steering: [...event.payload.steering],
              followUp: [...event.payload.followUp],
            },
          },
        };
      }

      if (event.payload.type === "auto_retry_start" || event.payload.type === "auto_retry_end") {
        return {
          ...base,
          patch: { patchType: "retry.status", payload: event.payload },
        };
      }

      return {
        ...base,
        patch: { patchType: "agent.event", eventType: event.payload.type, payload: event.payload },
      };
    case "extension_custom_event":
      return { ...base, patch: { patchType: "extension.custom", payload: event.payload } };
    case "extension_event":
      return { ...base, patch: { patchType: "extension.event", payload: event.payload } };
    case "extension_ui_request":
      return { ...base, patch: { patchType: "extension.ui.request", payload: event.payload } };
    case "extension_ui_resolved":
      return { ...base, patch: { patchType: "extension.ui.resolved", payload: event.payload } };
    case "command_accepted":
      return { ...base, patch: { patchType: "command.accepted", payload: event.payload } };
    case "bash_start":
      return { ...base, patch: { patchType: "bash.start", payload: event.payload } };
    case "bash_chunk":
      return { ...base, patch: { patchType: "bash.chunk", payload: event.payload } };
    case "bash_end":
      return { ...base, patch: { patchType: "bash.end", payload: event.payload } };
    case "bash_flush":
      return { ...base, patch: { patchType: "bash.flush", payload: event.payload } };
    case "extension_error":
      return { ...base, patch: { patchType: "extension.error", payload: event.payload } };
    case "auth_notice":
    case "client_presence_updated":
    case "server_notice":
    case "session_closed":
    case "session_created":
    case "session_summary_updated":
      return undefined;
    default:
      return undefined;
  }
}

function isAssistantMessageUpdatePayload(
  payload: Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"],
): payload is Extract<
  Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"],
  { type: "message_update" }
> & { message: { role: "assistant" } } {
  return payload.type === "message_update" && payload.message.role === "assistant";
}

function compareSessionVersions(left: string, right: string): number {
  return Number(left) - Number(right);
}
