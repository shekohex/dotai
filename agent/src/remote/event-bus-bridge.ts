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

type ResourceLoaderWithOptionalEventBus = ResourceLoader & {
  eventBus?: unknown;
};

function isEventBusLike(value: unknown): value is EventBusLike {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "emit" in value &&
    typeof value.emit === "function"
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

export function parseRemoteCustomExtensionEventPayload(
  value: unknown,
): { channel: string; data: unknown } | undefined {
  if (!Value.Check(RemoteCustomExtensionEventPayloadSchema, value)) {
    return undefined;
  }

  return Value.Parse(RemoteCustomExtensionEventPayloadSchema, value);
}
