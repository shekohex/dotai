import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractPiDynamicTail } from "../system-prompt-tail.js";

export type ModelFamilySystemPrompt = "codex" | "gpt" | "gemini" | "kimi" | "default";

const extensionDir = import.meta.dirname;
const systemPromptDir = join(extensionDir, "..", "resources", "system");
const promptFiles: Record<ModelFamilySystemPrompt, string> = {
  codex: join(systemPromptDir, "codex.md"),
  gpt: join(systemPromptDir, "gpt.md"),
  gemini: join(systemPromptDir, "gemini.md"),
  kimi: join(systemPromptDir, "kimi.md"),
  default: join(systemPromptDir, "default.md"),
};
const promptTexts: Record<ModelFamilySystemPrompt, string> = {
  codex: readFileSync(promptFiles.codex, "utf8").trim(),
  gpt: readFileSync(promptFiles.gpt, "utf8").trim(),
  gemini: readFileSync(promptFiles.gemini, "utf8").trim(),
  kimi: readFileSync(promptFiles.kimi, "utf8").trim(),
  default: readFileSync(promptFiles.default, "utf8").trim(),
};

export function resolveModelFamilySystemPrompt(
  modelId: string | undefined,
): ModelFamilySystemPrompt {
  const normalizedModelId = modelId?.trim().toLowerCase() ?? "";

  if (normalizedModelId.includes("codex")) {
    return "codex";
  }

  if (normalizedModelId.includes("gemini")) {
    return "gemini";
  }

  if (normalizedModelId.includes("kimi")) {
    return "kimi";
  }

  if (normalizedModelId.includes("gpt-5")) {
    return "gpt";
  }

  return "default";
}

export function buildModelFamilySystemPrompt(
  systemPrompt: string,
  modelId: string | undefined,
): string {
  const family = resolveModelFamilySystemPrompt(modelId);
  const tail = extractPiDynamicTail(systemPrompt).trimStart();
  return tail.length > 0 ? `${promptTexts[family]}\n\n${tail}` : promptTexts[family];
}

export default function modelFamilySystemPromptExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => ({
    systemPrompt: buildModelFamilySystemPrompt(event.systemPrompt, ctx.model?.id),
  }));
}
