import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ModelFamilySystemPrompt = "gpt" | "kimi" | "default";

const extensionDir = import.meta.dirname;
const systemPromptDir = join(extensionDir, "..", "resources", "system");
const promptFiles: Record<ModelFamilySystemPrompt, string> = {
  gpt: join(systemPromptDir, "gpt.md"),
  kimi: join(systemPromptDir, "kimi.md"),
  default: join(systemPromptDir, "default.md"),
};
const promptTexts: Record<ModelFamilySystemPrompt, string> = {
  gpt: readFileSync(promptFiles.gpt, "utf8").trim(),
  kimi: readFileSync(promptFiles.kimi, "utf8").trim(),
  default: readFileSync(promptFiles.default, "utf8").trim(),
};
const preservePromptBySession = new WeakMap<ExtensionContext["sessionManager"], boolean>();

export function shouldPreserveSystemPrompt(ctx: ExtensionContext): boolean {
  return (
    process.env.PI_PRESERVE_SYSTEM_PROMPT === "1" ||
    preservePromptBySession.get(ctx.sessionManager) === true
  );
}

export function resolveModelFamilySystemPrompt(
  modelId: string | undefined,
): ModelFamilySystemPrompt {
  const normalizedModelId = modelId?.trim().toLowerCase() ?? "";

  if (normalizedModelId.startsWith("gpt-")) {
    return "gpt";
  }

  if (normalizedModelId.includes("kimi")) {
    return "kimi";
  }

  return "default";
}

export default function modelFamilySystemPromptExtension(pi: ExtensionAPI): void {
  pi.registerFlag("preserve-system-prompt", {
    description: "Preserve externally supplied system prompt instead of applying bundled prompts",
    type: "boolean",
  });
  pi.on("before_agent_start", (_event, ctx) => {
    preservePromptBySession.set(ctx.sessionManager, pi.getFlag("preserve-system-prompt") === true);
  });
  pi.on("context_with_system", (event, ctx) => {
    if (shouldPreserveSystemPrompt(ctx)) return { messages: event.messages };
    const familyPrompt = promptTexts[resolveModelFamilySystemPrompt(ctx.model?.id)];
    return {
      messages: event.messages.map((message) =>
        message.role === "system" && message.sections?.preamble !== undefined
          ? { ...message, sections: { ...message.sections, preamble: familyPrompt } }
          : message,
      ),
    };
  });
}
