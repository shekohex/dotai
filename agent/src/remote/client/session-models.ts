import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry, SettingsManager } from "@mariozechner/pi-coding-agent";
import { Value } from "typebox/value";
import { RemoteModelSchema, type SettingsUpdateRequest } from "../schemas.js";
import type { RemoteModelSettingsState } from "./contracts.js";

function isModelLike(value: unknown): value is Model<Api> {
  if (!Value.Check(RemoteModelSchema, value)) {
    return false;
  }
  return true;
}

export function normalizeAvailableModels(value: unknown): Model<Api>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((model): model is Model<Api> => isModelLike(model))
    .map((model) => cloneModel(model));
}

export function createFallbackModel(provider: string, modelId: string): Model<Api> {
  return {
    provider,
    id: modelId,
    name: `${provider}/${modelId}`,
    baseUrl: "https://remote.invalid",
    api: "responses",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 0,
    maxTokens: 0,
  };
}

export function cloneModel(model: Model<Api>): Model<Api> {
  const cloned: Model<Api> = {
    ...model,
    input: [...model.input],
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
  };

  if (model.headers !== undefined) {
    cloned.headers = { ...model.headers };
  }

  if (model.compat === undefined) {
    return cloned;
  }

  cloned.compat = model.compat as Model<Api>["compat"];
  return cloned;
}

export function patchModelRegistryForRemoteCatalog(
  modelRegistry: ModelRegistry,
  getAvailableModels: () => readonly Model<Api>[],
): void {
  modelRegistry.refresh = () => {};
  modelRegistry.getError = () => {};
  modelRegistry.getAll = () => getAvailableModels().map((model) => cloneModel(model));
  modelRegistry.getAvailable = () => getAvailableModels().map((model) => cloneModel(model));
  modelRegistry.find = (provider: string, modelId: string) => {
    const model = getAvailableModels().find(
      (candidate) => candidate.provider === provider && candidate.id === modelId,
    );
    return model ? cloneModel(model) : undefined;
  };
  modelRegistry.getApiKeyForProvider = (provider: string) => {
    return Promise.resolve(
      getAvailableModels().some((model) => model.provider === provider)
        ? "remote-managed"
        : undefined,
    );
  };
  modelRegistry.hasConfiguredAuth = (_model: Model<Api>) => true;
}

export function patchSettingsManagerForRemoteModelSettings(
  settingsManager: SettingsManager,
  getRemoteSettings: () => RemoteModelSettingsState,
  applyMutation?: (request: SettingsUpdateRequest, rollback: () => void, label: string) => void,
): void {
  settingsManager.getDefaultProvider = () => getRemoteSettings().defaultProvider;
  settingsManager.getDefaultModel = () => getRemoteSettings().defaultModel;
  settingsManager.getDefaultThinkingLevel = () => getRemoteSettings().defaultThinkingLevel;
  settingsManager.getEnabledModels = () => {
    const enabled = getRemoteSettings().enabledModels;
    return enabled ? [...enabled] : undefined;
  };
  settingsManager.setDefaultProvider = (provider: string) => {
    const previous = { ...getRemoteSettings() };
    getRemoteSettings().defaultProvider = provider;
    applyMutation?.(
      { method: "setDefaultProvider", args: [provider] },
      () => {
        restoreRemoteModelSettings(getRemoteSettings(), previous);
      },
      "Update remote settings",
    );
  };
  settingsManager.setDefaultModel = (modelId: string) => {
    const previous = { ...getRemoteSettings() };
    getRemoteSettings().defaultModel = modelId;
    applyMutation?.(
      { method: "setDefaultModel", args: [modelId] },
      () => {
        restoreRemoteModelSettings(getRemoteSettings(), previous);
      },
      "Update remote settings",
    );
  };
  settingsManager.setDefaultModelAndProvider = (provider: string, modelId: string) => {
    const previous = { ...getRemoteSettings() };
    const remote = getRemoteSettings();
    remote.defaultProvider = provider;
    remote.defaultModel = modelId;
    applyMutation?.(
      { method: "setDefaultModelAndProvider", args: [provider, modelId] },
      () => {
        restoreRemoteModelSettings(getRemoteSettings(), previous);
      },
      "Update remote settings",
    );
  };
  settingsManager.setDefaultThinkingLevel = (level: ThinkingLevel) => {
    const previous = { ...getRemoteSettings() };
    getRemoteSettings().defaultThinkingLevel = level;
    applyMutation?.(
      { method: "setDefaultThinkingLevel", args: [level] },
      () => {
        restoreRemoteModelSettings(getRemoteSettings(), previous);
      },
      "Update remote settings",
    );
  };
  settingsManager.setEnabledModels = (patterns: string[] | undefined) => {
    const previous = { ...getRemoteSettings() };
    getRemoteSettings().enabledModels = patterns ? [...patterns] : undefined;
    applyMutation?.(
      { method: "setEnabledModels", args: [patterns ?? null] },
      () => {
        restoreRemoteModelSettings(getRemoteSettings(), previous);
      },
      "Update remote settings",
    );
  };
}

function restoreRemoteModelSettings(
  target: RemoteModelSettingsState,
  previous: RemoteModelSettingsState,
): void {
  target.defaultProvider = previous.defaultProvider;
  target.defaultModel = previous.defaultModel;
  target.defaultThinkingLevel = previous.defaultThinkingLevel;
  target.enabledModels = previous.enabledModels ? [...previous.enabledModels] : undefined;
}
