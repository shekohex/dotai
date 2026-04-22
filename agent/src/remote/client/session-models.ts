import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry, SettingsManager } from "@mariozechner/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import { RemoteModelSchema } from "../schemas.js";
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
): void {
  settingsManager.getDefaultProvider = () => getRemoteSettings().defaultProvider;
  settingsManager.getDefaultModel = () => getRemoteSettings().defaultModel;
  settingsManager.getDefaultThinkingLevel = () => getRemoteSettings().defaultThinkingLevel;
  settingsManager.getEnabledModels = () => {
    const enabled = getRemoteSettings().enabledModels;
    return enabled ? [...enabled] : undefined;
  };
  settingsManager.setDefaultProvider = (provider: string) => {
    getRemoteSettings().defaultProvider = provider;
  };
  settingsManager.setDefaultModel = (modelId: string) => {
    getRemoteSettings().defaultModel = modelId;
  };
  settingsManager.setDefaultModelAndProvider = (provider: string, modelId: string) => {
    const remote = getRemoteSettings();
    remote.defaultProvider = provider;
    remote.defaultModel = modelId;
  };
  settingsManager.setDefaultThinkingLevel = (level: ThinkingLevel) => {
    getRemoteSettings().defaultThinkingLevel = level;
  };
  settingsManager.setEnabledModels = (patterns: string[] | undefined) => {
    getRemoteSettings().enabledModels = patterns ? [...patterns] : undefined;
  };
}
