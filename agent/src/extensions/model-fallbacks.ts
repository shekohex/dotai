import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const DEFAULT_MODEL_FALLBACKS = [
  { provider: "codex-openai", model: "gpt-5.4-mini" },
  { provider: "zai", model: "glm-5.2" },
  { provider: "zai-coding-plan", model: "glm-5.2" },
  { provider: "opencode-go", model: "deepseek-v4-flash" },
  { provider: "deepseek", model: "deepseek-v4-flash" },
  { provider: "gemini", model: "gemini-3.1-flash-lite-preview" },
  { provider: "gemini", model: "gemini-3.1-pro-preview" },
  { provider: "gemini", model: "gemini-2.5-pro" },
] as const;

export type ModelFallbackCandidate = {
  provider: string;
  model: string;
};

export type ModelAuth = {
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
};

export function modelDisplayName(candidate: ModelFallbackCandidate): string {
  return `${candidate.provider}/${candidate.model}`;
}

export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

export function modelForOpenAIResponses(model: Model<Api>): Model<Api> {
  if (model.provider !== "gemini") return model;

  const baseUrl =
    model.baseUrl
      .replace(/\/v1beta\/?$/, "")
      .replace(/\/v1\/?$/, "")
      .replace(/\/+$/, "") + "/v1";

  return { ...model, api: "openai-responses", baseUrl, reasoning: false };
}

export function appendCurrentModelFallback(
  candidates: readonly ModelFallbackCandidate[],
  currentModel: Model<Api> | undefined,
): ModelFallbackCandidate[] {
  const nextCandidates = [...candidates];
  if (
    currentModel !== undefined &&
    !nextCandidates.some(
      (candidate) =>
        candidate.provider === currentModel.provider && candidate.model === currentModel.id,
    )
  ) {
    nextCandidates.push({ provider: currentModel.provider, model: currentModel.id });
  }
  return nextCandidates;
}

export async function resolveModelFallbackAuth(
  ctx: ExtensionContext,
  candidate: ModelFallbackCandidate,
  taskLabel: string,
): Promise<ModelAuth | undefined> {
  const model = ctx.modelRegistry.find(candidate.provider, candidate.model);
  if (model === undefined) {
    ctx.ui.notify(
      `${taskLabel}: could not find ${modelDisplayName(candidate)}, trying next fallback`,
      "warning",
    );
    return undefined;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    ctx.ui.notify(
      `${taskLabel}: auth failed for ${model.id}: ${auth.error}. Trying next fallback`,
      "warning",
    );
    return undefined;
  }
  if (auth.apiKey === undefined || auth.apiKey.length === 0) {
    ctx.ui.notify(`${taskLabel}: no API key for ${model.id}, trying next fallback`, "warning");
    return undefined;
  }

  return { model, apiKey: auth.apiKey, headers: auth.headers, env: auth.env };
}

export function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
