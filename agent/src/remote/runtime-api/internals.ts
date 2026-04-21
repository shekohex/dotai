import type { StreamReadResult } from "./utils.js";

export function buildRemoteSessionEventsRequestUrl(input: {
  origin: string;
  sessionId: string;
  offset: string;
  cursor: string | undefined;
}): string {
  const query = new URLSearchParams({
    live: "sse",
    offset: input.offset,
    ...(input.cursor !== undefined && input.cursor.length > 0 ? { cursor: input.cursor } : {}),
  });
  return `${input.origin}/v1/streams/sessions/${encodeURIComponent(input.sessionId)}/events?${query.toString()}`;
}

export function buildRemoteNoContentSessionEventsResult(input: {
  response: Response;
  fallbackOffset: string;
}): {
  streamCursor: string | undefined;
  result: StreamReadResult;
} {
  const nextOffset = input.response.headers.get("Stream-Next-Offset") ?? input.fallbackOffset;
  return {
    streamCursor: input.response.headers.get("Stream-Cursor") ?? undefined,
    result: {
      events: [],
      nextOffset,
      streamClosed: input.response.headers.get("Stream-Closed") === "true",
    },
  };
}

export function buildRemoteAuthHeaders(input: {
  token: string | undefined;
  connectionId: string | undefined;
}): Record<string, string> {
  if (input.token === undefined || input.token.length === 0) {
    throw new Error("Remote auth token is missing");
  }

  return {
    authorization: `Bearer ${input.token}`,
    ...(input.connectionId !== undefined && input.connectionId.length > 0
      ? { "x-pi-connection-id": input.connectionId }
      : {}),
  };
}

export function readRemoteConnectionIdHeader(response: Response): string | undefined {
  const header = response.headers.get("x-pi-connection-id");
  if (header === null || header.length === 0) {
    return undefined;
  }
  return header;
}

export function resolveRemoteConnectionId(input: {
  connectionId: string | undefined;
  token: string | undefined;
}): string {
  if (input.connectionId !== undefined && input.connectionId.length > 0) {
    return input.connectionId;
  }
  if (input.token !== undefined && input.token.length > 0) {
    return input.token;
  }
  throw new Error("Remote connection id is missing");
}
