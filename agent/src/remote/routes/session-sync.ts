import type { MiddlewareHandler } from "hono";
import { SessionSyncEventSchema, type SessionSyncEvent } from "../schemas.js";
import { sessionEventsStreamId } from "../streams.js";
import { assertType } from "../typebox.js";
import { authError } from "./auth.js";
import type { RemoteHonoEnv, RemoteRoutesDependencies } from "./types.js";

type HonoContext = Parameters<MiddlewareHandler<RemoteHonoEnv>>[0];

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

    const enqueuePatchEvent = (patchEvent: SessionSyncEvent): void => {
      if (controller === undefined) {
        bufferedPatchEvents.push(patchEvent);
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
          if (
            bufferedPatchEvent.type === "patch" &&
            bufferedPatchEvent.version <= snapshot.lastSessionStreamOffset
          ) {
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
