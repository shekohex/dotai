import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { SessionRecord } from "./types.js";

function syncActiveRunFromEvent(input: {
  record: SessionRecord;
  event: AgentSessionEvent;
  now: number;
  createRunId: () => string;
}): void {
  if (input.event.type === "agent_start" && !input.record.activeRun) {
    input.record.activeRun = {
      runId: input.createRunId(),
      status: "running",
      triggeringCommandId: "server",
      startedAt: input.now,
      updatedAt: input.now,
      queueDepth: input.record.queue.depth,
    };
    return;
  }

  if (input.event.type === "agent_end") {
    input.record.activeRun = null;
  }
}

function appendSessionStatePatchIfChanged(input: {
  record: SessionRecord;
  previousCwd: string;
  previousExtensions: SessionRecord["extensions"];
  now: number;
  hasExtensionMetadataChange: (
    previous: SessionRecord["extensions"],
    next: SessionRecord["extensions"],
  ) => boolean;
  appendSessionStatePatch: (
    record: SessionRecord,
    patch: {
      cwd?: string;
      extensions?: SessionRecord["extensions"];
    },
    ts: number,
  ) => void;
}): void {
  const cwdChanged = input.previousCwd !== input.record.cwd;
  const extensionsChanged = input.hasExtensionMetadataChange(
    input.previousExtensions,
    input.record.extensions,
  );
  if (!cwdChanged && !extensionsChanged) {
    return;
  }

  input.appendSessionStatePatch(
    input.record,
    {
      ...(cwdChanged ? { cwd: input.record.cwd } : {}),
      ...(extensionsChanged ? { extensions: input.record.extensions } : {}),
    },
    input.now,
  );
}

export function handleSessionEventForRecord(input: {
  record: SessionRecord;
  event: AgentSessionEvent;
  now: number;
  createRunId: () => string;
  syncFromRuntime: (
    record: SessionRecord,
    options: { now: number; updateTimestamp: boolean },
  ) => void;
  hasExtensionMetadataChange: (
    previous: SessionRecord["extensions"],
    next: SessionRecord["extensions"],
  ) => boolean;
  appendAgentEvent: (record: SessionRecord, event: AgentSessionEvent, ts: number) => void;
  appendSessionStatePatch: (
    record: SessionRecord,
    patch: {
      cwd?: string;
      extensions?: SessionRecord["extensions"];
    },
    ts: number,
  ) => void;
  emitSessionSummaryUpdated: (record: SessionRecord, ts: number) => void;
}): void {
  syncActiveRunFromEvent({
    record: input.record,
    event: input.event,
    now: input.now,
    createRunId: input.createRunId,
  });

  const previousCwd = input.record.cwd;
  const previousExtensions = input.record.extensions;
  input.syncFromRuntime(input.record, { now: input.now, updateTimestamp: true });
  input.appendAgentEvent(input.record, input.event, input.now);

  appendSessionStatePatchIfChanged({
    record: input.record,
    previousCwd,
    previousExtensions,
    now: input.now,
    hasExtensionMetadataChange: input.hasExtensionMetadataChange,
    appendSessionStatePatch: input.appendSessionStatePatch,
  });

  input.emitSessionSummaryUpdated(input.record, input.now);
}
