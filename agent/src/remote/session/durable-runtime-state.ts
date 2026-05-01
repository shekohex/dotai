import type { SessionEntry, SessionManager } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { readRemoteExtensionStateKey } from "../event-bus-bridge.js";
import { JsonValueSchema, type JsonValue } from "../json-schema.js";
import type { SessionRecord } from "./types.js";

const RemoteQueueStateEntrySchema = Type.Object({
  depth: Type.Number(),
  nextSequence: Type.Number(),
  updatedAt: Type.Number(),
});

const RemoteRetryStateEntrySchema = Type.Object({
  status: Type.Union([Type.Literal("idle"), Type.Literal("running")]),
  updatedAt: Type.Number(),
});

const RemoteCompactionStateEntrySchema = Type.Object({
  status: Type.Union([Type.Literal("idle"), Type.Literal("running")]),
  updatedAt: Type.Number(),
});

const RemoteBashStateEntrySchema = Type.Object({
  isRunning: Type.Boolean(),
  hasPendingMessages: Type.Boolean(),
  updatedAt: Type.Number(),
});

const RemoteStreamingStateEntrySchema = Type.Object({
  status: Type.Union([Type.Literal("idle"), Type.Literal("streaming")]),
  updatedAt: Type.Number(),
});

const RemoteSessionVersionEntrySchema = Type.Object({
  version: Type.Number(),
  updatedAt: Type.Number(),
});

const RemoteDurableExtensionEventEntrySchema = Type.Object({
  channel: Type.String(),
  data: JsonValueSchema,
  ts: Type.Number(),
});

export const REMOTE_QUEUE_STATE_ENTRY = "remote-queue-state";
export const REMOTE_RETRY_STATE_ENTRY = "remote-retry-state";
export const REMOTE_COMPACTION_STATE_ENTRY = "remote-compaction-state";
export const REMOTE_BASH_STATE_ENTRY = "remote-bash-state";
export const REMOTE_STREAMING_STATE_ENTRY = "remote-streaming-state";
export const REMOTE_SESSION_VERSION_ENTRY = "remote-session-version";
export const REMOTE_DURABLE_EXTENSION_EVENT_ENTRY = "remote-durable-extension-event";
export { RemoteSessionVersionEntrySchema };

type DurableRuntimeDomainState = {
  queue: { depth: number; nextSequence: number; updatedAt: number };
  retry: { status: "idle" | "running"; updatedAt: number };
  compaction: { status: "idle" | "running"; updatedAt: number };
  bash: { isRunning: boolean; hasPendingMessages: boolean; updatedAt: number };
  streaming: { status: "idle" | "streaming"; updatedAt: number };
  version: { version: number; updatedAt: number };
};

export function persistDurableRuntimeDomainState(input: {
  record: SessionRecord;
  updatedAt: number;
}): void {
  const sessionManager = input.record.runtime.session?.sessionManager;
  if (!hasAppendCustomEntry(sessionManager)) {
    return;
  }

  sessionManager.appendCustomEntry(REMOTE_QUEUE_STATE_ENTRY, {
    depth: input.record.queue.depth,
    nextSequence: input.record.queue.nextSequence,
    updatedAt: input.updatedAt,
  });
  sessionManager.appendCustomEntry(REMOTE_RETRY_STATE_ENTRY, {
    status: input.record.retry.status === "running" ? "running" : "idle",
    updatedAt: input.updatedAt,
  });
  sessionManager.appendCustomEntry(REMOTE_COMPACTION_STATE_ENTRY, {
    status: input.record.compaction.status === "running" ? "running" : "idle",
    updatedAt: input.updatedAt,
  });
  sessionManager.appendCustomEntry(REMOTE_BASH_STATE_ENTRY, {
    isRunning: input.record.isBashRunning,
    hasPendingMessages: input.record.hasPendingBashMessages,
    updatedAt: input.updatedAt,
  });
  sessionManager.appendCustomEntry(REMOTE_STREAMING_STATE_ENTRY, {
    status: input.record.streamingState === "streaming" ? "streaming" : "idle",
    updatedAt: input.updatedAt,
  });
  sessionManager.appendCustomEntry(REMOTE_SESSION_VERSION_ENTRY, {
    version: input.record.lastDurableSessionVersion,
    updatedAt: input.updatedAt,
  });
}

export function restoreDurableRuntimeDomainState(record: SessionRecord, now: number): void {
  const sessionManager = record.runtime.session?.sessionManager;
  if (!hasSessionEntries(sessionManager)) {
    return;
  }

  const persistedState = readDurableRuntimeDomainState(sessionManager.getEntries());
  if (persistedState.version !== undefined) {
    record.lastDurableSessionVersion = persistedState.version.version;
  }
  const interruptedRuntimeDomains = {
    queue: persistedState.queue?.depth !== undefined && persistedState.queue.depth > 0,
    retry: persistedState.retry?.status === "running",
    compaction: persistedState.compaction?.status === "running",
    bash:
      persistedState.bash?.isRunning === true || persistedState.bash?.hasPendingMessages === true,
    streaming: persistedState.streaming?.status === "streaming",
  };

  record.interruptedRuntimeDomains = interruptedRuntimeDomains;

  if (interruptedRuntimeDomains.streaming) {
    record.streamingState = "interrupted";
  }
  if (interruptedRuntimeDomains.retry) {
    record.retry.status = "interrupted";
  }
  if (interruptedRuntimeDomains.compaction) {
    record.compaction.status = "interrupted";
  }
  if (interruptedRuntimeDomains.queue) {
    record.queue.depth = 0;
  }
  if (interruptedRuntimeDomains.bash) {
    record.isBashRunning = false;
    record.hasPendingBashMessages = false;
  }

  if (
    interruptedRuntimeDomains.queue ||
    interruptedRuntimeDomains.retry ||
    interruptedRuntimeDomains.compaction ||
    interruptedRuntimeDomains.bash ||
    interruptedRuntimeDomains.streaming
  ) {
    record.activeRun = {
      runId: "interrupted",
      status: "interrupted",
      triggeringCommandId: "server-recovery",
      startedAt: now,
      updatedAt: now,
      queueDepth: 0,
    };
  }
}

