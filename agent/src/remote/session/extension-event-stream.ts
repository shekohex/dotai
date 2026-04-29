import type {
  ExtensionEvent,
  ExtensionRunner,
  ResourceLoader,
} from "@mariozechner/pi-coding-agent";
import { readResourceLoaderEventBus } from "../event-bus-bridge.js";
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

export function appendMirroredRemoteCustomExtensionEvent(input: {
  streams: InMemoryDurableStreamStore;
  record: SessionRecord;
  channel: string;
  data: unknown;
  ts: number;
}): void {
  const syncClass = readRemoteExtensionEventSyncClass(input.data);
  if (syncClass === "ephemeral") {
    return;
  }

  input.streams.append(sessionEventsStreamId(input.record.sessionId), {
    sessionId: input.record.sessionId,
    kind: "extension_custom_event",
    payload: {
      channel: input.channel,
      data: input.data,
    },
    retentionKey: readRemoteExtensionRetentionKey(input.channel, input.data, syncClass),
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

function readRemoteExtensionEventSyncClass(
  data: unknown,
): "ephemeral" | "replaceable" | "durable" | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }

  const sync = readStringProperty(data, "sync");
  if (sync === "ephemeral" || sync === "replaceable" || sync === "durable") {
    return sync;
  }

  return undefined;
}

function readRemoteExtensionRetentionKey(
  channel: string,
  data: unknown,
  syncClass: "ephemeral" | "replaceable" | "durable" | undefined,
): string | undefined {
  if (syncClass !== "replaceable") {
    return undefined;
  }

  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const replaceKey = readStringProperty(data, "replaceKey");
    if (replaceKey !== undefined && replaceKey.length > 0) {
      return `${channel}:${replaceKey}`;
    }
  }

  return channel;
}

function readStringProperty(value: object, propertyName: string): string | undefined {
  if (!isObjectRecord(value) || !(propertyName in value)) {
    return undefined;
  }

  const propertyValue = value[propertyName];
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

function isObjectRecord(value: object): value is Record<string, unknown> {
  return !Array.isArray(value);
}
