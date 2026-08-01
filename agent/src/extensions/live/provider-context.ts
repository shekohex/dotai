import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isUnknownRecord } from "../../utils/unknown-value.js";

const LIVE_DELEGATION_MESSAGE_TYPE = "live-delegation";

function readConversationContext(message: AgentMessage): string | undefined {
  if (message.role !== "custom" || message.customType !== LIVE_DELEGATION_MESSAGE_TYPE) {
    return undefined;
  }
  const details = message.details;
  if (!isUnknownRecord(details)) return undefined;
  const conversationContext = details.conversationContext;
  return typeof conversationContext === "string" && conversationContext.trim().length > 0
    ? conversationContext.trim()
    : undefined;
}

function liveDelegationText(message: AgentMessage): string | undefined {
  if (message.role !== "custom" || typeof message.content !== "string") return undefined;
  const task = message.content.trim();
  return task.length > 0 ? task : undefined;
}

function providerDelegationContent(task: string, conversationContext: string): string {
  return `<live-conversation-context>
Conversation since the previous workspace handoff. Use it only to resolve references, corrections, and constraints in the workspace task.

${conversationContext}
</live-conversation-context>

<workspace-task>
${task}
</workspace-task>`;
}

/**
 * Adds bounded voice history to provider context without changing visible delegation cards.
 *
 * @param {readonly AgentMessage[]} messages Agent context before provider conversion.
 * @returns {AgentMessage[] | undefined} Updated provider context when voice history is available.
 */
export function applyLiveDelegationConversationContext(
  messages: readonly AgentMessage[],
): AgentMessage[] | undefined {
  let changed = false;
  const next: AgentMessage[] = [];
  for (const message of messages) {
    const conversationContext = readConversationContext(message);
    const task = liveDelegationText(message);
    if (message.role !== "custom" || conversationContext === undefined || task === undefined) {
      next.push(message);
      continue;
    }
    changed = true;
    next.push({ ...message, content: providerDelegationContent(task, conversationContext) });
  }
  return changed ? next : undefined;
}

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
