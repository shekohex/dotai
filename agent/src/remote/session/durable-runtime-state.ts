import type { SessionEntry, SessionManager } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { asRecord } from "../../utils/unknown-data.js";
import { readRemoteExtensionStateKey } from "../event-bus-bridge.js";
import { JsonValueSchema, type JsonValue } from "../json-schema.js";
import { readRemoteExtensionSyncInfo } from "../session-sync-metadata.js";
import { createInitialDurableRuntimeStateCache } from "./types.js";
import type { SessionRecord } from "./types.js";

const RemoteQueueDepthTransitionSchema = Type.Object({
  domain: Type.Literal("queue"),
  op: Type.Literal("depth_delta"),
  delta: Type.Number(),
  updatedAt: Type.Number(),
});

const RemoteQueueSequenceTransitionSchema = Type.Object({
  domain: Type.Literal("queue"),
  op: Type.Literal("next_sequence_set"),
  nextSequence: Type.Number(),
  updatedAt: Type.Number(),
});

const RemoteRetryTransitionSchema = Type.Object({
  domain: Type.Literal("retry"),
  op: Type.Literal("status_set"),
  status: Type.Union([Type.Literal("idle"), Type.Literal("running")]),
  updatedAt: Type.Number(),
});

const RemoteCompactionTransitionSchema = Type.Object({
  domain: Type.Literal("compaction"),
  op: Type.Literal("status_set"),
  status: Type.Union([Type.Literal("idle"), Type.Literal("running")]),
  updatedAt: Type.Number(),
});

const RemoteBashRunningTransitionSchema = Type.Object({
  domain: Type.Literal("bash"),
  op: Type.Literal("running_set"),
  isRunning: Type.Boolean(),
  updatedAt: Type.Number(),
});

const RemoteBashPendingMessagesTransitionSchema = Type.Object({
  domain: Type.Literal("bash"),
  op: Type.Literal("pending_messages_set"),
  hasPendingMessages: Type.Boolean(),
  updatedAt: Type.Number(),
});

const RemoteStreamingTransitionSchema = Type.Object({
  domain: Type.Literal("streaming"),
  op: Type.Literal("status_set"),
  status: Type.Union([Type.Literal("idle"), Type.Literal("streaming")]),
  updatedAt: Type.Number(),
});

export const RemoteRuntimeTransitionEntrySchema = Type.Union([
  RemoteQueueDepthTransitionSchema,
  RemoteQueueSequenceTransitionSchema,
  RemoteRetryTransitionSchema,
  RemoteCompactionTransitionSchema,
  RemoteBashRunningTransitionSchema,
  RemoteBashPendingMessagesTransitionSchema,
  RemoteStreamingTransitionSchema,
]);

const RemoteSessionVersionEntrySchema = Type.Object({
  version: Type.Number(),
  updatedAt: Type.Number(),
});

const RemoteDurableExtensionStateEntrySchema = Type.Object({
  op: Type.Union([Type.Literal("upsert"), Type.Literal("remove")]),
  stateKey: Type.String(),
  channel: Type.String(),
  data: JsonValueSchema,
  ts: Type.Number(),
});

const RemoteDurableExtensionEventEntrySchema = Type.Object({
  channel: Type.String(),
  data: JsonValueSchema,
  ts: Type.Number(),
});

export const REMOTE_RUNTIME_TRANSITION_ENTRY = "remote-runtime-transition";
export const REMOTE_SESSION_VERSION_ENTRY = "remote-session-version";
export const REMOTE_DURABLE_EXTENSION_STATE_ENTRY = "remote-durable-extension-state";
export const REMOTE_QUEUE_STATE_ENTRY = "remote-queue-state";
export const REMOTE_RETRY_STATE_ENTRY = "remote-retry-state";
export const REMOTE_COMPACTION_STATE_ENTRY = "remote-compaction-state";
export const REMOTE_BASH_STATE_ENTRY = "remote-bash-state";
export const REMOTE_STREAMING_STATE_ENTRY = "remote-streaming-state";
export const REMOTE_DURABLE_EXTENSION_EVENT_ENTRY = "remote-durable-extension-event";
export { RemoteSessionVersionEntrySchema };

