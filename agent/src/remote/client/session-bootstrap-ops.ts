import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ContextUsage, SessionStats } from "@mariozechner/pi-coding-agent";
import { SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import { defaultSettings } from "../../default-settings.js";
import {
  RemoteSettingsSnapshotSchema,
  type RemoteExtensionMetadata,
  type RemoteSettingsSnapshot,
  type SessionSnapshot,
} from "../schemas.js";
import { fromTransportTranscript } from "../transcript-transport.js";
import { assertType } from "../typebox.js";
import type { RemoteModelSettingsState } from "./contracts.js";
import { cloneModel, createFallbackModel } from "./session-models.js";
import { parseModelRef, resolveOptionalThinkingLevel } from "./session-shared.js";
import { initializeMirroredSessionManager } from "./session-manager-mirror.js";

export type RemoteAgentSettings = Exclude<
  Parameters<typeof SettingsManager.inMemory>[0],
  undefined
>;

type TypesMatch<A, B> = A extends B ? (B extends A ? true : false) : false;
type EnsureTrue<T extends true> = T;
type AssertRemoteSettingsTypeParity = EnsureTrue<
  TypesMatch<RemoteSettingsSnapshot, RemoteAgentSettings>
>;
const remoteSettingsTypeParity: AssertRemoteSettingsTypeParity = true;
void remoteSettingsTypeParity;

type SessionStatsPayload = Omit<SessionStats, "sessionFile"> & { sessionFile?: string };

function readSnapshotLiveState(snapshot: SessionSnapshot): SessionSnapshot["live"] {
  return (
    snapshot.live ?? {
      queuedSteeringMessages: [],
      queuedFollowUpMessages: [],
      retryAttempt: 0,
      activeToolExecutions: [],
    }
  );
}

export function createInitialRemoteSessionState(input: {
  snapshot: SessionSnapshot;
  model: Model<Api> | undefined;
  thinkingLevel: ThinkingLevel;
}): {
  messages: AgentMessage[];
  pendingToolCalls: Set<string>;
  isStreaming: boolean;
  model: Model<Api> | undefined;
  thinkingLevel: ThinkingLevel;
  sessionStats: SessionStats;
  contextUsage: ContextUsage | undefined;
  usageCost: number;
  streamingMessage?: AgentMessage;
  errorMessage?: string;
} {
  const sessionStats = cloneSessionStats(input.snapshot.sessionStats);
  const liveState = readSnapshotLiveState(input.snapshot);
  return {
    messages: fromTransportTranscript(input.snapshot.transcript),
    pendingToolCalls: new Set(input.snapshot.pendingToolCalls),
    isStreaming: input.snapshot.streamingState === "streaming",
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    sessionStats,
    contextUsage: sessionStats.contextUsage ?? input.snapshot.contextUsage,
    usageCost: sessionStats.cost,
    streamingMessage:
      liveState.streamingMessage === undefined
        ? undefined
        : fromTransportTranscript([liveState.streamingMessage])[0],
    errorMessage: input.snapshot.errorMessage ?? undefined,
  };
}

function cloneSessionStats(stats: SessionStatsPayload): SessionStats {
  return {
    ...stats,
    sessionFile: stats.sessionFile,
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

export function initializeRemoteSessionMetadata(
  sessionManager: SessionManager,
  snapshot: SessionSnapshot,
): void {
  initializeMirroredSessionManager({
    sessionManager,
    sessionId: snapshot.sessionId,
    sessionName: snapshot.sessionName,
    entries: snapshot.entries,
    leafId: snapshot.leafId,
  });
}

export function applyRemoteSettingsSnapshot(
  remoteModelSettings: RemoteModelSettingsState,
  snapshot: SessionSnapshot,
): void {
  remoteModelSettings.defaultProvider = snapshot.modelSettings.defaultProvider ?? undefined;
  remoteModelSettings.defaultModel = snapshot.modelSettings.defaultModel ?? undefined;
  remoteModelSettings.defaultThinkingLevel = resolveOptionalThinkingLevel(
    snapshot.modelSettings.defaultThinkingLevel,
  );
  remoteModelSettings.enabledModels = snapshot.modelSettings.enabledModels
    ? [...snapshot.modelSettings.enabledModels]
    : undefined;
}

export function applyRemoteExtensionsSnapshot(
  snapshot: SessionSnapshot,
): RemoteExtensionMetadata[] {
  return snapshot.extensions.map((extension) => ({ ...extension }));
}

export function getCombinedExtensionMetadata(input: {
  remoteExtensions: RemoteExtensionMetadata[];
  clientExtensions: RemoteExtensionMetadata[];
}): RemoteExtensionMetadata[] {
  return [
    ...input.remoteExtensions.map((extension) => ({ ...extension })),
    ...input.clientExtensions.map((extension) => ({ ...extension })),
  ];
}

export function applyAuthoritativeCwd(input: {
  currentCwd: string;
  nextCwd: string;
  sessionId: string;
  currentSessionName: string | undefined;
  remoteSettings: RemoteAgentSettings;
}): { sessionManager: SessionManager; settingsManager: SettingsManager } | undefined {
  if (!input.nextCwd || input.nextCwd === input.currentCwd) {
    return undefined;
  }

  const sessionManager = SessionManager.inMemory(input.nextCwd);
  sessionManager.newSession({ id: input.sessionId });
  if (input.currentSessionName !== undefined && input.currentSessionName.length > 0) {
    sessionManager.appendSessionInfo(input.currentSessionName);
  }
  const settingsManager = SettingsManager.inMemory(input.remoteSettings);
  return { sessionManager, settingsManager };
}

function createDefaultRemoteSettings(): RemoteAgentSettings {
  return { ...defaultSettings };
}

export function readRemoteSettingsSnapshot(snapshot: SessionSnapshot): RemoteAgentSettings {
  const settings = snapshot.settings;
  if (settings === undefined) {
    return createDefaultRemoteSettings();
  }

  assertType(RemoteSettingsSnapshotSchema, settings);

  const defaults = createDefaultRemoteSettings();
  return {
    ...defaults,
    ...settings,
  };
}

export function resolveModel(input: {
  modelRef: string;
  createModel: (provider: string, id: string) => Model<Api> | undefined;
}): Model<Api> {
  const parsed = parseModelRef(input.modelRef);
  return cloneModel(
    input.createModel(parsed.provider, parsed.modelId) ??
      createFallbackModel(parsed.provider, parsed.modelId),
  );
}
