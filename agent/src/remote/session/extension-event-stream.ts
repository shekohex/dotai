import type {
  ExtensionEvent,
  ExtensionRunner,
  ResourceLoader,
} from "@mariozechner/pi-coding-agent";
import { readResourceLoaderEventBus } from "../event-bus-bridge.js";
import { toJsonValue } from "../json-value.js";
import { readRemoteExtensionSyncInfo } from "../session-sync-metadata.js";
import { sessionEventsStreamId, type InMemoryDurableStreamStore } from "../streams.js";
import { appendDurableExtensionEvent } from "./durable-runtime-state.js";
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
    sessionVersion: String(input.record.lastDurableSessionVersion),
    payload: input.event,
    ts: input.ts,
  });
}

export function appendMirroredRemoteCustomExtensionEvent(input: {
  streams: InMemoryDurableStreamStore;
  record: SessionRecord;
  channel: string;
  data: unknown;
  ts: number;
}): void {
  const jsonData = toJsonValue(input.data);
  if (jsonData === undefined) {
    return;
  }
  const syncInfo = readRemoteExtensionSyncInfo(input.channel, jsonData);
  if (syncInfo.sync === "ephemeral") {
    input.streams.appendLiveOnly(sessionEventsStreamId(input.record.sessionId), {
      sessionId: input.record.sessionId,
      kind: "extension_custom_event",
      sessionVersion: String(input.record.lastDurableSessionVersion),
      payload: {
        channel: input.channel,
        data: jsonData,
      },
      ts: input.ts,
    });
    return;
  }

  if (syncInfo.sync === "durable") {
    appendDurableExtensionEvent({
      record: input.record,
      channel: input.channel,
      data: jsonData,
      ts: input.ts,
    });
  }

  input.streams.append(sessionEventsStreamId(input.record.sessionId), {
    sessionId: input.record.sessionId,
    kind: "extension_custom_event",
    sessionVersion: String(input.record.lastDurableSessionVersion),
    payload: {
      channel: input.channel,
      data: jsonData,
    },
    retentionKey: syncInfo.retentionKey,
    ts: input.ts,
  });
}

export function installRemoteExtensionEventMirror(input: {
  runner: MirroredExtensionRunner | undefined;
  resourceLoader: ResourceLoader;
  streams: InMemoryDurableStreamStore;
  record: SessionRecord;
  now: () => number;
}): void {
  if (input.runner && input.runner.emit !== undefined) {
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

  const eventBus = readResourceLoaderEventBus(input.resourceLoader);
  if (!eventBus) {
    return;
  }

  const originalEventBusEmit = eventBus.emit.bind(eventBus);
  eventBus.emit = (channel, data) => {
    originalEventBusEmit(channel, data);
    appendMirroredRemoteCustomExtensionEvent({
      streams: input.streams,
      record: input.record,
      channel,
      data,
      ts: input.now(),
    });
  };
}
