import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { readAssistantTextPhase } from "../../utils/pi-ai-text.js";

/**
 * @param {AssistantMessage} message AgentSession assistant message.
 * @returns {string} Commentary text suitable for live progress forwarding.
 */
export function commentaryFromAssistant(message: AssistantMessage): string {
  const commentary = message.content
    .filter(
      (content): content is Extract<(typeof message.content)[number], { type: "text" }> =>
        content.type === "text" && readAssistantTextPhase(content) === "commentary",
    )
    .map((content) => content.text)
    .join("\n")
    .trim();
  if (commentary.length > 0) return commentary;
  if (message.stopReason !== "toolUse") return "";
  return message.content
    .filter(
      (content): content is Extract<(typeof message.content)[number], { type: "text" }> =>
        content.type === "text" && readAssistantTextPhase(content) !== "final_answer",
    )
    .map((content) => content.text)
    .join("\n")
    .trim();
}

/**
 * @param {AssistantMessage} message AgentSession assistant message.
 * @returns {string} Final-answer text from a completed AgentSession response.
 */
export function finalTextFromAssistant(message: AssistantMessage): string {
  const finalAnswer = message.content
    .filter(
      (content): content is Extract<(typeof message.content)[number], { type: "text" }> =>
        content.type === "text" && readAssistantTextPhase(content) === "final_answer",
    )
    .map((content) => content.text)
    .join("\n")
    .trim();
  if (finalAnswer.length > 0) return finalAnswer;
  const nonCommentary = message.content
    .filter(
      (content): content is Extract<(typeof message.content)[number], { type: "text" }> =>
        content.type === "text" && readAssistantTextPhase(content) !== "commentary",
    )
    .map((content) => content.text)
    .join("\n")
    .trim();
  if (nonCommentary.length > 0 || message.stopReason !== "stop") return nonCommentary;
  // A terminal response containing only commentary is still the provider's final response. Treat
  // it as such rather than reporting a false empty completion.
  return message.content
    .filter(
      (content): content is Extract<(typeof message.content)[number], { type: "text" }> =>
        content.type === "text",
    )
    .map((content) => content.text)
    .join("\n")
    .trim();
}

/**
 * @param {readonly AgentMessage[]} messages Messages produced by the current agent run.
 * @returns {AssistantMessage | undefined} Last assistant response produced by the current run.
 */
export function assistantFromMessages(
  messages: readonly AgentMessage[],
): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

/**
 * @param {AssistantMessage | undefined} message Last assistant response, when one exists.
 * @returns {string} Human-readable reason for an empty AgentSession completion.
 */
export function emptyAgentResponseReason(message: AssistantMessage | undefined): string {
  const errorMessage = message?.errorMessage?.trim();
  if (errorMessage !== undefined && errorMessage.length > 0) return errorMessage;
  if (message === undefined) return "empty response";
  const kinds = new Set<string>();
  for (const content of message.content) {
    if (content.type === "text") {
      kinds.add(content.text.trim().length > 0 ? "text" : "empty text");
    } else if (content.type === "thinking") {
      kinds.add("thinking only");
    } else {
      kinds.add(content.type);
    }
  }
  const shape = kinds.size === 0 ? "no content" : [...kinds].join(" + ");
  const outputTokens = message.usage?.output;
  return `${message.stopReason} · ${shape}${outputTokens === undefined ? "" : ` · ${outputTokens} output tokens`}`;
}
