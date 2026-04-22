import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ContextUsage, SessionStats } from "@mariozechner/pi-coding-agent";
import type { RemoteExtensionMetadata, StreamEventEnvelope } from "../schemas.js";
import type { RemoteModelSettingsState } from "./contracts.js";
import { normalizeAvailableModels } from "./session-models.js";
import { isThinkingLevel, resolveOptionalThinkingLevel } from "./session-shared.js";

type SessionStatePatchPayload = Extract<
  StreamEventEnvelope,
  { kind: "session_state_patch" }
>["payload"];
type SessionStatePatch = SessionStatePatchPayload["patch"];
type SessionStatsPatchPayload = Omit<SessionStats, "sessionFile"> & { sessionFile?: string };

type ApplyRemoteSessionStatePatchInput = {
  payload: SessionStatePatchPayload;
  remoteModelSettings: RemoteModelSettingsState;
  setRemoteAvailableModels: (models: Model<Api>[]) => void;
  setResolvedModel: (modelRef: string) => void;
  setThinkingLevel: (thinkingLevel: ThinkingLevel) => void;
  applyAuthoritativeCwd: (cwd: string) => void;
  setRemoteExtensions: (extensions: RemoteExtensionMetadata[]) => void;
  setSessionName: (sessionName: string) => void;
  setActiveTools: (activeTools: string[]) => void;
  setContextUsage: (contextUsage: ContextUsage | undefined) => void;
  setSessionStats: (sessionStats: SessionStats) => void;
  setUsageCost: (usageCost: number) => void;
  setAutoCompactionEnabled: (enabled: boolean) => void;
  setSteeringMode: (mode: "all" | "one-at-a-time") => void;
  setFollowUpMode: (mode: "all" | "one-at-a-time") => void;
};

export function applyRemoteSessionStatePatch(input: ApplyRemoteSessionStatePatchInput): void {
  const patch = input.payload.patch;

  applyRemoteAvailableModelsPatch(input, patch);
  applyRemoteModelSettingsPatch(input, patch);
  applyRemoteModelAndThinkingPatch(input, patch);
  applyRemoteCwdAndExtensionsPatch(input, patch);
  applyRemoteSessionNamePatch(input, patch);
  applyRemoteActiveToolsPatch(input, patch);
  applyRemoteSessionStatsPatch(input, patch);
  applyRemoteContextUsagePatch(input, patch);
  applyRemoteUsageCostPatch(input, patch);
  applyRemoteSessionBehaviorPatch(input, patch);
}

function applyRemoteAvailableModelsPatch(
  input: ApplyRemoteSessionStatePatchInput,
  patch: SessionStatePatch,
): void {
  const availableModels = patch.availableModels;
  if (availableModels === undefined) {
    return;
  }
  input.setRemoteAvailableModels(normalizeAvailableModels(availableModels));
}

function applyRemoteModelSettingsPatch(
  input: ApplyRemoteSessionStatePatchInput,
  patch: SessionStatePatch,
): void {
  const modelSettings = patch.modelSettings;
  if (modelSettings === undefined) {
    return;
  }
  input.remoteModelSettings.defaultProvider = modelSettings.defaultProvider ?? undefined;
  input.remoteModelSettings.defaultModel = modelSettings.defaultModel ?? undefined;
  input.remoteModelSettings.defaultThinkingLevel = resolveOptionalThinkingLevel(
    modelSettings.defaultThinkingLevel,
  );
  input.remoteModelSettings.enabledModels =
    modelSettings.enabledModels === null ? undefined : [...modelSettings.enabledModels];
}

function applyRemoteModelAndThinkingPatch(
  input: ApplyRemoteSessionStatePatchInput,
  patch: SessionStatePatch,
): void {
  if (patch.model !== undefined) {
    input.setResolvedModel(patch.model);
  }

  const thinkingLevel = patch.thinkingLevel;
  if (isThinkingLevel(thinkingLevel)) {
    input.setThinkingLevel(thinkingLevel);
  }
}

function applyRemoteCwdAndExtensionsPatch(
  input: ApplyRemoteSessionStatePatchInput,
  patch: SessionStatePatch,
): void {
  if (patch.cwd !== undefined) {
    input.applyAuthoritativeCwd(patch.cwd);
  }

  if (patch.extensions !== undefined) {
    input.setRemoteExtensions(patch.extensions.map((extension) => ({ ...extension })));
  }
}

function applyRemoteSessionNamePatch(
  input: ApplyRemoteSessionStatePatchInput,
  patch: SessionStatePatch,
): void {
  if (patch.sessionName !== undefined) {
    input.setSessionName(patch.sessionName);
  }
}

function applyRemoteActiveToolsPatch(
  input: ApplyRemoteSessionStatePatchInput,
  patch: SessionStatePatch,
): void {
  if (patch.activeTools === undefined) {
    return;
  }
  input.setActiveTools([...patch.activeTools]);
}

function applyRemoteContextUsagePatch(
  input: ApplyRemoteSessionStatePatchInput,
  patch: SessionStatePatch,
): void {
  if (patch.contextUsage === undefined) {
    return;
  }

  input.setContextUsage({ ...patch.contextUsage } as ContextUsage);
}

function applyRemoteSessionStatsPatch(
  input: ApplyRemoteSessionStatePatchInput,
  patch: SessionStatePatch,
): void {
  if (patch.sessionStats === undefined) {
    return;
  }

  const sessionStats = cloneSessionStats(patch.sessionStats);
  input.setSessionStats(sessionStats);
  input.setContextUsage(sessionStats.contextUsage);
  input.setUsageCost(sessionStats.cost);
}

function applyRemoteUsageCostPatch(
  input: ApplyRemoteSessionStatePatchInput,
  patch: SessionStatePatch,
): void {
  if (patch.usageCost === undefined) {
    return;
  }
  input.setUsageCost(patch.usageCost);
}

function applyRemoteSessionBehaviorPatch(
  input: ApplyRemoteSessionStatePatchInput,
  patch: SessionStatePatch,
): void {
  if (patch.autoCompactionEnabled !== undefined) {
    input.setAutoCompactionEnabled(patch.autoCompactionEnabled);
  }
  if (patch.steeringMode !== undefined) {
    input.setSteeringMode(patch.steeringMode);
  }
  if (patch.followUpMode !== undefined) {
    input.setFollowUpMode(patch.followUpMode);
  }
}

function cloneSessionStats(stats: SessionStatsPatchPayload): SessionStats {
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
