import type { AgentMessage } from "@earendil-works/pi-agent-core";

const LIVE_DELEGATION_MESSAGE_TYPE = "live-delegation";

function assistantHasSubstantiveOutput(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return message.content.some((content) => {
    if (content.type === "text") return content.text.trim().length > 0;
    return content.type === "toolCall";
  });
}

/**
 * Removes provider-successful but content-empty assistant turns from live-delegation context.
 * Session history remains untouched; only the next provider request is repaired for bounded retry.
 *
 * @param {readonly AgentMessage[]} messages Agent context before provider conversion.
 * @returns {AgentMessage[] | undefined} Filtered context, or undefined when unchanged.
 */
export function omitEmptyLiveDelegationAssistantTurns(
  messages: readonly AgentMessage[],
): AgentMessage[] | undefined {
  let inLiveDelegation = false;
  let changed = false;
  const next: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "custom" && message.customType === LIVE_DELEGATION_MESSAGE_TYPE) {
      inLiveDelegation = true;
      next.push(message);
      continue;
    }
    if (message.role === "user") inLiveDelegation = false;
    if (message.role === "assistant" && inLiveDelegation) {
      const substantive = assistantHasSubstantiveOutput(message);
      const terminal = message.stopReason !== "toolUse";
      if (!substantive && terminal) {
        changed = true;
        inLiveDelegation = false;
        continue;
      }
      if (terminal) inLiveDelegation = false;
    }
    next.push(message);
  }
  return changed ? next : undefined;
}
