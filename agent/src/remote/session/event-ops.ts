import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { toJsonValue } from "../json-value.js";
import type { SessionRecord } from "./types.js";

export function readDurableRuntimeState(record: SessionRecord): {
  queueDepth: number;
  nextSequence: number;
  retryStatus: SessionRecord["retry"]["status"];
  compactionStatus: SessionRecord["compaction"]["status"];
  isBashRunning: boolean;
  hasPendingBashMessages: boolean;
  streamingState: SessionRecord["streamingState"];
} {
  return {
    queueDepth: record.queue.depth,
    nextSequence: record.queue.nextSequence,
    retryStatus: record.retry.status,
    compactionStatus: record.compaction.status,
    isBashRunning: record.isBashRunning,
    hasPendingBashMessages: record.hasPendingBashMessages,
    streamingState: record.streamingState,
  };
}

export function didDurableRuntimeStateChange(
  previous: ReturnType<typeof readDurableRuntimeState>,
  record: SessionRecord,
): boolean {
  return (
    previous.queueDepth !== record.queue.depth ||
    previous.nextSequence !== record.queue.nextSequence ||
    previous.retryStatus !== record.retry.status ||
    previous.compactionStatus !== record.compaction.status ||
    previous.isBashRunning !== record.isBashRunning ||
    previous.hasPendingBashMessages !== record.hasPendingBashMessages ||
    previous.streamingState !== record.streamingState
  );
}

function ensureLiveState(record: SessionRecord): SessionRecord["live"] {
  if (record.live !== undefined) {
    return record.live;
  }

  const liveState: SessionRecord["live"] = {
    queuedSteeringMessages: [],
    queuedFollowUpMessages: [],
    retryAttempt: 0,
    streamingMessage: undefined,
    activeToolExecutions: new Map(),
  };
  record.live = liveState;
  return liveState;
}

function applyLiveOverlayEvent(record: SessionRecord, event: AgentSessionEvent): void {
  const liveState = ensureLiveState(record);
  switch (event.type) {
    case "agent_start":
    case "compaction_end":
    case "compaction_start":
    case "turn_end":
    case "turn_start":
      break;
    case "agent_end":
      liveState.streamingMessage = undefined;
      liveState.activeToolExecutions.clear();
      break;
    case "message_start":
    case "message_update":
      if (event.message.role === "assistant") {
        liveState.streamingMessage = event.message;
      }
      break;
    case "message_end":
      if (event.message.role === "assistant") {
        liveState.streamingMessage = undefined;
      }
      break;
    case "tool_execution_start":
      liveState.activeToolExecutions.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: toJsonValue(event.args) ?? null,
        partialResult: undefined,
      });
      break;
    case "tool_execution_update":
      liveState.activeToolExecutions.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: toJsonValue(event.args) ?? null,
        partialResult: toJsonValue(event.partialResult) ?? null,
      });
      break;
    case "tool_execution_end":
      liveState.activeToolExecutions.delete(event.toolCallId);
      break;
    case "queue_update":
      liveState.queuedSteeringMessages = [...event.steering];
      liveState.queuedFollowUpMessages = [...event.followUp];
      break;
    case "auto_retry_start":
    case "auto_retry_end":
      liveState.retryAttempt = event.attempt;
      break;
  }
}

function hasContextUsageChange(
  previous: SessionRecord["contextUsage"],
  next: SessionRecord["contextUsage"],
): boolean {
  if (!previous && !next) {
    return false;
  }
  if (!previous || !next) {
    return true;
  }
  return (
    previous.tokens !== next.tokens ||
    previous.contextWindow !== next.contextWindow ||
    previous.percent !== next.percent
  );
}

function hasUsageCostChange(previous: number, next: number): boolean {
  return previous !== next;
}

function hasSessionStatsChange(
  previous: SessionRecord["sessionStats"],
  next: SessionRecord["sessionStats"],
): boolean {
  return (
    previous.sessionFile !== next.sessionFile ||
    previous.sessionId !== next.sessionId ||
    previous.userMessages !== next.userMessages ||
    previous.assistantMessages !== next.assistantMessages ||
    previous.toolCalls !== next.toolCalls ||
    previous.toolResults !== next.toolResults ||
    previous.totalMessages !== next.totalMessages ||
    previous.tokens.input !== next.tokens.input ||
    previous.tokens.output !== next.tokens.output ||
    previous.tokens.cacheRead !== next.tokens.cacheRead ||
    previous.tokens.cacheWrite !== next.tokens.cacheWrite ||
    previous.tokens.total !== next.tokens.total ||
    previous.cost !== next.cost ||
    hasContextUsageChange(previous.contextUsage, next.contextUsage)
  );
}

