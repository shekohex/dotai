import type { TextContent, TextSignatureV1 } from "@earendil-works/pi-ai";
import { isUnknownRecord, parseUnknownJson } from "./unknown-value.js";

export type AssistantTextPhase = NonNullable<TextSignatureV1["phase"]>;

/**
 * Reads OpenAI Responses phase metadata encoded by pi-ai in TextContent.textSignature.
 *
 * Pi-ai exports the canonical TextSignatureV1 type but keeps its wire decoder private. This mirrors
 * the v1 envelope validation without coupling callers to a provider module. Legacy plain-ID
 * signatures intentionally have no phase.
 *
 * @param {Pick<TextContent, "textSignature">} content Assistant text content.
 * @returns {AssistantTextPhase | undefined} Normalized commentary or final-answer phase.
 */
export function readAssistantTextPhase(
  content: Pick<TextContent, "textSignature">,
): AssistantTextPhase | undefined {
  const signature = content.textSignature;
  if (signature === undefined || !signature.startsWith("{")) return undefined;
  try {
    const parsed = parseUnknownJson(signature);
    if (!isUnknownRecord(parsed) || parsed.v !== 1 || typeof parsed.id !== "string") {
      return undefined;
    }
    return parsed.phase === "commentary" || parsed.phase === "final_answer"
      ? parsed.phase
      : undefined;
  } catch {
    return undefined;
  }
}
