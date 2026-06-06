import { extractPiDynamicTail } from "./system-prompt-tail.js";
import type { ModeSpec } from "./mode-utils.js";

export function applyModeSystemPrompt(
  systemPrompt: string,
  spec: Pick<ModeSpec, "systemPrompt" | "systemPromptMode"> | undefined,
): string | undefined {
  if (spec?.systemPrompt === undefined || spec.systemPrompt.length === 0) {
    return undefined;
  }

  if (spec.systemPromptMode === "replace") {
    const tail = extractPiDynamicTail(systemPrompt).trimStart();
    return tail.length > 0 ? `${spec.systemPrompt}\n\n${tail}` : spec.systemPrompt;
  }

  return `${systemPrompt}\n\n${spec.systemPrompt}`;
}
