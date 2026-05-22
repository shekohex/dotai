import type { ToolCallIndexer } from "./indexer.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { isAssistantMessage, isToolCallContent, isToolResultMessage } from "./guards.js";

const PRUNER_NOTE_OPEN = "<pruner-note>";
const PRUNER_NOTE_CLOSE = "</pruner-note>";

export function countUnprunedToolCalls(messages: AgentMessage[], indexer: ToolCallIndexer): number {
  let count = 0;
  for (const msg of messages) {
    if (!isAssistantMessage(msg)) continue;
    for (const block of msg.content.filter(isToolCallContent)) {
      const id = block.toolCallId ?? block.id;
      if (!indexer.isSummarized(id)) count++;
    }
  }
  return count;
}

export function buildReminderText(count: number): string {
  return `${PRUNER_NOTE_OPEN}${count} unpruned tool call result(s) currently in context. Consider calling context_prune after a logical batch of 8–12 related tool calls.${PRUNER_NOTE_CLOSE}`;
}

export function annotateWithUnprunedCount(messages: AgentMessage[], count: number): AgentMessage[] {
  if (count <= 0) return messages;
  if (messages.length === 0) return messages;

  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  if (last === undefined || !isToolResultMessage(last)) return messages;

  const reminder: TextContent = { type: "text", text: buildReminderText(count) };
  const clonedLast = {
    ...last,
    content: [...last.content, reminder],
  };

  const out = messages.slice();
  out[lastIndex] = clonedLast;
  return out;
}
