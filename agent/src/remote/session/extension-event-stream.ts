import type { ExtensionEvent, ExtensionRunner } from "@mariozechner/pi-coding-agent";
import { sessionEventsStreamId, type InMemoryDurableStreamStore } from "../streams.js";
import type { SessionRecord } from "./types.js";

export type MirroredRemoteExtensionEvent = Extract<
  ExtensionEvent,
  {
    type: "model_select" | "session_compact" | "session_tree";
  }
>;

type MirroredExtensionRunner = {
  emit?: ExtensionRunner["emit"];
};

function isMirroredRemoteExtensionEvent(
  event: Parameters<NonNullable<MirroredExtensionRunner["emit"]>>[0],
): event is MirroredRemoteExtensionEvent {
  return (
    event.type === "model_select" ||
    event.type === "session_compact" ||
    event.type === "session_tree"
  );
}

export function appendMirroredRemoteExtensionEvent(input: {
  streams: InMemoryDurableStreamStore;
  record: SessionRecord;
  event: MirroredRemoteExtensionEvent;
  ts: number;
}): void {
  input.streams.append(sessionEventsStreamId(input.record.sessionId), {
    sessionId: input.record.sessionId,
    kind: "extension_event",
    payload: input.event,
    ts: input.ts,
  });
}

export function installRemoteExtensionEventMirror(input: {
  runner: MirroredExtensionRunner | undefined;
  streams: InMemoryDurableStreamStore;
  record: SessionRecord;
  now: () => number;
}): void {
  if (!input.runner || input.runner.emit === undefined) {
    return;
  }

  const originalEmit = input.runner.emit.bind(input.runner);
  input.runner.emit = async (...args) => {
    const [event] = args;
    const result = await originalEmit(...args);
    if (isMirroredRemoteExtensionEvent(event)) {
      appendMirroredRemoteExtensionEvent({
        streams: input.streams,
        record: input.record,
        event,
        ts: input.now(),
      });
    }
    return result;
  };
}
