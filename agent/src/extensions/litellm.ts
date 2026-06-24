import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../utils/error-message.js";

type LiteLLMCandidate = {
  label: string;
  origin: string;
};

export type LiteLLMState = {
  healthy: boolean;
  label: string;
  origin?: string;
  baseUrl?: string;
  checkedPath?: string;
  error?: string;
};

const LITELLM_CANDIDATES: LiteLLMCandidate[] = [
  { label: "lan", origin: "http://192.168.1.116:4000" },
  { label: "tail", origin: "http://100.100.1.116:4000" },
  { label: "public", origin: "https://ai-gateway.0iq.xyz" },
];

const CODEX_OPENAI_PROVIDER = "codex-openai";
const DEEPSEEK_PROVIDER = "deepseek";
const GEMINI_PROVIDER = "gemini";
const ZAI_PROVIDER = "zai";
const ZAI_CODING_PLAN_PROVIDER = "zai-coding-plan";
const ZAI_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const ZAI_API_KEY_ENV = "$ZAI_API_KEY";
const LITELLM_AUTH_PROVIDER = "litellm";
export const LITELLM_API_KEY_ENV = "LITELLM_API_KEY";
const LITELLM_READINESS_PATH = "/health/readiness";
const ZAI_GLM_5_1_MODEL_ID = "glm-5.1";
const ZAI_GLM_5_2_MODEL_ID = "glm-5.2";

let litellmStatePromise: Promise<LiteLLMState> | undefined;

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

export default async function litellmGatewayExtension(pi: ExtensionAPI) {
  const litellmApiKey = await resolveLiteLLMApiKey();

  const state = await resolveLiteLLMState();
  for (const registration of createLiteLLMProviderRegistrations(state, litellmApiKey)) {
    pi.registerProvider(registration.provider, registration.config);
  }
}

type RegisteredProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];

export function createLiteLLMProviderRegistrations(
  state: LiteLLMState,
  litellmApiKey?: string,
): Array<{ provider: string; config: RegisteredProviderConfig }> {
  if (!hasText(state.baseUrl)) {
    return [];
  }

  const apiKey = litellmApiKey ?? LITELLM_API_KEY_ENV;
  const registrations: Array<{ provider: string; config: RegisteredProviderConfig }> = [
    {
      provider: CODEX_OPENAI_PROVIDER,
      config: {
        baseUrl: state.baseUrl,
        apiKey,
        api: "openai-responses",
        models: createCodexOpenAIModels(),
      },
    },
    {
      provider: ZAI_PROVIDER,
      config: {
        baseUrl: ZAI_BASE_URL,
        apiKey: ZAI_API_KEY_ENV,
        api: "openai-completions",
        models: createZaiModels(),
      },
    },
    {
      provider: ZAI_CODING_PLAN_PROVIDER,
      config: {
        baseUrl: state.baseUrl,
        apiKey,
        api: "openai-completions",
        models: createZaiModels(),
      },
    },
    {
      provider: DEEPSEEK_PROVIDER,
      config: {
        baseUrl: state.baseUrl,
        apiKey,
        api: "openai-completions",
        models: createDeepSeekModels(),
      },
    },
  ];

  if (hasText(state.origin)) {
    registrations.push({
      provider: GEMINI_PROVIDER,
      config: {
        baseUrl: `${state.origin}/v1beta`,
        apiKey,
        api: "google-generative-ai",
        models: createGeminiModels(),
      },
    });
  }

  return registrations;
}

export function resolveLiteLLMApiKey(): Promise<string | undefined> {
  return AuthStorage.create().getApiKey(LITELLM_AUTH_PROVIDER, { includeFallback: false });
}

export function resolveLiteLLMState(): Promise<LiteLLMState> {
  litellmStatePromise ??= detectLiteLLMState();

  return litellmStatePromise;
}

async function detectLiteLLMState(): Promise<LiteLLMState> {
  let lastError: string | undefined;

  for (const candidate of LITELLM_CANDIDATES) {
    const result = await probeLiteLLMCandidate(candidate);
    if (result.healthy) {
      return {
        healthy: true,
        label: candidate.label,
        origin: candidate.origin,
        baseUrl: `${candidate.origin}/v1`,
        checkedPath: result.checkedPath,
      };
    }
    lastError = result.error;
  }

  return {
    healthy: false,
    label: "offline",
    error: lastError,
  };
}

async function probeLiteLLMCandidate(candidate: LiteLLMCandidate): Promise<{
  healthy: boolean;
  checkedPath?: string;
  error?: string;
}> {
  try {
    const response = await fetch(`${candidate.origin}${LITELLM_READINESS_PATH}`, {
      method: "GET",
      signal: AbortSignal.timeout(1000),
    });

    if (response.ok || response.status === 401 || response.status === 403) {
      return { healthy: true, checkedPath: LITELLM_READINESS_PATH };
    }

    return {
      healthy: false,
      error: `${candidate.label} ${LITELLM_READINESS_PATH} -> ${response.status}`,
    };
  } catch (error) {
    return {
      healthy: false,
      error: `${candidate.label} ${LITELLM_READINESS_PATH} -> ${formatError(error)}`,
    };
  }
}

function createZaiModels(): ProviderModelConfig[] {
  const models = getBuiltinModels(ZAI_PROVIDER).map((model) => ({
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: model.compat,
    headers: model.headers,
    thinkingLevelMap: model.thinkingLevelMap,
  }));
  const glm51 = models.find((model) => model.id === ZAI_GLM_5_1_MODEL_ID);
  if (glm51 === undefined || models.some((model) => model.id === ZAI_GLM_5_2_MODEL_ID)) {
    return models;
  }

  return [
    ...models,
    {
      ...glm51,
      id: ZAI_GLM_5_2_MODEL_ID,
      name: "GLM-5.2",
      contextWindow: 1_000_000,
      thinkingLevelMap: {
        low: "high",
        medium: "high",
        high: "high",
        xhigh: "max",
      },
    },
  ];
}

function createCodexOpenAIModels(): ProviderModelConfig[] {
  return getBuiltinModels("openai-codex").map((model) => ({
    id: model.id,
    name: model.name,
    api: "openai-responses",
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: model.compat,
    headers: model.headers,
    thinkingLevelMap: model.thinkingLevelMap,
  }));
}

function createDeepSeekModels(): ProviderModelConfig[] {
  return getBuiltinModels("deepseek").map((model) => ({
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: model.compat,
    headers: model.headers,
    thinkingLevelMap: model.thinkingLevelMap,
  }));
}

function createGeminiModels(): ProviderModelConfig[] {
  return getBuiltinModels("google").map((model) => ({
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: model.compat,
    headers: model.headers,
    thinkingLevelMap: model.thinkingLevelMap,
  }));
}

function formatError(error: unknown): string {
  return errorMessage(error);
}
