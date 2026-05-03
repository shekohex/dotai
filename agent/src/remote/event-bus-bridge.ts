import type { ResourceLoader } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { asRecord } from "../utils/unknown-data.js";
import { JsonValueSchema, type JsonValue } from "./json-schema.js";
import { readHiddenProperty, writeHiddenProperty } from "./runtime-api/capabilities.js";
import { assertType } from "./typebox.js";

export const RemoteCustomExtensionEventPayloadSchema = Type.Object(
  {
    channel: Type.String({ minLength: 1 }),
    data: JsonValueSchema,
    originConnectionId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const RemoteExtensionSyncMetadataSchema = Type.Object(
  {
    sync: Type.Optional(
      Type.Union([Type.Literal("ephemeral"), Type.Literal("replaceable"), Type.Literal("durable")]),
    ),
    replaceKey: Type.Optional(Type.String({ minLength: 1 })),
    deleted: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

type RemoteExtensionSyncMetadata = {
  sync: "ephemeral" | "replaceable" | "durable" | undefined;
  replaceKey: string | undefined;
  deleted: boolean;
};

type EventBusLike = {
  emit: (channel: string, data: unknown) => void;
  on: (channel: string, handler: (data: unknown) => void) => () => void;
};

type EventBusWithLocalEmit = EventBusLike & {
  emitLocalOnly: (channel: string, data: unknown) => void;
};

function isEventBusLike(value: unknown): value is EventBusLike {
  const record = asRecord(value);
  return hasEventBusMethod(record, "emit") && hasEventBusMethod(record, "on");
}

function readHiddenResourceLoaderEventBusCandidate(resourceLoader: ResourceLoader): unknown {
  return readHiddenProperty(resourceLoader, "eventBus");
}

export function readResourceLoaderEventBus(
  resourceLoader: ResourceLoader,
): EventBusLike | undefined {
  const eventBusCandidate = readHiddenResourceLoaderEventBusCandidate(resourceLoader);
  return isEventBusLike(eventBusCandidate) ? eventBusCandidate : undefined;
}

export function requireResourceLoaderEventBus(
  resourceLoader: ResourceLoader,
  location: string,
): EventBusLike {
  const eventBus = readResourceLoaderEventBus(resourceLoader);
  if (eventBus) {
    return eventBus;
  }

  throw new Error(
    `${location}: ResourceLoader event bus unavailable. Upstream ResourceLoader shape changed or non-DefaultResourceLoader omitted hidden eventBus.`,
  );
}

export function setResourceLoaderEventBus(
  resourceLoader: ResourceLoader,
  eventBus: EventBusLike,
): void {
  writeHiddenProperty(resourceLoader, "eventBus", eventBus);
}

export function createForwardingEventBus(input: {
  baseEventBus: EventBusLike;
  forwardEvent: (channel: string, data: unknown) => void;
}): EventBusWithLocalEmit {
  return {
    emit: (channel, data) => {
      input.baseEventBus.emit(channel, data);
      input.forwardEvent(channel, data);
    },
    emitLocalOnly: (channel, data) => {
      input.baseEventBus.emit(channel, data);
    },
    on: (channel, handler) => input.baseEventBus.on(channel, handler),
  };
}

export function emitResourceLoaderEventLocally(
  resourceLoader: ResourceLoader,
  channel: string,
  data: unknown,
  location: string,
): void {
  const eventBus = requireResourceLoaderEventBus(resourceLoader, location);
  if (isEventBusWithLocalEmit(eventBus)) {
    eventBus.emitLocalOnly(channel, data);
    return;
  }

  eventBus.emit(channel, data);
}

function isEventBusWithLocalEmit(value: EventBusLike): value is EventBusWithLocalEmit {
  return hasEventBusMethod(asRecord(value), "emitLocalOnly");
}

function hasEventBusMethod(
  value: Record<string, unknown> | undefined,
  propertyName: string,
): boolean {
  if (!value) {
    return false;
  }

  const propertyValue = value[propertyName];
  return typeof propertyValue === "function";
}

export function parseRemoteCustomExtensionEventPayload(
  value: unknown,
): { channel: string; data: JsonValue; originConnectionId?: string } | undefined {
  if (!Value.Check(RemoteCustomExtensionEventPayloadSchema, value)) {
    return undefined;
  }

  assertType(RemoteCustomExtensionEventPayloadSchema, value);
  return value;
}

export function parseRemoteExtensionSyncMetadata(value: unknown): RemoteExtensionSyncMetadata {
  if (Value.Check(RemoteExtensionSyncMetadataSchema, value)) {
    assertType(RemoteExtensionSyncMetadataSchema, value);
    const metadata = value;
    return {
      sync: metadata.sync,
      replaceKey: metadata.replaceKey,
      deleted: metadata.deleted === true,
    };
  }

  return { sync: undefined, replaceKey: undefined, deleted: false };
}

export function readRemoteExtensionStateKey(channel: string, data: unknown): string {
  const metadata = parseRemoteExtensionSyncMetadata(data);
  if (metadata.replaceKey === undefined) {
    return channel;
  }

  return `${channel}:${metadata.replaceKey}`;
}
