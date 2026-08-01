import type { CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";

import type { SubagentRuntimeEventBus } from "./events.js";

type LiteSessionEvent = Parameters<CreateAgentSessionResult["session"]["subscribe"]>[0] extends (
  event: infer TEvent,
) => void
  ? TEvent
  : never;

export function forwardLiteChildEvent(
  eventBus: SubagentRuntimeEventBus,
  sessionId: string,
  event: LiteSessionEvent,
): void {
  switch (event.type) {
    case "agent_start":
    case "agent_end":
    case "message_start":
    case "message_update":
    case "message_end":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      eventBus.emitChildEvent(sessionId, event);
      return;
    case "turn_start":
      eventBus.emitChildEvent(sessionId, {
        type: "turn_start",
        turnIndex: 0,
        timestamp: Date.now(),
      });
      return;
    case "turn_end":
      eventBus.emitChildEvent(sessionId, {
        type: "turn_end",
        turnIndex:
          "turnIndex" in event && typeof event.turnIndex === "number" ? event.turnIndex : 0,
        message: event.message,
        toolResults: event.toolResults,
      });
      return;
    case "auto_retry_end":
    case "auto_retry_start":
    case "agent_settled":
    case "bash_execution_update":
    case "compaction_end":
    case "compaction_start":
    case "entry_appended":
    case "queue_update":
    case "session_info_changed":
    case "summarization_retry_attempt_start":
    case "summarization_retry_finished":
    case "summarization_retry_scheduled":
    case "thinking_level_changed":
      break;
  }
}
