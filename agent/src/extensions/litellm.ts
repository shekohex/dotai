import { getModels } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { AuthStorage } from "@mariozechner/pi-coding-agent";

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
const ZAI_CODING_PLAN_PROVIDER = "zai-coding-plan";
const LITELLM_AUTH_PROVIDER = "litellm";
export const LITELLM_API_KEY_ENV = "LITELLM_API_KEY";
const LITELLM_READINESS_PATH = "/health/readiness";

let litellmStatePromise: Promise<LiteLLMState> | undefined;

export default async function litellmGatewayExtension(pi: ExtensionAPI) {
  const litellmApiKey = await resolveLiteLLMApiKey();

  const state = await resolveLiteLLMState();
  if (state.baseUrl) {
    pi.registerProvider(CODEX_OPENAI_PROVIDER, {
      baseUrl: state.baseUrl,
      apiKey: litellmApiKey ?? LITELLM_API_KEY_ENV,
      models: createCodexOpenAIModels(),
    });

    pi.registerProvider(ZAI_CODING_PLAN_PROVIDER, {
      baseUrl: state.baseUrl,
      apiKey: litellmApiKey ?? LITELLM_API_KEY_ENV,
      api: "openai-completions",
      models: createZaiCodingPlanModels(),
    });
  }
}

export async function resolveLiteLLMApiKey(): Promise<string | undefined> {
  return AuthStorage.create().getApiKey(LITELLM_AUTH_PROVIDER, { includeFallback: false });
}

export async function resolveLiteLLMState(): Promise<LiteLLMState> {
  if (!litellmStatePromise) {
    litellmStatePromise = detectLiteLLMState();
  }

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

function createZaiCodingPlanModels(): ProviderModelConfig[] {
  return getModels("zai").map((model) => ({
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
  }));
}

function createCodexOpenAIModels(): ProviderModelConfig[] {
  return getModels("openai-codex").map((model) => ({
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
  }));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
