import type { SessionSyncEvent, StreamEventEnvelope } from "./schemas.js";

export function toAssistantMessageSyncEvent(
  event: Extract<
    Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"],
    { type: "message_update" }
  >["assistantMessageEvent"],
): Extract<
  Extract<SessionSyncEvent, { type: "patch" }>["patch"],
  { patchType: "assistant.message" }
>["payload"]["assistantMessageEvent"] {
  switch (event.type) {
    case "start":
      return { type: "start", partial: event.partial };
    case "text_start":
      return { type: "text_start", contentIndex: event.contentIndex };
    case "text_delta":
      return { type: "text_delta", contentIndex: event.contentIndex, delta: event.delta };
    case "text_end":
      return { type: "text_end", contentIndex: event.contentIndex, content: event.content };
    case "thinking_start":
      return { type: "thinking_start", contentIndex: event.contentIndex };
    case "thinking_delta":
      return { type: "thinking_delta", contentIndex: event.contentIndex, delta: event.delta };
    case "thinking_end":
      return { type: "thinking_end", contentIndex: event.contentIndex, content: event.content };
    case "toolcall_start":
      return { type: "toolcall_start", contentIndex: event.contentIndex, partial: event.partial };
    case "toolcall_delta":
      return {
        type: "toolcall_delta",
        contentIndex: event.contentIndex,
        delta: event.delta,
        partial: event.partial,
      };
    case "toolcall_end":
      return { type: "toolcall_end", contentIndex: event.contentIndex, toolCall: event.toolCall };
    case "done":
      return { type: "done", reason: event.reason, message: event.message };
    case "error":
      return { type: "error", reason: event.reason, error: event.error };
    default:
      throw new Error("Unsupported assistant message sync event");
  }
}