type RuntimeTransition = Static<typeof RemoteRuntimeTransitionEntrySchema>;

type DurableRuntimeDomainState = {
  queue: { depth: number; nextSequence: number; updatedAt: number };
  retry: { status: "idle" | "running"; updatedAt: number };
  compaction: { status: "idle" | "running"; updatedAt: number };
  bash: { isRunning: boolean; hasPendingMessages: boolean; updatedAt: number };
  streaming: { status: "idle" | "streaming"; updatedAt: number };
  version: { version: number; updatedAt: number };
};

export type { DurableRuntimeDomainState };

type DurableExtensionStateTransition = {
  op: "upsert" | "remove";
  stateKey: string;
  channel: string;
  data: JsonValue;
  ts: number;
};

type DurableExtensionEvent = Static<typeof RemoteDurableExtensionEventEntrySchema>;

type RemoteDurableSessionManagerWriter = SessionManager & {
  appendCustomEntry: (customType: string, data: unknown) => void;
  getEntries: () => SessionEntry[];
};

type RemoteDurableSessionManagerReader = SessionManager & {
  getEntries: () => SessionEntry[];
};

function isRemoteDurableSessionManagerWriter(
  sessionManager: SessionManager | undefined,
): sessionManager is RemoteDurableSessionManagerWriter {
  const candidate = asRecord(sessionManager);
  return (
    candidate !== undefined &&
    typeof candidate.appendCustomEntry === "function" &&
    typeof candidate.getEntries === "function"
  );
}

function isRemoteDurableSessionManagerReader(
  sessionManager: SessionManager | undefined,
): sessionManager is RemoteDurableSessionManagerReader {
  const candidate = asRecord(sessionManager);
  return candidate !== undefined && typeof candidate.getEntries === "function";
}

export function persistDurableRuntimeDomainState(input: {
  record: SessionRecord;
  updatedAt: number;
}): void {
  const sessionManager = requireRemoteDurableSessionManagerWriter(
    input.record.runtime.session?.sessionManager,
  );
  if (sessionManager === undefined) {
    return;
  }

  ensureDurableExtensionStateMap(input.record);
  const previous = cloneDurableRuntimeDomainState(
    input.record.durableRuntimeStateCache ?? createInitialDurableRuntimeStateCache(),
  );
  const next = readRuntimeStateFromRecord(input.record, input.updatedAt);
  appendRuntimeTransitions(sessionManager, previous, next);
  if (previous.version.version !== next.version.version) {
    sessionManager.appendCustomEntry(REMOTE_SESSION_VERSION_ENTRY, next.version);
  }
  input.record.durableRuntimeStateCache = cloneDurableRuntimeDomainState(next);
}