function cloneSessionStats(stats: SessionRecord["sessionStats"]): SessionRecord["sessionStats"] {
  return {
    ...stats,
    tokens: {
      input: stats.tokens.input,
      output: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
      total: stats.tokens.total,
    },
    ...(stats.contextUsage ? { contextUsage: { ...stats.contextUsage } } : {}),
  };
}

function hasSessionBehaviorChange(input: {
  previousAutoCompactionEnabled: boolean;
  nextAutoCompactionEnabled: boolean;
  previousSteeringMode: SessionRecord["steeringMode"];
  nextSteeringMode: SessionRecord["steeringMode"];
  previousFollowUpMode: SessionRecord["followUpMode"];
  nextFollowUpMode: SessionRecord["followUpMode"];
  previousIsBashRunning: boolean;
  nextIsBashRunning: boolean;
  previousHasPendingBashMessages: boolean;
  nextHasPendingBashMessages: boolean;
}): boolean {
  return (
    input.previousAutoCompactionEnabled !== input.nextAutoCompactionEnabled ||
    input.previousSteeringMode !== input.nextSteeringMode ||
    input.previousFollowUpMode !== input.nextFollowUpMode ||
    input.previousIsBashRunning !== input.nextIsBashRunning ||
    input.previousHasPendingBashMessages !== input.nextHasPendingBashMessages
  );
}

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
  sessionVersion: string;
  previousCwd: string;
  previousExtensions: SessionRecord["extensions"];
  previousContextUsage: SessionRecord["contextUsage"];
  previousUsageCost: SessionRecord["usageCost"];
  previousSessionStats: SessionRecord["sessionStats"];
  previousAutoCompactionEnabled: SessionRecord["autoCompactionEnabled"];
  previousSteeringMode: SessionRecord["steeringMode"];
  previousFollowUpMode: SessionRecord["followUpMode"];
  previousIsBashRunning: boolean;
  previousHasPendingBashMessages: boolean;
  now: number;
  hasExtensionMetadataChange: (
    previous: SessionRecord["extensions"],
    next: SessionRecord["extensions"],
  ) => boolean;
  appendSessionStatePatch: (
    record: SessionRecord,
    sessionVersion: string,
    patch: {
      cwd?: string;
      extensions?: SessionRecord["extensions"];
      contextUsage?: SessionRecord["contextUsage"];
      usageCost?: SessionRecord["usageCost"];
      sessionStats?: SessionRecord["sessionStats"];
      isBashRunning?: boolean;
      hasPendingBashMessages?: boolean;
      autoCompactionEnabled?: SessionRecord["autoCompactionEnabled"];
      steeringMode?: SessionRecord["steeringMode"];
      followUpMode?: SessionRecord["followUpMode"];
    },
    ts: number,
  ) => void;
}): void {
  const cwdChanged = input.previousCwd !== input.record.cwd;
  const extensionsChanged = input.hasExtensionMetadataChange(
    input.previousExtensions,
    input.record.extensions,
  );
  const contextUsageChanged = hasContextUsageChange(
    input.previousContextUsage,
    input.record.contextUsage,
  );
  const usageCostChanged = hasUsageCostChange(input.previousUsageCost, input.record.usageCost);
  const sessionStatsChanged = hasSessionStatsChange(
    input.previousSessionStats,
    input.record.sessionStats,
  );
  const sessionBehaviorChanged = hasSessionBehaviorChange({
    previousAutoCompactionEnabled: input.previousAutoCompactionEnabled,
    nextAutoCompactionEnabled: input.record.autoCompactionEnabled,
    previousSteeringMode: input.previousSteeringMode,
    nextSteeringMode: input.record.steeringMode,
    previousFollowUpMode: input.previousFollowUpMode,
    nextFollowUpMode: input.record.followUpMode,
    previousIsBashRunning: input.previousIsBashRunning,
    nextIsBashRunning: input.record.isBashRunning,
    previousHasPendingBashMessages: input.previousHasPendingBashMessages,
    nextHasPendingBashMessages: input.record.hasPendingBashMessages,
  });
  if (
    !cwdChanged &&
    !extensionsChanged &&
    !contextUsageChanged &&
    !usageCostChanged &&
    !sessionStatsChanged &&
    !sessionBehaviorChanged
  ) {
    return;
  }

  input.appendSessionStatePatch(
    input.record,
    input.sessionVersion,
    {
      ...(cwdChanged ? { cwd: input.record.cwd } : {}),
      ...(extensionsChanged ? { extensions: input.record.extensions } : {}),
      ...(contextUsageChanged ? { contextUsage: input.record.contextUsage } : {}),
      ...(usageCostChanged ? { usageCost: input.record.usageCost } : {}),
      ...(sessionStatsChanged
        ? { sessionStats: cloneSessionStats(input.record.sessionStats) }
        : {}),
      ...(sessionBehaviorChanged
        ? {
            autoCompactionEnabled: input.record.autoCompactionEnabled,
            isBashRunning: input.record.isBashRunning,
            hasPendingBashMessages: input.record.hasPendingBashMessages,
            steeringMode: input.record.steeringMode,
            followUpMode: input.record.followUpMode,
          }
        : {}),
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
  appendAgentEvent: (
    record: SessionRecord,
    event: AgentSessionEvent,
    ts: number,
    sessionVersion: string,
  ) => void;
  appendSessionStatePatch: (
    record: SessionRecord,
    sessionVersion: string,
    patch: {
      cwd?: string;
      extensions?: SessionRecord["extensions"];
      contextUsage?: SessionRecord["contextUsage"];
      usageCost?: SessionRecord["usageCost"];
      sessionStats?: SessionRecord["sessionStats"];
      isBashRunning?: boolean;
      hasPendingBashMessages?: boolean;
      autoCompactionEnabled?: SessionRecord["autoCompactionEnabled"];
      steeringMode?: SessionRecord["steeringMode"];
      followUpMode?: SessionRecord["followUpMode"];
    },
    ts: number,
  ) => void;
  emitSessionSummaryUpdated: (record: SessionRecord, ts: number) => void;
}): boolean {
  const previousDurableRuntimeState = readDurableRuntimeState(input.record);

  syncActiveRunFromEvent({
    record: input.record,
    event: input.event,
    now: input.now,
    createRunId: input.createRunId,
  });
  applyLiveOverlayEvent(input.record, input.event);

  const previousCwd = input.record.cwd;
  const previousExtensions = input.record.extensions;
  const previousContextUsage = input.record.contextUsage;
  const previousUsageCost = input.record.usageCost;
  const previousSessionStats = cloneSessionStats(input.record.sessionStats);
  const previousAutoCompactionEnabled = input.record.autoCompactionEnabled;
  const previousSteeringMode = input.record.steeringMode;
  const previousFollowUpMode = input.record.followUpMode;
  const previousIsBashRunning = input.record.isBashRunning;
  const previousHasPendingBashMessages = input.record.hasPendingBashMessages;
  input.syncFromRuntime(input.record, { now: input.now, updateTimestamp: true });
  const durableRuntimeStateChanged = didDurableRuntimeStateChange(
    previousDurableRuntimeState,
    input.record,
  );
  const sessionVersion = String(
    input.record.lastDurableSessionVersion + (durableRuntimeStateChanged ? 1 : 0),
  );
  input.appendAgentEvent(input.record, input.event, input.now, sessionVersion);

  appendSessionStatePatchIfChanged({
    record: input.record,
    sessionVersion,
    previousCwd,
    previousExtensions,
    previousContextUsage,
    previousUsageCost,
    previousSessionStats,
    previousAutoCompactionEnabled,
    previousSteeringMode,
    previousFollowUpMode,
    previousIsBashRunning,
    previousHasPendingBashMessages,
    now: input.now,
    hasExtensionMetadataChange: input.hasExtensionMetadataChange,
    appendSessionStatePatch: input.appendSessionStatePatch,
  });

  input.emitSessionSummaryUpdated(input.record, input.now);
  return durableRuntimeStateChanged;
}
