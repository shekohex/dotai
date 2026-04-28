import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import type { SessionSnapshot } from "../schemas.js";
import type { SessionRecord } from "./types.js";

export function buildSessionSnapshotParts(
  record: SessionRecord,
): Omit<SessionSnapshot, "lastSessionStreamOffset" | "lastAppStreamOffsetSeenByServer"> {
  const session = readRuntimeSession(record.runtime);
  const sessionEntries = session?.sessionManager.getEntries() ?? [];
  const leafId = session?.sessionManager.getLeafId() ?? null;
  const modelSettings = buildModelSettingsSnapshot(record);
  const queue = {
    depth: record.queue.depth,
    nextSequence: record.queue.nextSequence,
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
      systemPrompt: record.resources.systemPrompt,
      appendSystemPrompt: [...record.resources.appendSystemPrompt],
    },
    settings: { ...record.settings },
    availableModels: record.availableModels.map((model) => ({ ...model })),
    modelSettings,
    sessionStats: cloneSessionStats(record.sessionStats),
    contextUsage: record.contextUsage ? { ...record.contextUsage } : undefined,
    usageCost: record.usageCost,
    autoCompactionEnabled: record.autoCompactionEnabled,
    steeringMode: record.steeringMode,
    followUpMode: record.followUpMode,
    entries: sessionEntries.map((entry) => cloneSessionEntry(entry)),
    leafId,
    transcript: [...record.transcript],
    queue,
    retry: {
      status: record.retry.status,
    },
    compaction: {
      status: record.compaction.status,
    },
    presence: [...record.presence.values()],
    activeRun: record.activeRun,
    streamingState: record.streamingState,
    isBashRunning: record.isBashRunning,
    hasPendingBashMessages: record.hasPendingBashMessages,
    pendingToolCalls: [...record.pendingToolCalls],
    errorMessage: record.errorMessage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function readRuntimeSession(
  runtime: SessionRecord["runtime"],
): SessionRecord["runtime"]["session"] | undefined {
  if (!("session" in runtime)) {
    return undefined;
  }

  return runtime.session;
}

function cloneSessionEntry(entry: SessionEntry): SessionEntry {
  return {
    ...entry,
    ...(entry.type === "message" ? { message: structuredClone(entry.message) } : {}),
    ...(entry.type === "compaction" || entry.type === "branch_summary"
      ? { details: structuredClone(entry.details) }
      : {}),
    ...(entry.type === "custom" ? { data: structuredClone(entry.data) } : {}),
    ...(entry.type === "custom_message"
      ? {
          content: structuredClone(entry.content),
          details: structuredClone(entry.details),
        }
      : {}),
  };
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
