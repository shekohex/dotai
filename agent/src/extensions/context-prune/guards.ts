import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  CustomEntry,
  CustomMessageEntry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  IndexEntryData,
  PruneFrontier,
  PruneFrontierOutcome,
  SummarizerStats,
  ToolCallRecord,
} from "./types.js";
import { isRecord } from "../../utils/unknown-data.js";

export { isRecord };

export type ToolCallContentLike = ToolCall & {
  input?: unknown;
  args?: unknown;
  toolCallId?: string;
};

export type ToolResultMessageWithUnknownDetails = ToolResultMessage<unknown>;

export type PruneFrontierData = Partial<PruneFrontier> & {
  lastAttemptedToolCallId: string;
};

export function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isStaleContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("This extension ctx is stale");
}

export function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function isTextContent(value: unknown): value is TextContent {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

export function isToolCallContent(value: unknown): value is ToolCallContentLike {
  return (
    isRecord(value) &&
    value.type === "toolCall" &&
    typeof value.id === "string" &&
    typeof value.name === "string"
  );
}

export function isAssistantMessage(
  message: AgentMessage,
): message is Extract<Message, { role: "assistant" }> {
  return isRecord(message) && message.role === "assistant" && Array.isArray(message.content);
}

export function isToolResultMessage(
  message: AgentMessage,
): message is ToolResultMessageWithUnknownDetails {
  return (
    isRecord(message) &&
    message.role === "toolResult" &&
    typeof message.toolCallId === "string" &&
    Array.isArray(message.content)
  );
}

export function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((value) => isTextContent(value))
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function findToolResult(
  toolResults: ToolResultMessageWithUnknownDetails[],
  toolCallId: string,
): ToolResultMessageWithUnknownDetails | undefined {
  return toolResults.find((result) => result.toolCallId === toolCallId);
}

export function isCustomEntry<T>(
  entry: SessionEntry,
  customType: string,
  isData: (data: unknown) => data is T,
): entry is CustomEntry<T> & { data: T } {
  return entry.type === "custom" && entry.customType === customType && isData(entry.data);
}

export function isCustomMessageEntry<T>(
  entry: SessionEntry,
  customType: string,
  isDetails: (details: unknown) => details is T,
): entry is CustomMessageEntry<T> & { details: T } {
  return (
    entry.type === "custom_message" && entry.customType === customType && isDetails(entry.details)
  );
}

export function isToolCallRecord(value: unknown): value is ToolCallRecord {
  return (
    isRecord(value) &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string" &&
    isRecord(value.args) &&
    typeof value.resultText === "string" &&
    typeof value.isError === "boolean" &&
    typeof value.turnIndex === "number" &&
    typeof value.timestamp === "number"
  );
}

export function isIndexEntryData(value: unknown): value is IndexEntryData {
  return (
    isRecord(value) &&
    Array.isArray(value.toolCalls) &&
    value.toolCalls.every((toolCall) => isToolCallRecord(toolCall))
  );
}

function isPruneFrontierOutcome(value: unknown): value is PruneFrontierOutcome {
  return value === "summarized" || value === "skipped-oversized";
}

export function isPruneFrontier(value: unknown): value is PruneFrontier {
  return (
    isRecord(value) &&
    typeof value.lastAttemptedToolCallId === "string" &&
    typeof value.lastAttemptedToolName === "string" &&
    typeof value.lastAttemptedTurnIndex === "number" &&
    typeof value.lastAttemptedTimestamp === "number" &&
    typeof value.attemptedBatchCount === "number" &&
    typeof value.attemptedToolCallCount === "number" &&
    typeof value.rawCharCount === "number" &&
    typeof value.summaryCharCount === "number" &&
    isPruneFrontierOutcome(value.outcome)
  );
}

export function isPruneFrontierData(value: unknown): value is PruneFrontierData {
  return isRecord(value) && typeof value.lastAttemptedToolCallId === "string";
}

export function isSummarizerStats(value: unknown): value is SummarizerStats {
  return (
    isRecord(value) &&
    typeof value.totalInputTokens === "number" &&
    typeof value.totalOutputTokens === "number" &&
    typeof value.totalCost === "number" &&
    typeof value.callCount === "number"
  );
}
