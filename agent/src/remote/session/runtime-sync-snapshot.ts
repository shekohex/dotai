import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import type { SessionSnapshot } from "../schemas.js";
import { getExecutorState } from "../../extensions/executor/status.js";
import { getGitState, serializeGitRuntimeState } from "../../extensions/git-state.js";
import { sanitizeRemoteModel, sanitizeSessionEntry } from "../schema-normalization.js";
import { toTransportTranscript } from "../transcript-transport.js";
import { buildDurableExtensionState } from "./durable-runtime-state.js";
import type { SessionRecord } from "./types.js";

export const DEFAULT_SESSION_SNAPSHOT_ENTRIES_LIMIT = 100;

export function buildSessionSnapshotParts(
  record: SessionRecord,
  options?: { entriesLimit?: number; entriesOffset?: number },
): Omit<SessionSnapshot, "version"> {
  const session = readRuntimeSession(record.runtime);
  const sessionEntries = session?.sessionManager.getEntries() ?? [];
  const entriesLimit = options?.entriesLimit ?? DEFAULT_SESSION_SNAPSHOT_ENTRIES_LIMIT;
  const entriesOffset = options?.entriesOffset ?? 0;
  const trimmedEntries = sliceTrailingItems(sessionEntries, entriesLimit, entriesOffset);
  const trimmedTranscript = sliceTrailingItems(record.transcript, entriesLimit, entriesOffset);
  const leafId = session?.sessionManager.getLeafId() ?? null;
  const modelSettings = buildModelSettingsSnapshot(record);
  const queue = {
    depth: record.queue.depth,
    nextSequence: record.queue.nextSequence,
  };
  const live = {
    queuedSteeringMessages: [...record.live.queuedSteeringMessages],
    queuedFollowUpMessages: [...record.live.queuedFollowUpMessages],
    retryAttempt: record.live.retryAttempt,
    ...(record.live.streamingMessage === undefined
      ? {}
      : { streamingMessage: structuredClone(record.live.streamingMessage) }),
    activeToolExecutions: [...record.live.activeToolExecutions.values()].map((execution) => ({
      toolCallId: execution.toolCallId,
      toolName: execution.toolName,
      args: structuredClone(execution.args),
      ...(execution.partialResult === undefined
        ? {}
        : { partialResult: structuredClone(execution.partialResult) }),
    })),
  };
  return {
    sessionId: record.sessionId,
    sessionName: record.sessionName,
    status: record.status,
    cwd: record.cwd,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    activeTools: [...record.activeTools],
    extensions: record.extensions.map((extension) => ({ ...extension })),
    resources: {
      skills: record.resources.skills.map((skill) => ({ ...skill })),
      prompts: record.resources.prompts.map((prompt) => ({ ...prompt })),
      themes: record.resources.themes.map((theme) => ({ ...theme })),
      ...(record.resources.modes === undefined
        ? {}
        : { modes: structuredClone(record.resources.modes) }),
      systemPrompt: record.resources.systemPrompt,
      appendSystemPrompt: [...record.resources.appendSystemPrompt],
    },
    settings: { ...record.settings },
    availableModels: record.availableModels.map((model) => sanitizeRemoteModel({ ...model })),
    modelSettings,
    sessionStats: cloneSessionStats(record.sessionStats),
    contextUsage: record.contextUsage ? { ...record.contextUsage } : undefined,
    usageCost: record.usageCost,
    autoCompactionEnabled: record.autoCompactionEnabled,
    steeringMode: record.steeringMode,
    followUpMode: record.followUpMode,
    executorState: structuredClone(getExecutorState(record.cwd)),
    gitState: structuredClone(serializeGitRuntimeState(getGitState(record.cwd))),
    entries: trimmedEntries.map((entry) => cloneSessionEntry(entry)),
    leafId,
    transcript: toTransportTranscript(trimmedTranscript),
    queue,
    live,
    retry: {
      status: record.retry.status,
    },
    compaction: {
      status: record.compaction.status,
    },
    presence: [...record.presence.values()],
    activeRun: record.activeRun,
    interruptedRuntimeDomains: { ...record.interruptedRuntimeDomains },
    pendingUiRequests: [...record.pendingUiRequests.values()].map(({ request }) =>
      structuredClone(request),
    ),
    uiState: {
      statuses: [...record.uiState.statuses.entries()].map(([statusKey, statusText]) => ({
        statusKey,
        ...(statusText === undefined ? {} : { statusText }),
      })),
      widgets: [...record.uiState.widgets.entries()].map(([widgetKey, widget]) => ({
        widgetKey,
        ...(widget.lines === undefined ? {} : { widgetLines: [...widget.lines] }),
        ...(widget.placement === undefined ? {} : { widgetPlacement: widget.placement }),
      })),
      ...(record.uiState.workingMessage === undefined
        ? {}
        : { workingMessage: record.uiState.workingMessage }),
      ...(record.uiState.hiddenThinkingLabel === undefined
        ? {}
        : { hiddenThinkingLabel: record.uiState.hiddenThinkingLabel }),
      ...(record.uiState.title === undefined ? {} : { title: record.uiState.title }),
      ...(record.uiState.toolsExpanded === undefined
        ? {}
        : { toolsExpanded: record.uiState.toolsExpanded }),
      ...(record.uiState.editorText === undefined ? {} : { editorText: record.uiState.editorText }),
    },
    durableExtensionState: buildDurableExtensionState(record).map((event) => ({
      channel: event.channel,
      data: structuredClone(event.data),
    })),
    streamingState: record.streamingState,
    isBashRunning: record.isBashRunning,
    hasPendingBashMessages: record.hasPendingBashMessages,
    pendingToolCalls: [...record.pendingToolCalls],
    errorMessage: record.errorMessage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
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

function readRuntimeSession(
  runtime: SessionRecord["runtime"],
): SessionRecord["runtime"]["session"] | undefined {
  return runtime.session;
}

function cloneSessionEntry(entry: SessionEntry): SessionEntry {
  return sanitizeSessionEntry({
    ...entry,
    ...(entry.type === "message" ? { message: structuredClone(entry.message) } : {}),
    ...(entry.type === "custom" ? { data: structuredClone(entry.data) } : {}),
    ...(entry.type === "custom_message" ? { content: structuredClone(entry.content) } : {}),
  });
}

function cloneSessionStats(stats: SessionRecord["sessionStats"]): SessionSnapshot["sessionStats"] {
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

function buildModelSettingsSnapshot(record: SessionRecord): SessionSnapshot["modelSettings"] {
  return {
    defaultProvider: record.modelSettings.defaultProvider,
    defaultModel: record.modelSettings.defaultModel,
    defaultThinkingLevel: record.modelSettings.defaultThinkingLevel,
    enabledModels: record.modelSettings.enabledModels
      ? [...record.modelSettings.enabledModels]
      : null,
  };
}
