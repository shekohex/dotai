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
    void reader.cancel();
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

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line === "") {
          if (currentEvent.type && currentEvent.data.length > 0) {
            const data = currentEvent.data.join("\n");
            if (currentEvent.type === "data") {
              yield { type: "data", data };
            } else if (currentEvent.type === "control") {
              const parsed = JSON.parse(data) as {
                streamNextOffset: string;
                streamCursor?: string;
                upToDate?: boolean;
                streamClosed?: boolean;
              };
              yield {
                type: "control",
                streamNextOffset: parsed.streamNextOffset,
                streamCursor: parsed.streamCursor,
                upToDate: parsed.upToDate,
                streamClosed: parsed.streamClosed,
              };
            }
          }
          currentEvent = { data: [] };
          continue;
        }

        if (line.startsWith("event:")) {
          const eventType = line.slice(6);
          currentEvent.type = eventType.startsWith(" ") ? eventType.slice(1) : eventType;
          continue;
        }

        if (line.startsWith("data:")) {
          const data = line.slice(5);
          currentEvent.data.push(data.startsWith(" ") ? data.slice(1) : data);
        }
      }
    }

    const tail = decoder.decode();
    if (tail) {
      buffer += tail;
    }

    if (buffer && currentEvent.type && currentEvent.data.length > 0) {
      const data = currentEvent.data.join("\n");
      if (currentEvent.type === "data") {
        yield { type: "data", data };
      } else if (currentEvent.type === "control") {
        const parsed = JSON.parse(data) as {
          streamNextOffset: string;
          streamCursor?: string;
          upToDate?: boolean;
          streamClosed?: boolean;
        };
        yield {
          type: "control",
          streamNextOffset: parsed.streamNextOffset,
          streamCursor: parsed.streamCursor,
          upToDate: parsed.upToDate,
          streamClosed: parsed.streamClosed,
        };
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
