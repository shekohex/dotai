import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import { defaultSettings } from "../../default-settings.js";
import {
  RemoteSettingsSnapshotSchema,
  type RemoteExtensionMetadata,
  type RemoteSettingsSnapshot,
  type SessionSnapshot,
} from "../schemas.js";
import { assertType } from "../typebox.js";
import type { RemoteModelSettingsState } from "./contracts.js";
import {
  cloneModel,
  createFallbackModel,
  patchSettingsManagerForRemoteModelSettings,
} from "./session-models.js";
import {
  normalizeTranscript,
  parseModelRef,
  readPendingToolCallId,
  resolveOptionalThinkingLevel,
} from "./session-shared.js";

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
  errorMessage?: string;
} {
  return {
    messages: normalizeTranscript(input.snapshot.transcript),
    pendingToolCalls: new Set(
      input.snapshot.pendingToolCalls
        .map((call) => readPendingToolCallId(call))
        .filter((value): value is string => value !== undefined),
    ),
    isStreaming: input.snapshot.streamingState === "streaming",
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    errorMessage: input.snapshot.errorMessage ?? undefined,
  };
}

export function initializeRemoteSessionMetadata(
  sessionManager: SessionManager,
  snapshot: SessionSnapshot,
): void {
  sessionManager.newSession({ id: snapshot.sessionId });
  sessionManager.appendSessionInfo(snapshot.sessionName);
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
  const extensions: unknown = Reflect.get(snapshot, "extensions");
  if (!Array.isArray(extensions)) {
    return [];
  }
  return extensions
    .filter(
      (extension): extension is Record<string, unknown> =>
        extension !== null && typeof extension === "object" && !Array.isArray(extension),
    )
    .map((extension) => ({
      id: typeof extension.id === "string" ? extension.id : "unknown",
      host:
        "host" in extension && (extension.host === "server-bound" || extension.host === "ui-only")
          ? extension.host
          : "server-bound",
      path: typeof extension.path === "string" ? extension.path : "unknown",
    }));
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
  remoteModelSettings: RemoteModelSettingsState;
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
  patchSettingsManagerForRemoteModelSettings(settingsManager, () => input.remoteModelSettings);
  return { sessionManager, settingsManager };
}

function createDefaultRemoteSettings(): RemoteAgentSettings {
  return { ...defaultSettings };
}

export function readRemoteSettingsSnapshot(snapshot: SessionSnapshot): RemoteAgentSettings {
  const settings: unknown = Reflect.get(snapshot, "settings");
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
