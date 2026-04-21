import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { RemoteExtensionMetadata } from "../schemas.js";
import type { RemoteModelSettingsState } from "./contracts.js";
import { normalizeAvailableModels } from "./session-models.js";
import {
  isThinkingLevel,
  normalizeRemoteExtensions,
  readObject,
  resolveOptionalThinkingLevel,
} from "./session-shared.js";

type ApplyRemoteSessionStatePatchInput = {
  payload: unknown;
  remoteModelSettings: RemoteModelSettingsState;
  setRemoteAvailableModels: (models: Model<Api>[]) => void;
  setResolvedModel: (modelRef: string) => void;
  setThinkingLevel: (thinkingLevel: ThinkingLevel) => void;
  applyAuthoritativeCwd: (cwd: string) => void;
  setRemoteExtensions: (extensions: RemoteExtensionMetadata[]) => void;
  setSessionName: (sessionName: string) => void;
  setActiveTools: (activeTools: string[]) => void;
};

export function applyRemoteSessionStatePatch(input: ApplyRemoteSessionStatePatchInput): void {
  const payloadObject = readObject(input.payload);
  const patch = payloadObject ? readObject(Reflect.get(payloadObject, "patch")) : undefined;

  applyRemoteAvailableModelsPatch(input, patch);
  applyRemoteModelSettingsPatch(input, patch);
  applyRemoteModelAndThinkingPatch(input, patch);
  applyRemoteCwdAndExtensionsPatch(input, patch);
  applyRemoteSessionNamePatch(input, patch);
  applyRemoteActiveToolsPatch(input, patch);
}

function applyRemoteAvailableModelsPatch(
  input: ApplyRemoteSessionStatePatchInput,
  patch: Record<string, unknown> | undefined,
): void {
  const availableModels = patch ? Reflect.get(patch, "availableModels") : undefined;
  if (availableModels === undefined) {
    return;
  }
  input.setRemoteAvailableModels(normalizeAvailableModels(availableModels));
}

function applyRemoteModelSettingsPatch(
  input: ApplyRemoteSessionStatePatchInput,
  patch: Record<string, unknown> | undefined,
): void {
  const modelSettings = patch ? readObject(Reflect.get(patch, "modelSettings")) : undefined;
  if (!modelSettings) {
    return;
  }
  const defaultProvider = Reflect.get(modelSettings, "defaultProvider");
  const defaultModel = Reflect.get(modelSettings, "defaultModel");
  const defaultThinkingLevel = Reflect.get(modelSettings, "defaultThinkingLevel");
  const enabledModels = Reflect.get(modelSettings, "enabledModels");

  input.remoteModelSettings.defaultProvider =
    typeof defaultProvider === "string" ? defaultProvider : undefined;
  input.remoteModelSettings.defaultModel =
    typeof defaultModel === "string" ? defaultModel : undefined;
  input.remoteModelSettings.defaultThinkingLevel =
    resolveOptionalThinkingLevel(defaultThinkingLevel);
  input.remoteModelSettings.enabledModels =
    Array.isArray(enabledModels) && enabledModels.every((item) => typeof item === "string")
      ? [...enabledModels]
      : undefined;
}

function applyRemoteModelAndThinkingPatch(
  input: ApplyRemoteSessionStatePatchInput,
  patch: Record<string, unknown> | undefined,
): void {
  const model = patch ? Reflect.get(patch, "model") : undefined;
  if (typeof model === "string") {
    input.setResolvedModel(model);
  }

  const thinkingLevel = patch ? Reflect.get(patch, "thinkingLevel") : undefined;
  if (isThinkingLevel(thinkingLevel)) {
    input.setThinkingLevel(thinkingLevel);
  }
}

function applyRemoteCwdAndExtensionsPatch(
  input: ApplyRemoteSessionStatePatchInput,
  patch: Record<string, unknown> | undefined,
): void {
  const cwd = patch ? Reflect.get(patch, "cwd") : undefined;
  if (typeof cwd === "string") {
    input.applyAuthoritativeCwd(cwd);
  }

  const extensions = patch ? Reflect.get(patch, "extensions") : undefined;
  if (extensions !== undefined) {
    input.setRemoteExtensions(
      normalizeRemoteExtensions(extensions).map((extension) => ({ ...extension })),
    );
  }
}

function applyRemoteSessionNamePatch(
  input: ApplyRemoteSessionStatePatchInput,
  patch: Record<string, unknown> | undefined,
): void {
  const sessionName = patch ? Reflect.get(patch, "sessionName") : undefined;
  if (typeof sessionName === "string") {
    input.setSessionName(sessionName);
  }
}

function applyRemoteActiveToolsPatch(
  input: ApplyRemoteSessionStatePatchInput,
  patch: Record<string, unknown> | undefined,
): void {
  const activeTools = patch ? Reflect.get(patch, "activeTools") : undefined;
  if (!Array.isArray(activeTools) || !activeTools.every((tool) => typeof tool === "string")) {
    return;
  }
  input.setActiveTools([...activeTools]);
}