export function appendDurableExtensionEvent(input: {
  record: SessionRecord;
  channel: string;
  data: JsonValue;
  ts: number;
}): void {
  const sessionManager = input.record.runtime.session?.sessionManager;
  if (!hasAppendCustomEntry(sessionManager)) {
    return;
  }

  input.record.lastDurableSessionVersion += 1;
  sessionManager.appendCustomEntry(REMOTE_SESSION_VERSION_ENTRY, {
    version: input.record.lastDurableSessionVersion,
    updatedAt: input.ts,
  });
  sessionManager.appendCustomEntry(REMOTE_DURABLE_EXTENSION_EVENT_ENTRY, {
    channel: input.channel,
    data: input.data,
    ts: input.ts,
  });
}

export function readDurableExtensionEvents(record: SessionRecord): Array<{
  channel: string;
  data: JsonValue;
  ts: number;
}> {
  const sessionManager = record.runtime.session?.sessionManager;
  if (!hasSessionEntries(sessionManager)) {
    return [];
  }

  const result: Array<{ channel: string; data: JsonValue; ts: number }> = [];
  for (const entry of sessionManager.getEntries()) {
    if (
      entry.type === "custom" &&
      entry.customType === REMOTE_DURABLE_EXTENSION_EVENT_ENTRY &&
      Value.Check(RemoteDurableExtensionEventEntrySchema, entry.data)
    ) {
      result.push(Value.Parse(RemoteDurableExtensionEventEntrySchema, entry.data));
    }
  }

  return result;
}

export function buildDurableExtensionState(record: SessionRecord): Array<{
  channel: string;
  data: JsonValue;
}> {
  const projectedByKey = new Map<string, { channel: string; data: JsonValue }>();
  const orderedKeys: string[] = [];

  for (const event of readDurableExtensionEvents(record)) {
    const key = readDurableExtensionProjectionKey(event.channel, event.data);
    if (!projectedByKey.has(key)) {
      orderedKeys.push(key);
    }
    projectedByKey.set(key, {
      channel: event.channel,
      data: structuredClone(event.data),
    });
  }

  return orderedKeys
    .map((key) => projectedByKey.get(key))
    .filter((value): value is { channel: string; data: JsonValue } => value !== undefined);
}

function hasAppendCustomEntry(
  sessionManager: SessionManager | undefined,
): sessionManager is SessionManager & {
  appendCustomEntry: (customType: string, data: unknown) => void;
} {
  return (
    sessionManager !== undefined &&
    typeof sessionManager.appendCustomEntry === "function" &&
    typeof sessionManager.getEntries === "function"
  );
}

function hasSessionEntries(
  sessionManager: SessionManager | undefined,
): sessionManager is SessionManager & {
  getEntries: () => SessionEntry[];
} {
  return sessionManager !== undefined && typeof sessionManager.getEntries === "function";
}

function readDurableRuntimeDomainState(
  entries: SessionEntry[],
): Partial<DurableRuntimeDomainState> {
  const result: Partial<DurableRuntimeDomainState> = {};

  for (const entry of entries) {
    if (entry.type !== "custom") {
      continue;
    }

    if (
      entry.customType === REMOTE_QUEUE_STATE_ENTRY &&
      Value.Check(RemoteQueueStateEntrySchema, entry.data)
    ) {
      result.queue = Value.Parse(RemoteQueueStateEntrySchema, entry.data);
      continue;
    }
    if (
      entry.customType === REMOTE_RETRY_STATE_ENTRY &&
      Value.Check(RemoteRetryStateEntrySchema, entry.data)
    ) {
      result.retry = Value.Parse(RemoteRetryStateEntrySchema, entry.data);
      continue;
    }
    if (
      entry.customType === REMOTE_COMPACTION_STATE_ENTRY &&
      Value.Check(RemoteCompactionStateEntrySchema, entry.data)
    ) {
      result.compaction = Value.Parse(RemoteCompactionStateEntrySchema, entry.data);
      continue;
    }
    if (
      entry.customType === REMOTE_BASH_STATE_ENTRY &&
      Value.Check(RemoteBashStateEntrySchema, entry.data)
    ) {
      result.bash = Value.Parse(RemoteBashStateEntrySchema, entry.data);
      continue;
    }
    if (
      entry.customType === REMOTE_STREAMING_STATE_ENTRY &&
      Value.Check(RemoteStreamingStateEntrySchema, entry.data)
    ) {
      result.streaming = Value.Parse(RemoteStreamingStateEntrySchema, entry.data);
      continue;
    }
    if (
      entry.customType === REMOTE_SESSION_VERSION_ENTRY &&
      Value.Check(RemoteSessionVersionEntrySchema, entry.data)
    ) {
      result.version = Value.Parse(RemoteSessionVersionEntrySchema, entry.data);
    }
  }

  return result;
}

function readDurableExtensionProjectionKey(channel: string, data: unknown): string {
  return readRemoteExtensionStateKey(channel, data);
}

export function readRemoteSessionVersionEntryData(
  value: unknown,
): { version: number; updatedAt: number } | undefined {
  if (!Value.Check(RemoteSessionVersionEntrySchema, value)) {
    return undefined;
  }

  return Value.Parse(RemoteSessionVersionEntrySchema, value);
}
