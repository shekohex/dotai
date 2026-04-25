import { Type } from "typebox";
import { Value } from "typebox/value";

export interface SseDataEvent {
  type: "data";
  data: string;
}

export interface SseControlEvent {
  type: "control";
  streamNextOffset: string;
  streamCursor?: string;
  upToDate?: boolean;
  streamClosed?: boolean;
}

export type SseEvent = SseDataEvent | SseControlEvent;

const SseControlEventSchema = Type.Object(
  {
    streamNextOffset: Type.String(),
    streamCursor: Type.Optional(Type.String()),
    upToDate: Type.Optional(Type.Boolean()),
    streamClosed: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

function parseControlPayload(data: string): SseControlEvent | undefined {
  const parsed: unknown = JSON.parse(data);
  if (!Value.Check(SseControlEventSchema, parsed)) {
    return undefined;
  }

  const payload = Value.Parse(SseControlEventSchema, parsed);
  return {
    type: "control",
    streamNextOffset: payload.streamNextOffset,
    streamCursor: payload.streamCursor,
    upToDate: payload.upToDate,
    streamClosed: payload.streamClosed,
  };
}

function handleSseLine(
  line: string,
  currentEvent: { type?: string; data: string[] },
): "flush" | undefined {
  if (line === "") {
    return "flush";
  }

  if (line.startsWith("event:")) {
    const eventType = line.slice(6);
    currentEvent.type = eventType.startsWith(" ") ? eventType.slice(1) : eventType;
    return undefined;
  }

  if (!line.startsWith("data:")) {
    return undefined;
  }

  const data = line.slice(5);
  currentEvent.data.push(data.startsWith(" ") ? data.slice(1) : data);
  return undefined;
}

function* emitCurrentEvent(currentEvent: {
  type?: string;
  data: string[];
}): Generator<SseEvent, void, undefined> {
  if (currentEvent.type === undefined || currentEvent.data.length === 0) {
    return;
  }

  const data = currentEvent.data.join("\n");
  if (currentEvent.type === "data") {
    yield { type: "data", data };
    return;
  }

  if (currentEvent.type === "control") {
    const control = parseControlPayload(data);
    if (control !== undefined) {
      yield control;
    }
  }
}

function consumeSseChunk(input: {
  buffer: string;
  chunk: Uint8Array;
  decoder: TextDecoder;
  currentEvent: { type?: string; data: string[] };
}): { buffer: string; currentEvent: { type?: string; data: string[] }; events: SseEvent[] } {
  let buffer = input.buffer + input.decoder.decode(input.chunk, { stream: true });
  const events: SseEvent[] = [];
  buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  let currentEvent = input.currentEvent;
  for (const line of lines) {
    if (handleSseLine(line, currentEvent) === "flush") {
      events.push(...emitCurrentEvent(currentEvent));
      currentEvent = { data: [] };
    }
  }

  return { buffer, currentEvent, events };
}

function* emitTailEvents(
  decoder: TextDecoder,
  buffer: string,
  currentEvent: { type?: string; data: string[] },
): Generator<SseEvent, void, undefined> {
  const tail = decoder.decode();
  if (tail.length > 0) {
    buffer += tail;
  }

  if (buffer.length > 0) {
    yield* emitCurrentEvent(currentEvent);
  }
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent: { type?: string; data: string[] } = { data: [] };
  let aborted = signal?.aborted ?? false;

  const onAbort = () => {
    aborted = true;
    void reader.cancel().catch(() => {});
  };

  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (aborted) {
        break;
      }

      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const consumed = consumeSseChunk({
        buffer,
        chunk: value,
        decoder,
        currentEvent,
      });
      buffer = consumed.buffer;
      currentEvent = consumed.currentEvent;
      for (const event of consumed.events) {
        yield event;
      }
    }

    yield* emitTailEvents(decoder, buffer, currentEvent);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
