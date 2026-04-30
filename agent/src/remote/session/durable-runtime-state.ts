import type { SessionEntry, SessionManager } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
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

export const REMOTE_QUEUE_STATE_ENTRY = "remote-queue-state";
export const REMOTE_RETRY_STATE_ENTRY = "remote-retry-state";
export const REMOTE_COMPACTION_STATE_ENTRY = "remote-compaction-state";
export const REMOTE_BASH_STATE_ENTRY = "remote-bash-state";
export const REMOTE_STREAMING_STATE_ENTRY = "remote-streaming-state";

type DurableRuntimeDomainState = {
  queue: { depth: number; nextSequence: number; updatedAt: number };
  retry: { status: "idle" | "running"; updatedAt: number };
  compaction: { status: "idle" | "running"; updatedAt: number };
  bash: { isRunning: boolean; hasPendingMessages: boolean; updatedAt: number };
  streaming: { status: "idle" | "streaming"; updatedAt: number };
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
}

export function restoreDurableRuntimeDomainState(record: SessionRecord, now: number): void {
  const sessionManager = record.runtime.session?.sessionManager;
  if (!hasSessionEntries(sessionManager)) {
    return;
  }

  const persistedState = readDurableRuntimeDomainState(sessionManager.getEntries());
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
    }
  }

  return result;
}
