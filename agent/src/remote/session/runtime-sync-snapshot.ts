import type { SessionSnapshot } from "../schemas.js";
import type { SessionRecord } from "./types.js";

export function buildSessionSnapshotParts(
  record: SessionRecord,
): Omit<SessionSnapshot, "lastSessionStreamOffset" | "lastAppStreamOffsetSeenByServer"> {
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
    pendingToolCalls: [...record.pendingToolCalls],
    errorMessage: record.errorMessage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
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
