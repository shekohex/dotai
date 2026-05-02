import type { JsonValue } from "./json-schema.js";
import type { SessionSyncEvent, StreamEventEnvelope } from "./schemas.js";

type AssistantMessageUpdateEvent = Extract<
  Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"],
  { type: "message_update" }
>["assistantMessageEvent"];

type AssistantToolCallBlock = Extract<
  Extract<SessionSyncEvent, { type: "patch" }>["patch"],
  { patchType: "assistant.message" }
>["payload"]["assistantMessageEvent"] extends infer TEvent
  ? Extract<TEvent, { toolCall: unknown }>["toolCall"]
  : never;

function readToolCallBlock(
  partial: Extract<AssistantMessageUpdateEvent, { partial: unknown }>["partial"],
  contentIndex: number,
): AssistantToolCallBlock {
  const block = partial.content[contentIndex];
  if (block?.type !== "toolCall") {
    throw new Error("Assistant toolcall sync event missing toolCall block");
  }

  return {
    type: "toolCall",
    id: block.id,
    name: block.name,
    arguments: block.arguments as Record<string, JsonValue>,
    ...(block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature }),
  };
}

function readTextDeltaStart(partialText: string, delta: string): number {
  return Math.max(0, partialText.length - delta.length);
}

export function toAssistantMessageSyncEvent(
  event: AssistantMessageUpdateEvent,
): Extract<
  Extract<SessionSyncEvent, { type: "patch" }>["patch"],
  { patchType: "assistant.message" }
>["payload"]["assistantMessageEvent"] {
  switch (event.type) {
    case "start":
      return { type: "start", partial: event.partial };
    case "text_start":
      return { type: "text_start", contentIndex: event.contentIndex };
    case "text_delta": {
      const contentBlock = event.partial.content[event.contentIndex];
      if (contentBlock?.type !== "text") {
        throw new Error("Assistant text delta missing text block");
      }
      return {
        type: "text_delta",
        contentIndex: event.contentIndex,
        start: readTextDeltaStart(contentBlock.text, event.delta),
        delta: event.delta,
      };
    }
    case "text_end":
      return { type: "text_end", contentIndex: event.contentIndex, content: event.content };
    case "thinking_start":
      return { type: "thinking_start", contentIndex: event.contentIndex };
    case "thinking_delta": {
      const contentBlock = event.partial.content[event.contentIndex];
      if (contentBlock?.type !== "thinking") {
        throw new Error("Assistant thinking delta missing thinking block");
      }
      return {
        type: "thinking_delta",
        contentIndex: event.contentIndex,
        start: readTextDeltaStart(contentBlock.thinking, event.delta),
        delta: event.delta,
      };
    }
    case "thinking_end":
      return { type: "thinking_end", contentIndex: event.contentIndex, content: event.content };
    case "toolcall_start":
      return {
        type: "toolcall_start",
        contentIndex: event.contentIndex,
        toolCall: readToolCallBlock(event.partial, event.contentIndex),
      };
    case "toolcall_delta":
      return {
        type: "toolcall_delta",
        contentIndex: event.contentIndex,
        delta: event.delta,
        toolCall: readToolCallBlock(event.partial, event.contentIndex),
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
