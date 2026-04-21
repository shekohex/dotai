import { generateResponseCursor } from "../cursor.js";
import { logSseFrame } from "../http-adapters.js";
import type { RemoteRoutesDependencies } from "./types.js";

function sseEventChunk(event: unknown, id?: string, eventName = "message"): string {
  const idPart = id !== undefined && id.length > 0 ? `id: ${id}\n` : "";
  return `${idPart}event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function streamStateHeaders(input: {
  nextOffset: string;
  upToDate: boolean;
  streamClosed: boolean;
  streamCursor?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Stream-Next-Offset": input.nextOffset,
    "Stream-Up-To-Date": String(input.upToDate),
  };
  if (input.streamClosed) {
    headers["Stream-Closed"] = "true";
  }
  if (input.streamCursor !== undefined && input.streamCursor.length > 0 && !input.streamClosed) {
    headers["Stream-Cursor"] = input.streamCursor;
  }
  return headers;
}

function enqueueData(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  event: unknown,
  streamOffset: string,
): void {
  controller.enqueue(encoder.encode(sseEventChunk(event, streamOffset, "data")));
}

function enqueueControl(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  payload: {
    streamNextOffset: string;
    streamCursor?: string;
    upToDate: boolean;
    streamClosed: boolean;
  },
): void {
  controller.enqueue(encoder.encode(sseEventChunk(payload, undefined, "control")));
}

function createSseBody(
  initial: {
    events: Array<{ streamOffset: string }>;
    nextOffset: string;
    upToDate: boolean;
    streamClosed: boolean;
  },
  encodeEvent: (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: { streamOffset: string },
  ) => void,
  encodeControl: (
    controller: ReadableStreamDefaultController<Uint8Array>,
    payload: {
      streamNextOffset: string;
      streamCursor?: string;
      upToDate: boolean;
      streamClosed: boolean;
    },
  ) => void,
  onCancel: () => void,
  currentCursor: { value: string },
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of initial.events) {
        encodeEvent(controller, event);
      }
      encodeControl(controller, {
        streamNextOffset: initial.nextOffset,
        ...(initial.streamClosed ? {} : { streamCursor: currentCursor.value }),
        upToDate: initial.upToDate,
        streamClosed: initial.streamClosed,
      });
      if (initial.streamClosed) {
        controller.close();
      }
    },
    cancel() {
      onCancel();
    },
  });
}

function buildSseHeaders(
  connectionId: string,
  initial: {
    nextOffset: string;
    upToDate: boolean;
    streamClosed: boolean;
  },
  cursor: string,
): Record<string, string> {
  return {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-pi-connection-id": connectionId,
    ...streamStateHeaders({
      ...initial,
      streamCursor: initial.streamClosed ? undefined : cursor,
    }),
  };
}

export function streamEventsSse(
  streamId: string,
  offset: string | undefined,
  cursor: string | undefined,
  connectionId: string,
  dependencies: RemoteRoutesDependencies,
  onDisconnect?: () => void,
): Response {
  const encoder = new TextEncoder();
  const currentCursor = { value: generateResponseCursor(cursor) };
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

  const logDataFrame = (event: unknown, streamOffset: string): void => {
    logSseFrame("data", {
      streamId,
      streamOffset,
      event,
    });
  };

  const logControlFrame = (payload: {
    streamNextOffset: string;
    streamCursor?: string;
    upToDate: boolean;
    streamClosed: boolean;
  }): void => {
    logSseFrame("control", {
      streamId,
      ...payload,
    });
  };

  const subscription = dependencies.streams.readAndSubscribe(streamId, offset, (event) => {
    if (controller === undefined) {
      return;
    }
    enqueueData(controller, encoder, event, event.streamOffset);
    logDataFrame(event, event.streamOffset);
    currentCursor.value = generateResponseCursor(currentCursor.value);
    const controlPayload = {
      streamNextOffset: dependencies.streams.getHeadOffset(streamId),
      streamCursor: currentCursor.value,
      upToDate: true,
      streamClosed: false,
    };
    enqueueControl(controller, encoder, controlPayload);
    logControlFrame(controlPayload);
  });

  const initial = subscription.read;
  const body = createSseBody(
    initial,
    (activeController, event) => {
      controller = activeController;
      enqueueData(activeController, encoder, event, event.streamOffset);
      logDataFrame(event, event.streamOffset);
    },
    (activeController, payload) => {
      controller = activeController;
      enqueueControl(activeController, encoder, payload);
      logControlFrame(payload);
    },
    () => {
      subscription.unsubscribe();
      controller = undefined;
      onDisconnect?.();
    },
    currentCursor,
  );

  return new Response(body, {
    headers: buildSseHeaders(connectionId, initial, currentCursor.value),
  });
}
