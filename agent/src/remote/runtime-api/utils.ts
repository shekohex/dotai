import type { StreamEventEnvelope } from "../schemas.js";
import { StreamEventEnvelopeSchema } from "../schemas.js";
import { parseSseStream } from "../sse.js";
import { assertType } from "../typebox.js";

export type StreamReadResult = {
  events: StreamEventEnvelope[];
  nextOffset: string;
  streamClosed: boolean;
};

export type ReadSessionEventsOptions = {
  signal?: AbortSignal;
  onEvent?: (event: StreamEventEnvelope) => Promise<void> | void;
  onControl?: (control: {
    nextOffset: string;
    streamClosed: boolean;
    streamCursor?: string;
  }) => void;
};

export type SessionSseReadState = {
  events: StreamEventEnvelope[];
  nextOffset: string;
  streamCursor?: string;
  streamClosed: boolean;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readObject(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function createRemoteApiError(status: number, message: string): Error & { status: number } {
  const error = new Error(message);
  return Object.assign(error, { name: "RemoteApiError", status });
}

export async function readSessionEventsFromSse(input: {
  response: Response;
  fallbackOffset: string;
  signal?: AbortSignal;
  onEvent?: ReadSessionEventsOptions["onEvent"];
  onControl?: ReadSessionEventsOptions["onControl"];
}): Promise<StreamReadResult & { streamCursor?: string }> {
  const stream = input.response.body;
  const state: SessionSseReadState = {
    events: [],
    nextOffset: input.response.headers.get("Stream-Next-Offset") ?? input.fallbackOffset,
    streamClosed: input.response.headers.get("Stream-Closed") === "true",
    streamCursor: input.response.headers.get("Stream-Cursor") ?? undefined,
  };
  if (!stream) return state;
  for await (const event of parseSseStream(stream, input.signal)) {
    if (event.type === "data") {
      const parsed: unknown = JSON.parse(event.data);
      assertType(StreamEventEnvelopeSchema, parsed);
      if (input.onEvent) await input.onEvent(parsed);
      else state.events.push(parsed);
      continue;
    }
    state.nextOffset = event.streamNextOffset;
    if (event.streamCursor !== undefined && event.streamCursor.length > 0) {
      state.streamCursor = event.streamCursor;
    }
    if (event.streamClosed === true) state.streamClosed = true;
    input.onControl?.({
      nextOffset: state.nextOffset,
      streamClosed: state.streamClosed,
      streamCursor: state.streamCursor,
    });
    if (state.streamClosed) break;
  }
  return state;
}

export async function toRemoteHttpError(response: Response): Promise<Error & { status: number }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return createRemoteApiError(response.status, response.statusText || `HTTP ${response.status}`);
  }
  try {
    const body: unknown = await response.json();
    const bodyObject = readObject(body);
    const errorValue = bodyObject?.error;
    const detailsValue = bodyObject?.details;
    const errorMessage = typeof errorValue === "string" ? errorValue : undefined;
    const detailsMessage = typeof detailsValue === "string" ? detailsValue : undefined;
    const message =
      errorMessage !== undefined && detailsMessage !== undefined
        ? `${errorMessage}: ${detailsMessage}`
        : (errorMessage ?? response.statusText);
    return createRemoteApiError(response.status, message);
  } catch {
    return createRemoteApiError(response.status, response.statusText || `HTTP ${response.status}`);
  }
}
