import type { MiddlewareHandler } from "hono";
import type { Static } from "typebox";
import { generateResponseCursor } from "../cursor.js";
import { RemoteError } from "../errors.js";
import { StreamReadQuerySchema, StreamReadResponseSchema } from "../schemas.js";
import type { StreamEventEnvelope } from "../schemas.js";
import { appEventsStreamId, sessionEventsStreamId } from "../streams.js";
import { jsonWithSchema } from "../typebox.js";
import { authError } from "./auth.js";
import { streamEventsSse, streamStateHeaders } from "./stream-sse.js";
import type { RemoteHonoEnv, RemoteRoutesDependencies } from "./types.js";

type HonoContext = Parameters<MiddlewareHandler<RemoteHonoEnv>>[0];
type StreamReadQueryInput = Static<typeof StreamReadQuerySchema>;

function getConnectionId(c: HonoContext): string {
  const providedConnectionId = c.req.header("x-pi-connection-id")?.trim();
  if (providedConnectionId !== undefined && providedConnectionId.length > 0) {
    return providedConnectionId;
  }
  return c.get("auth").token;
}

function parseTimeout(timeoutMs: string | undefined): number {
  if (timeoutMs === undefined || timeoutMs.length === 0) {
    return 25_000;
  }
  const parsed = Number.parseInt(timeoutMs, 10);
  if (Number.isNaN(parsed)) {
    return 25_000;
  }
  return Math.min(Math.max(parsed, 250), 60_000);
}

function requireLiveOffset(mode: "sse" | "long-poll", offset: string | undefined): void {
  if (offset !== undefined && offset.length > 0) {
    return;
  }
  throw new RemoteError(`${mode === "sse" ? "SSE" : "Long-poll"} requires offset parameter`, 400);
}

function createReadResponseBody(
  streamId: string,
  read: {
    fromOffset: string | null;
    nextOffset: string;
    upToDate: boolean;
    streamClosed: boolean;
    events: StreamEventEnvelope[];
  },
  streamCursor?: string,
) {
  return {
    streamId,
    fromOffset: read.fromOffset,
    nextOffset: read.nextOffset,
    ...(streamCursor !== undefined && streamCursor.length > 0 ? { streamCursor } : {}),
    upToDate: read.upToDate,
    streamClosed: read.streamClosed,
    events: read.events,
  };
}

function withConnectionHeader(
  headers: Record<string, string>,
  connectionId: string | undefined,
): Record<string, string> {
  if (connectionId === undefined) {
    return headers;
  }
  return {
    ...headers,
    "x-pi-connection-id": connectionId,
  };
}

function createJsonReadResponse(
  c: HonoContext,
  streamId: string,
  read: {
    fromOffset: string | null;
    nextOffset: string;
    upToDate: boolean;
    streamClosed: boolean;
    events: StreamEventEnvelope[];
  },
  connectionId: string | undefined,
): Response {
  return jsonWithSchema(
    c,
    StreamReadResponseSchema,
    createReadResponseBody(streamId, read),
    200,
    withConnectionHeader(streamStateHeaders(read), connectionId),
  );
}

function createLongPollReadResponse(
  c: HonoContext,
  streamId: string,
  read: {
    fromOffset: string | null;
    nextOffset: string;
    upToDate: boolean;
    streamClosed: boolean;
    events: StreamEventEnvelope[];
    timedOut: boolean;
  },
  streamCursor: string | undefined,
  connectionId: string | undefined,
): Response {
  const headers = withConnectionHeader(
    streamStateHeaders({
      ...read,
      streamCursor,
    }),
    connectionId,
  );
  if (read.events.length === 0 && (read.timedOut || read.streamClosed)) {
    return new Response(null, {
      status: 204,
      headers,
    });
  }
  return jsonWithSchema(
    c,
    StreamReadResponseSchema,
    createReadResponseBody(streamId, read, streamCursor),
    200,
    headers,
  );
}

async function handleStreamReadByMode(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  streamId: string,
  query: StreamReadQueryInput,
  connectionId: string,
  includeConnectionHeader: boolean,
  onDisconnect?: () => void,
): Promise<Response> {
  const mode = query.live ?? "json";
  if (mode === "sse" || mode === "long-poll") {
    requireLiveOffset(mode, query.offset);
  }
  if (mode === "sse") {
    return streamEventsSse(
      streamId,
      query.offset,
      query.cursor,
      connectionId,
      dependencies,
      onDisconnect,
    );
  }
  if (mode === "long-poll") {
    const read = await dependencies.streams.waitForEvents(
      streamId,
      query.offset,
      parseTimeout(query.timeoutMs),
    );
    const streamCursor = read.streamClosed ? undefined : generateResponseCursor(query.cursor);
    return createLongPollReadResponse(
      c,
      streamId,
      read,
      streamCursor,
      includeConnectionHeader ? connectionId : undefined,
    );
  }
  const read = dependencies.streams.read(streamId, query.offset);
  return createJsonReadResponse(
    c,
    streamId,
    read,
    includeConnectionHeader ? connectionId : undefined,
  );
}

export async function handleAppEventsStreamRead(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  query: StreamReadQueryInput,
): Promise<Response> {
  try {
    return await handleStreamReadByMode(
      c,
      dependencies,
      appEventsStreamId(),
      query,
      getConnectionId(c),
      false,
    );
  } catch (error) {
    return authError(c, error);
  }
}

export async function handleSessionEventsStreamRead(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
  query: StreamReadQueryInput,
): Promise<Response> {
  try {
    const connectionId = getConnectionId(c);
    dependencies.sessions.touchPresence(sessionId, c.get("auth"), connectionId);
    return await handleStreamReadByMode(
      c,
      dependencies,
      sessionEventsStreamId(sessionId),
      query,
      connectionId,
      true,
      () => {
        dependencies.sessions.detachPresence(sessionId, connectionId);
      },
    );
  } catch (error) {
    return authError(c, error);
  }
}
