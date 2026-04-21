import {
  buildRemoteNoContentSessionEventsResult,
  buildRemoteSessionEventsRequestUrl,
} from "./internals.js";
import { readSessionEventsFromSse, type StreamReadResult, toRemoteHttpError } from "./utils.js";
import type { ReadSessionEventsOptions } from "./utils.js";

export async function readRemoteSessionEvents(input: {
  fetchImpl: typeof fetch;
  origin: string;
  sessionId: string;
  offset: string;
  cursor: string | undefined;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
  options: ReadSessionEventsOptions | undefined;
  captureConnectionId: (response: Response) => void;
  updateCursor: (cursor: string | undefined) => void;
}): Promise<StreamReadResult> {
  const response = await fetchRemoteSessionEventsResponse(input);
  input.captureConnectionId(response);
  return parseRemoteSessionEventsResponse(input, response);
}

function fetchRemoteSessionEventsResponse(input: {
  fetchImpl: typeof fetch;
  origin: string;
  sessionId: string;
  offset: string;
  cursor: string | undefined;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
}): Promise<Response> {
  return input.fetchImpl(
    buildRemoteSessionEventsRequestUrl({
      origin: input.origin,
      sessionId: input.sessionId,
      offset: input.offset,
      cursor: input.cursor,
    }),
    {
      method: "GET",
      headers: input.headers,
      signal: input.signal,
    },
  );
}

async function parseRemoteSessionEventsResponse(
  input: {
    offset: string;
    signal: AbortSignal | undefined;
    options: ReadSessionEventsOptions | undefined;
    updateCursor: (cursor: string | undefined) => void;
  },
  response: Response,
): Promise<StreamReadResult> {
  if (response.status === 204) {
    const noContent = buildRemoteNoContentSessionEventsResult({
      response,
      fallbackOffset: input.offset,
    });
    input.updateCursor(noContent.streamCursor);
    return noContent.result;
  }

  if (!response.ok) {
    throw await toRemoteHttpError(response);
  }

  const sseRead = await readSessionEventsFromSse({
    response,
    fallbackOffset: input.offset,
    onEvent: input.options?.onEvent,
    onControl: input.options?.onControl,
    signal: input.signal,
  });

  input.updateCursor(sseRead.streamCursor);
  return {
    events: sseRead.events,
    nextOffset: sseRead.nextOffset,
    streamClosed: sseRead.streamClosed,
  };
}
