import { readFileSync } from "node:fs";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  parseSessionEntries,
  type FileEntry,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { getExecutorState } from "../../extensions/executor/status.js";
import { getGitState, serializeGitRuntimeState } from "../../extensions/git-state.js";
import type { SessionSnapshot } from "../schemas.js";
import type { SessionCatalogRecord } from "../session-catalog.js";
import { normalizeCommittedSessionEntries } from "./committed-history.js";
import { readAuthoritativeSessionMetadata } from "./authoritative-session-metadata.js";
import {
  readDurableExtensionStateFromEntries,
  readDurableRuntimeDomainState,
} from "./durable-runtime-state.js";
import { toTransportTranscript } from "../transcript-transport.js";

export function loadUnloadedSessionSnapshot(input: {
  record: SessionCatalogRecord;
  entriesLimit?: number;
  entriesOffset?: number;
}): SessionSnapshot {
  const entries = parseSessionEntries(readFileSync(input.record.sessionPath, "utf8"))
    .filter((entry): entry is SessionEntry => isSessionEntry(entry))
    .map((entry) => structuredClone(entry));
  const normalizedEntries = normalizeCommittedSessionEntries(entries);
  const transcript = normalizedEntries
    .filter(
      (entry): entry is Extract<(typeof normalizedEntries)[number], { type: "message" }> =>
        entry.type === "message",
    )
    .map((entry) => structuredClone(entry.message));
  const durableRuntimeState = readDurableRuntimeDomainState(entries);
  const authoritativeMetadata = readAuthoritativeSessionMetadata(entries);
  const interruptedRuntimeDomains = {
    queue: durableRuntimeState.queue.depth > 0,
    retry: durableRuntimeState.retry.status === "running",
    compaction: durableRuntimeState.compaction.status === "running",
    bash: durableRuntimeState.bash.isRunning || durableRuntimeState.bash.hasPendingMessages,
    streaming: durableRuntimeState.streaming.status === "streaming",
  };
  const activeRun = Object.values(interruptedRuntimeDomains).some(Boolean)
    ? {
        runId: "interrupted",
        status: "interrupted" as const,
        triggeringCommandId: "server-recovery",
        startedAt: input.record.modifiedAt,
        updatedAt: input.record.modifiedAt,
        queueDepth: 0,
      }
    : null;
  const entriesLimit = input.entriesLimit ?? 100;
  const entriesOffset = input.entriesOffset ?? 0;

  return {
    sessionId: input.record.sessionId,
    ...(input.record.sessionName === undefined ? {} : { sessionName: input.record.sessionName }),
    status: "idle",
    cwd: input.record.cwd,
    model: authoritativeMetadata?.model ?? "pi-remote-faux/pi-remote-faux-1",
    thinkingLevel: authoritativeMetadata?.thinkingLevel ?? "medium",
    activeTools: authoritativeMetadata
      ? [...authoritativeMetadata.activeTools]
      : ["read", "bash", "edit", "write"],
    extensions: authoritativeMetadata?.extensions.map((extension) => ({ ...extension })) ?? [],
    resources: authoritativeMetadata?.resources
      ? structuredClone(authoritativeMetadata.resources)
      : {
          skills: [],
          prompts: [],
          themes: [],
          systemPrompt: null,
          appendSystemPrompt: [],
        },
    settings: authoritativeMetadata ? { ...authoritativeMetadata.settings } : {},
    availableModels: authoritativeMetadata?.availableModels.map((model) => ({ ...model })) ?? [],
    modelSettings: authoritativeMetadata
      ? {
          defaultProvider: authoritativeMetadata.modelSettings.defaultProvider,
          defaultModel: authoritativeMetadata.modelSettings.defaultModel,
          defaultThinkingLevel: authoritativeMetadata.modelSettings.defaultThinkingLevel,
          enabledModels: authoritativeMetadata.modelSettings.enabledModels
            ? [...authoritativeMetadata.modelSettings.enabledModels]
            : null,
        }
      : {
          defaultProvider: null,
          defaultModel: null,
          defaultThinkingLevel: null,
          enabledModels: null,
        },
    sessionStats: authoritativeMetadata
      ? {
          ...authoritativeMetadata.sessionStats,
          tokens: { ...authoritativeMetadata.sessionStats.tokens },
          ...(authoritativeMetadata.sessionStats.contextUsage
            ? { contextUsage: { ...authoritativeMetadata.sessionStats.contextUsage } }
            : {}),
        }
      : buildSessionStats(input.record, transcript),
    contextUsage: authoritativeMetadata?.contextUsage
      ? { ...authoritativeMetadata.contextUsage }
      : undefined,
    usageCost: authoritativeMetadata?.usageCost ?? 0,
    autoCompactionEnabled: authoritativeMetadata?.autoCompactionEnabled ?? false,
    steeringMode: authoritativeMetadata?.steeringMode ?? "all",
    followUpMode: authoritativeMetadata?.followUpMode ?? "all",
    executorState: structuredClone(getExecutorState(input.record.cwd)),
    gitState: structuredClone(serializeGitRuntimeState(getGitState(input.record.cwd))),
    entries: sliceTrailingItems(normalizedEntries, entriesLimit, entriesOffset),
    leafId: null,
    transcript: toTransportTranscript(sliceTrailingItems(transcript, entriesLimit, entriesOffset)),
    queue: {
      depth: interruptedRuntimeDomains.queue ? 0 : durableRuntimeState.queue.depth,
      nextSequence: durableRuntimeState.queue.nextSequence,
    },
    live: {
      queuedSteeringMessages: [],
      queuedFollowUpMessages: [],
      retryAttempt: 0,
      activeToolExecutions: [],
    },
    retry: { status: interruptedRuntimeDomains.retry ? "interrupted" : "idle" },
    compaction: { status: interruptedRuntimeDomains.compaction ? "interrupted" : "idle" },
    presence: [],
    activeRun,
    interruptedRuntimeDomains,
    pendingUiRequests: [],
    uiState: { statuses: [], widgets: [] },
    durableExtensionState: readDurableExtensionStateFromEntries(entries),
    version: String(
      durableRuntimeState.version.version > 0
        ? durableRuntimeState.version.version
        : input.record.durableVersion,
    ),
    streamingState: interruptedRuntimeDomains.streaming ? "interrupted" : "idle",
    isBashRunning: false,
    hasPendingBashMessages: false,
    pendingToolCalls: [],
    errorMessage: null,
    createdAt: input.record.createdAt,
    updatedAt: input.record.modifiedAt,
  };
}

function isSessionEntry(entry: FileEntry): entry is SessionEntry {
  return entry.type !== "session";
}

function buildSessionStats(
  record: SessionCatalogRecord,
  transcript: AgentMessage[],
): SessionSnapshot["sessionStats"] {
  return {
    sessionFile: record.sessionPath,
    sessionId: record.sessionId,
    userMessages: transcript.filter((message) => message.role === "user").length,
    assistantMessages: transcript.filter((message) => message.role === "assistant").length,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: record.messageCount,
    tokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
    cost: 0,
  };
}

function sliceTrailingItems<T>(items: T[], limit: number, offset: number): T[] {
  if (limit <= 0) {
    return [];
  }
  const normalizedOffset = Math.max(0, offset);
  const exclusiveEnd = Math.max(0, items.length - normalizedOffset);
  const start = Math.max(0, exclusiveEnd - limit);
  return items.slice(start, exclusiveEnd);
}
