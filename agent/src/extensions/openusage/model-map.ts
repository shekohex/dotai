import type { SupportedProviderId } from "./types.js";

export function resolveSupportedProviderId(
  provider: string | undefined,
  modelId: string | undefined,
): SupportedProviderId | undefined {
  const normalizedProvider = provider?.trim().toLowerCase() ?? "";
  const normalizedModelId = modelId?.trim().toLowerCase() ?? "";

  if (
    normalizedProvider === "codex-openai" ||
    normalizedProvider === "openai-codex" ||
    normalizedModelId.includes("codex")
  ) {
    return "codex";
  }

  if (normalizedProvider === "zai-coding-plan" || normalizedProvider === "zai") {
    return "zai";
  }

  return undefined;
}