export function restoreDurableRuntimeDomainState(record: SessionRecord, now: number): void {
  const sessionManager = requireRemoteDurableSessionManagerReader(
    record.runtime.session?.sessionManager,
  );
  if (sessionManager === undefined) {
    return;
  }

  const persistedState = readDurableRuntimeDomainState(sessionManager.getEntries());
  record.durableRuntimeStateCache = cloneDurableRuntimeDomainState(persistedState);
  ensureDurableExtensionStateMap(record);
  restoreDurableExtensionState(record);
  record.lastDurableSessionVersion = persistedState.version.version;

  const interruptedRuntimeDomains = {
    queue: persistedState.queue.depth > 0,
    retry: persistedState.retry.status === "running",
    compaction: persistedState.compaction.status === "running",
    bash: persistedState.bash.isRunning || persistedState.bash.hasPendingMessages,
    streaming: persistedState.streaming.status === "streaming",
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

  if (Object.values(interruptedRuntimeDomains).some(Boolean)) {
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
  const sessionManager = requireRemoteDurableSessionManagerWriter(
    input.record.runtime.session?.sessionManager,
  );
  if (sessionManager === undefined) {
    return;
  }

  ensureDurableExtensionStateMap(input.record);
  const syncInfo = readRemoteExtensionSyncInfo(input.channel, input.data);
  const transition: DurableExtensionStateTransition = {
    op: syncInfo.deleted ? "remove" : "upsert",
    stateKey: syncInfo.stateKey,
    channel: input.channel,
    data: input.data,
    ts: input.ts,
  };

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
  sessionManager.appendCustomEntry(REMOTE_DURABLE_EXTENSION_STATE_ENTRY, transition);
  applyDurableExtensionEvent(input.record.durableExtensionState, {
    channel: input.channel,
    data: input.data,
    ts: input.ts,
  });
}

export function readDurableExtensionEvents(record: SessionRecord): DurableExtensionEvent[] {
  const sessionManager = requireRemoteDurableSessionManagerReader(
    record.runtime.session?.sessionManager,
  );
  if (sessionManager === undefined) {
    return [];
  }

  return readDurableExtensionEventEntries(sessionManager.getEntries());
}

export function buildDurableExtensionState(record: SessionRecord): Array<{
  channel: string;
  data: JsonValue;
}> {
  const durableExtensionState = ensureDurableExtensionStateMap(record);
  if (!record.durableExtensionStateHydrated) {
    restoreDurableExtensionState(record);
  }

  return [...durableExtensionState.values()].map((value) => ({
    channel: value.channel,
    data: structuredClone(value.data),
  }));
}

function requireRemoteDurableSessionManagerWriter(
  sessionManager: SessionManager | undefined,
): RemoteDurableSessionManagerWriter | undefined {
  if (!isRemoteDurableSessionManagerWriter(sessionManager)) {
    return undefined;
  }

  return sessionManager;
}

function requireRemoteDurableSessionManagerReader(
  sessionManager: SessionManager | undefined,
): RemoteDurableSessionManagerReader | undefined {
  if (!isRemoteDurableSessionManagerReader(sessionManager)) {
    return undefined;
  }

  return sessionManager;
}

function readRuntimeStateFromRecord(
  record: SessionRecord,
  updatedAt: number,
): DurableRuntimeDomainState {
  return {
    queue: {
      depth: record.queue.depth,
      nextSequence: record.queue.nextSequence,
      updatedAt,
    },
    retry: {
      status: record.retry.status === "running" ? "running" : "idle",
      updatedAt,
    },
    compaction: {
      status: record.compaction.status === "running" ? "running" : "idle",
      updatedAt,
    },
    bash: {
      isRunning: record.isBashRunning,
      hasPendingMessages: record.hasPendingBashMessages,
      updatedAt,
    },
    streaming: {
      status: record.streamingState === "streaming" ? "streaming" : "idle",
      updatedAt,
    },
    version: {
      version: record.lastDurableSessionVersion,
      updatedAt,
    },
  };
}

function createInitialDurableRuntimeDomainState(): DurableRuntimeDomainState {
  return {
    queue: { depth: 0, nextSequence: 1, updatedAt: 0 },
    retry: { status: "idle", updatedAt: 0 },
    compaction: { status: "idle", updatedAt: 0 },
    bash: { isRunning: false, hasPendingMessages: false, updatedAt: 0 },
    streaming: { status: "idle", updatedAt: 0 },
    version: { version: 0, updatedAt: 0 },
  };
}

function cloneDurableRuntimeDomainState(
  state: DurableRuntimeDomainState,
): DurableRuntimeDomainState {
  return {
    queue: { ...state.queue },
    retry: { ...state.retry },
    compaction: { ...state.compaction },
    bash: { ...state.bash },
    streaming: { ...state.streaming },
    version: { ...state.version },
  };
}

export function readDurableRuntimeDomainState(entries: SessionEntry[]): DurableRuntimeDomainState {
  const result = createInitialDurableRuntimeDomainState();

  for (const entry of entries) {
    if (entry.type !== "custom") {
      continue;
    }
    if (
      entry.customType === REMOTE_RUNTIME_TRANSITION_ENTRY &&
      Value.Check(RemoteRuntimeTransitionEntrySchema, entry.data)
    ) {
      applyRuntimeTransition(result, Value.Parse(RemoteRuntimeTransitionEntrySchema, entry.data));
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

function appendRuntimeTransitions(
  sessionManager: RemoteDurableSessionManagerWriter,
  previous: DurableRuntimeDomainState,
  next: DurableRuntimeDomainState,
): void {
  if (previous.queue.depth !== next.queue.depth) {
    sessionManager.appendCustomEntry(REMOTE_RUNTIME_TRANSITION_ENTRY, {
      domain: "queue",
      op: "depth_delta",
      delta: next.queue.depth - previous.queue.depth,
      updatedAt: next.queue.updatedAt,
    });
  }
  if (previous.queue.nextSequence !== next.queue.nextSequence) {
    sessionManager.appendCustomEntry(REMOTE_RUNTIME_TRANSITION_ENTRY, {
      domain: "queue",
      op: "next_sequence_set",
      nextSequence: next.queue.nextSequence,
      updatedAt: next.queue.updatedAt,
    });
  }
  if (previous.retry.status !== next.retry.status) {
    sessionManager.appendCustomEntry(REMOTE_RUNTIME_TRANSITION_ENTRY, {
      domain: "retry",
      op: "status_set",
      status: next.retry.status,
      updatedAt: next.retry.updatedAt,
    });
  }
  if (previous.compaction.status !== next.compaction.status) {
    sessionManager.appendCustomEntry(REMOTE_RUNTIME_TRANSITION_ENTRY, {
      domain: "compaction",
      op: "status_set",
      status: next.compaction.status,
      updatedAt: next.compaction.updatedAt,
    });
  }
  if (previous.bash.isRunning !== next.bash.isRunning) {
    sessionManager.appendCustomEntry(REMOTE_RUNTIME_TRANSITION_ENTRY, {
      domain: "bash",
      op: "running_set",
      isRunning: next.bash.isRunning,
      updatedAt: next.bash.updatedAt,
    });
  }
  if (previous.bash.hasPendingMessages !== next.bash.hasPendingMessages) {
    sessionManager.appendCustomEntry(REMOTE_RUNTIME_TRANSITION_ENTRY, {
      domain: "bash",
      op: "pending_messages_set",
      hasPendingMessages: next.bash.hasPendingMessages,
      updatedAt: next.bash.updatedAt,
    });
  }
  if (previous.streaming.status !== next.streaming.status) {
    sessionManager.appendCustomEntry(REMOTE_RUNTIME_TRANSITION_ENTRY, {
      domain: "streaming",
      op: "status_set",
      status: next.streaming.status,
      updatedAt: next.streaming.updatedAt,
    });
  }
}

function applyRuntimeTransition(
  state: DurableRuntimeDomainState,
  transition: RuntimeTransition,
): void {
  switch (transition.domain) {
    case "queue":
      if (transition.op === "depth_delta") {
        state.queue.depth = Math.max(0, state.queue.depth + transition.delta);
      } else {
        state.queue.nextSequence = transition.nextSequence;
      }
      state.queue.updatedAt = transition.updatedAt;
      return;
    case "retry":
      state.retry = { status: transition.status, updatedAt: transition.updatedAt };
      return;
    case "compaction":
      state.compaction = { status: transition.status, updatedAt: transition.updatedAt };
      return;
    case "bash":
      if (transition.op === "running_set") {
        state.bash.isRunning = transition.isRunning;
      } else {
        state.bash.hasPendingMessages = transition.hasPendingMessages;
      }
      state.bash.updatedAt = transition.updatedAt;
      return;
    case "streaming":
      state.streaming = { status: transition.status, updatedAt: transition.updatedAt };
      break;
  }
}

function readDurableExtensionTransitions(
  entries: SessionEntry[],
): DurableExtensionStateTransition[] {
  const result: DurableExtensionStateTransition[] = [];

  for (const entry of entries) {
    if (
      entry.type === "custom" &&
      entry.customType === REMOTE_DURABLE_EXTENSION_STATE_ENTRY &&
      Value.Check(RemoteDurableExtensionStateEntrySchema, entry.data)
    ) {
      result.push(Value.Parse(RemoteDurableExtensionStateEntrySchema, entry.data));
    }
  }

  return result;
}

function readDurableExtensionEventEntries(entries: SessionEntry[]): DurableExtensionEvent[] {
  const result: DurableExtensionEvent[] = [];

  for (const entry of entries) {
    if (
      entry.type === "custom" &&
      entry.customType === REMOTE_DURABLE_EXTENSION_EVENT_ENTRY &&
      Value.Check(RemoteDurableExtensionEventEntrySchema, entry.data)
    ) {
      result.push(Value.Parse(RemoteDurableExtensionEventEntrySchema, entry.data));
    }
  }

  if (result.length > 0) {
    return result;
  }

  return readDurableExtensionTransitions(entries).map((entry) => ({
    channel: entry.channel,
    data: structuredClone(entry.data),
    ts: entry.ts,
  }));
}

function restoreDurableExtensionState(record: SessionRecord): void {
  const durableExtensionState = ensureDurableExtensionStateMap(record);
  durableExtensionState.clear();
  for (const transition of readDurableExtensionEvents(record)) {
    applyDurableExtensionEvent(durableExtensionState, transition);
  }
  record.durableExtensionStateHydrated = true;
}

function ensureDurableExtensionStateMap(
  record: SessionRecord,
): Map<string, { channel: string; data: JsonValue }> {
  if (record.durableExtensionState instanceof Map) {
    return record.durableExtensionState;
  }

  const durableExtensionState = new Map<string, { channel: string; data: JsonValue }>();
  record.durableExtensionState = durableExtensionState;
  return durableExtensionState;
}

function applyDurableExtensionEvent(
  state: Map<string, { channel: string; data: JsonValue }>,
  event: DurableExtensionEvent,
): void {
  const syncInfo = readRemoteExtensionSyncInfo(event.channel, event.data);
  if (syncInfo.deleted) {
    state.delete(syncInfo.stateKey);
    return;
  }

  const previous = state.get(syncInfo.stateKey);
  state.set(syncInfo.stateKey, {
    channel: event.channel,
    data: reduceDurableExtensionEventData(previous?.data, event.data, syncInfo.reducer),
  });
}

function reduceDurableExtensionEventData(
  previous: JsonValue | undefined,
  next: JsonValue,
  reducer: "replace" | "merge",
): JsonValue {
  if (reducer === "replace") {
    return structuredClone(next);
  }

  if (!isPlainJsonObject(previous) || !isPlainJsonObject(next)) {
    return structuredClone(next);
  }

  return {
    ...structuredClone(previous),
    ...structuredClone(next),
  };
}

function isPlainJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== undefined && value !== null && !Array.isArray(value);
}

export function createDurableExtensionRemovalEvent(input: {
  channel: string;
  replaceKey: string | undefined;
}): { channel: string; data: JsonValue } {
  return {
    channel: input.channel,
    data: {
      sync: "durable",
      ...(input.replaceKey === undefined ? {} : { replaceKey: input.replaceKey }),
      deleted: true,
    },
  };
}

export function readDurableExtensionStateFromEntries(entries: SessionEntry[]): Array<{
  channel: string;
  data: JsonValue;
}> {
  const state = new Map<string, { channel: string; data: JsonValue }>();
  for (const event of readDurableExtensionEventEntries(entries)) {
    applyDurableExtensionEvent(state, event);
  }
  return [...state.values()].map((value) => ({
    channel: value.channel,
    data: structuredClone(value.data),
  }));
}

export function readRemoteSessionVersionEntryData(
  value: unknown,
): { version: number; updatedAt: number } | undefined {
  if (!Value.Check(RemoteSessionVersionEntrySchema, value)) {
    return undefined;
  }

  return Value.Parse(RemoteSessionVersionEntrySchema, value);
}

export function readDurableExtensionProjectionKey(channel: string, data: unknown): string {
  return readRemoteExtensionStateKey(channel, data);
}
