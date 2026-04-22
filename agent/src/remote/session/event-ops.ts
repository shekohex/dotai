import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { SessionRecord } from "./types.js";

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
}): boolean {
  return (
    input.previousAutoCompactionEnabled !== input.nextAutoCompactionEnabled ||
    input.previousSteeringMode !== input.nextSteeringMode ||
    input.previousFollowUpMode !== input.nextFollowUpMode
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
  previousCwd: string;
  previousExtensions: SessionRecord["extensions"];
  previousContextUsage: SessionRecord["contextUsage"];
  previousUsageCost: SessionRecord["usageCost"];
  previousSessionStats: SessionRecord["sessionStats"];
  previousAutoCompactionEnabled: SessionRecord["autoCompactionEnabled"];
  previousSteeringMode: SessionRecord["steeringMode"];
  previousFollowUpMode: SessionRecord["followUpMode"];
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
      contextUsage?: SessionRecord["contextUsage"];
      usageCost?: SessionRecord["usageCost"];
      sessionStats?: SessionRecord["sessionStats"];
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
  appendAgentEvent: (record: SessionRecord, event: AgentSessionEvent, ts: number) => void;
  appendSessionStatePatch: (
    record: SessionRecord,
    patch: {
      cwd?: string;
      extensions?: SessionRecord["extensions"];
      contextUsage?: SessionRecord["contextUsage"];
      usageCost?: SessionRecord["usageCost"];
      sessionStats?: SessionRecord["sessionStats"];
      autoCompactionEnabled?: SessionRecord["autoCompactionEnabled"];
      steeringMode?: SessionRecord["steeringMode"];
      followUpMode?: SessionRecord["followUpMode"];
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
  const previousContextUsage = input.record.contextUsage;
  const previousUsageCost = input.record.usageCost;
  const previousSessionStats = cloneSessionStats(input.record.sessionStats);
  const previousAutoCompactionEnabled = input.record.autoCompactionEnabled;
  const previousSteeringMode = input.record.steeringMode;
  const previousFollowUpMode = input.record.followUpMode;
  input.syncFromRuntime(input.record, { now: input.now, updateTimestamp: true });
  input.appendAgentEvent(input.record, input.event, input.now);

  appendSessionStatePatchIfChanged({
    record: input.record,
    previousCwd,
    previousExtensions,
    previousContextUsage,
    previousUsageCost,
    previousSessionStats,
    previousAutoCompactionEnabled,
    previousSteeringMode,
    previousFollowUpMode,
    now: input.now,
    hasExtensionMetadataChange: input.hasExtensionMetadataChange,
    appendSessionStatePatch: input.appendSessionStatePatch,
  });

  input.emitSessionSummaryUpdated(input.record, input.now);
}
