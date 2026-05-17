import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

interface AssistantUsage {
  input: number;
  output: number;
}

export interface AssistantMessageLike {
  role: string;
  usage?: AssistantUsage;
  stopReason?: string;
}

function usageChannelTokens(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.trunc(value));
}

export function assistantTurnTokens(message: AssistantMessageLike): number {
  if (message.role !== "assistant" || !message.usage) {
    return 0;
  }

  return usageChannelTokens(message.usage.input) + usageChannelTokens(message.usage.output);
}

export function isAbortedAssistantMessage(message: AssistantMessageLike): boolean {
  return message.role === "assistant" && message.stopReason === "aborted";
}

export function isToolUseAssistantMessage(message: AssistantMessageLike): boolean {
  return message.role === "assistant" && message.stopReason === "toolUse";
}

function isSessionMessageEntryLike(
  value: unknown,
): value is { type: "message"; message: { role: string; content?: unknown } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "message" &&
    "message" in value &&
    typeof value.message === "object" &&
    value.message !== null &&
    "role" in value.message &&
    typeof value.message.role === "string"
  );
}

function isTextContentLike(value: unknown): value is { type: "text"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "text" &&
    "text" in value &&
    typeof value.text === "string"
  );
}

export function lastAssistantMessageText(ctx: ExtensionContext): string | null {
  const branch = ctx.sessionManager.getBranch() as Array<unknown>;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!isSessionMessageEntryLike(entry) || entry.message.role !== "assistant") {
      continue;
    }
    const content = entry.message.content;
    if (typeof content === "string" && content.length > 0) {
      return content;
    }
    if (Array.isArray(content)) {
      const text = content
        .filter((item) => isTextContentLike(item))
        .map((item) => item.text.trim())
        .filter((item) => item.length > 0)
        .join("\n")
        .trim();
      if (text.length > 0) {
        return text;
      }
    }
  }
  return null;
}
