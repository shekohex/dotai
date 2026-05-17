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
