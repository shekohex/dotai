import type { ResourceLoader } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const RemoteCustomExtensionEventPayloadSchema = Type.Object(
  {
    channel: Type.String({ minLength: 1 }),
    data: Type.Unknown(),
  },
  { additionalProperties: false },
);

type EventBusLike = {
  emit: (channel: string, data: unknown) => void;
  on: (channel: string, handler: (data: unknown) => void) => () => void;
};

type EventBusWithLocalEmit = EventBusLike & {
  emitLocalOnly: (channel: string, data: unknown) => void;
};

type ResourceLoaderWithOptionalEventBus = ResourceLoader & {
  eventBus?: unknown;
};

function isEventBusLike(value: unknown): value is EventBusLike {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "emit" in value &&
    typeof value.emit === "function" &&
    "on" in value &&
    typeof value.on === "function"
  );
}

function isResourceLoaderWithOptionalEventBus(
  value: ResourceLoader,
): value is ResourceLoaderWithOptionalEventBus {
  return "eventBus" in value;
}

export function readResourceLoaderEventBus(
  resourceLoader: ResourceLoader,
): EventBusLike | undefined {
  if (!isResourceLoaderWithOptionalEventBus(resourceLoader)) {
    return undefined;
  }

  return isEventBusLike(resourceLoader.eventBus) ? resourceLoader.eventBus : undefined;
}

export function requireResourceLoaderEventBus(
  resourceLoader: ResourceLoader,
  location: string,
): EventBusLike {
  const eventBus = readResourceLoaderEventBus(resourceLoader);
  if (eventBus) {
    return eventBus;
  }

  // Upstream ResourceLoader public type hides this bus, but pi.events depends on it at runtime.
  throw new Error(
    `${location}: ResourceLoader event bus unavailable. Upstream ResourceLoader shape changed or non-DefaultResourceLoader omitted hidden eventBus.`,
  );
}

export function setResourceLoaderEventBus(
  resourceLoader: ResourceLoader,
  eventBus: EventBusLike,
  location: string,
): void {
  if (!isResourceLoaderWithOptionalEventBus(resourceLoader)) {
    throw new Error(
      `${location}: ResourceLoader event bus unavailable. Upstream ResourceLoader shape changed or non-DefaultResourceLoader omitted hidden eventBus.`,
    );
  }

  resourceLoader.eventBus = eventBus;
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
  const eventBus = requireResourceLoaderEventBus(resourceLoader, location) as EventBusLike & {
    emitLocalOnly?: (nextChannel: string, nextData: unknown) => void;
  };

  if (typeof eventBus.emitLocalOnly === "function") {
    eventBus.emitLocalOnly(channel, data);
    return;
  }

  eventBus.emit(channel, data);
}

export function parseRemoteCustomExtensionEventPayload(
  value: unknown,
): { channel: string; data: unknown } | undefined {
  if (!Value.Check(RemoteCustomExtensionEventPayloadSchema, value)) {
    return undefined;
  }

  return Value.Parse(RemoteCustomExtensionEventPayloadSchema, value);
}
