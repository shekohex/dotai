import type { MiddlewareHandler } from "hono";
import { SessionSyncEventSchema, type SessionSyncEvent } from "../schemas.js";
import { sessionEventsStreamId } from "../streams.js";
import { assertType } from "../typebox.js";
import { authError } from "./auth.js";
import type { RemoteHonoEnv, RemoteRoutesDependencies } from "./types.js";

type HonoContext = Parameters<MiddlewareHandler<RemoteHonoEnv>>[0];

const MAX_PRE_SNAPSHOT_PATCH_EVENTS = 128;

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
      const payload: SessionSyncEvent = {
        type: "patch",
        sessionId,
        version: event.streamOffset,
        event,
      };
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
      version: snapshot.lastSessionStreamOffset,
      snapshot,
    };
    assertType(SessionSyncEventSchema, connectedPayload);
    assertType(SessionSyncEventSchema, snapshotPayload);

    const body = new ReadableStream<Uint8Array>({
      start(activeController) {
        controller = activeController;
        activeController.enqueue(encoder.encode(sseChunk(connectedPayload)));
        activeController.enqueue(encoder.encode(sseChunk(snapshotPayload)));
        for (const bufferedPatchEvent of bufferedPatchEvents) {
          if (isPatchCoveredBySnapshot(bufferedPatchEvent, snapshot.lastSessionStreamOffset)) {
            continue;
          }
          activeController.enqueue(encoder.encode(sseChunk(bufferedPatchEvent)));
        }
        bufferedPatchEvents.length = 0;
      },
      cancel() {
        unsubscribe?.();
        controller = undefined;
        if (connectionId !== undefined) {
          dependencies.sessions.detachPresence(sessionId, connectionId);
        }
      },
    });

    return new Response(body, { headers: buildHeaders(connectionId) });
  } catch (error) {
    unsubscribe?.();
    if (connectionId !== undefined) {
      dependencies.sessions.detachPresence(sessionId, connectionId);
    }
    return authError(c, error);
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

function isPatchCoveredBySnapshot(patchEvent: SessionSyncEvent, snapshotVersion: string): boolean {
  if (patchEvent.type !== "patch" || patchEvent.version > snapshotVersion) {
    return false;
  }

  return (
    patchEvent.event.kind === "agent_session_event" ||
    patchEvent.event.kind === "session_state_patch" ||
    patchEvent.event.kind === "command_accepted" ||
    patchEvent.event.kind === "bash_start" ||
    patchEvent.event.kind === "bash_chunk" ||
    patchEvent.event.kind === "bash_end" ||
    patchEvent.event.kind === "bash_flush"
  );
}

function readBufferedPatchReplaceKey(patchEvent: SessionSyncEvent): string | undefined {
  if (patchEvent.type !== "patch") {
    return undefined;
  }

  if (patchEvent.event.kind === "session_state_patch") {
    return "session_state_patch";
  }

  if (patchEvent.event.kind === "agent_session_event") {
    const payload = patchEvent.event.payload;
    if (payload.type === "message_update" && readAgentMessageRole(payload) === "assistant") {
      return "agent_session_event:message_update:assistant";
    }

    const toolCallId = readAgentToolCallId(payload);
    if (payload.type === "tool_execution_update" && toolCallId !== undefined) {
      return `agent_session_event:tool_execution_update:${toolCallId}`;
    }
  }

  if (patchEvent.event.kind !== "extension_custom_event") {
    return undefined;
  }

  const syncClass = readSyncClassFromData(patchEvent.event.payload.data);
  if (syncClass !== "replaceable") {
    return undefined;
  }

  const replaceKey = readStringProperty(patchEvent.event.payload.data, "replaceKey");
  return replaceKey !== undefined && replaceKey.length > 0
    ? `extension_custom_event:${patchEvent.event.payload.channel}:${replaceKey}`
    : `extension_custom_event:${patchEvent.event.payload.channel}`;
}

function readSyncClassFromData(data: unknown): "ephemeral" | "replaceable" | "durable" | undefined {
  const sync = readStringProperty(data, "sync");
  if (sync === "ephemeral" || sync === "replaceable" || sync === "durable") {
    return sync;
  }

  return undefined;
}

function readAgentMessageRole(payload: { type: string }): string | undefined {
  if (!("message" in payload)) {
    return undefined;
  }

  const message = payload.message;
  if (!isObjectRecord(message)) {
    return undefined;
  }

  const role = message.role;
  return typeof role === "string" ? role : undefined;
}

function readAgentToolCallId(payload: { type: string }): string | undefined {
  if (!("toolCallId" in payload)) {
    return undefined;
  }

  const toolCallId = payload.toolCallId;
  return typeof toolCallId === "string" ? toolCallId : undefined;
}

function readStringProperty(value: unknown, propertyName: string): string | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }

  if (!(propertyName in value)) {
    return undefined;
  }

  const propertyValue = value[propertyName];
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
