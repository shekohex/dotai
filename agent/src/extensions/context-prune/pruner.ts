import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolCallIndexer } from "./indexer.js";
import { isToolResultMessage } from "./guards.js";

export function pruneMessages(messages: AgentMessage[], indexer: ToolCallIndexer): AgentMessage[] {
  return messages.filter((msg) => {
    // Only remove toolResult messages that have been summarized
    if (isToolResultMessage(msg) && indexer.isSummarized(msg.toolCallId)) {
      return false;
    }
    return true;
  });
}
