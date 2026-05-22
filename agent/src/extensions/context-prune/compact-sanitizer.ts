import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRecord } from "../../utils/unknown-data.js";
import type { ToolCallIndexer } from "./indexer.js";
import { CUSTOM_TYPE_SUMMARY } from "./types.js";

export interface CompactSanitizeStats {
  changed: boolean;
  droppedToolResults: number;
  replacedToolCalls: number;
  summaryMessagesSeen: number;
  beforeChars: number;
  afterChars: number;
}

export interface CompactSanitizeResult {
  messages: AgentMessage[];
  stats: CompactSanitizeStats;
}

export function sanitizeMessagesForCompact(
  messages: AgentMessage[],
  indexer: ToolCallIndexer,
): CompactSanitizeResult {
  const stats = createEmptyStats();
  stats.beforeChars = roughChars(messages);

  const sanitized: AgentMessage[] = [];
  for (const message of messages) {
    if (isContextPruneSummary(message)) {
      stats.summaryMessagesSeen += 1;
    }
    if (shouldDropToolResult(message, indexer)) {
      stats.changed = true;
      stats.droppedToolResults += 1;
      continue;
    }
    sanitized.push(
      message.role === "assistant" ? sanitizeAssistantMessage(message, indexer, stats) : message,
    );
  }

  stats.afterChars = roughChars(sanitized);
  return { messages: stats.changed ? sanitized : messages, stats };
}

export function mergeCompactSanitizeStats(...items: CompactSanitizeStats[]): CompactSanitizeStats {
  const merged = createEmptyStats();
  for (const item of items) {
    merged.changed ||= item.changed;
    merged.droppedToolResults += item.droppedToolResults;
    merged.replacedToolCalls += item.replacedToolCalls;
    merged.summaryMessagesSeen += item.summaryMessagesSeen;
    merged.beforeChars += item.beforeChars;
    merged.afterChars += item.afterChars;
  }
  return merged;
}

function sanitizeAssistantMessage(
  message: AssistantMessage,
  indexer: ToolCallIndexer,
  stats: CompactSanitizeStats,
): AgentMessage {
  let changed = false;
  const content = message.content.map((block) => {
    if (isSummarizedToolCallBlock(block, indexer)) {
      changed = true;
      stats.replacedToolCalls += 1;
      return { type: "text" as const, text: compactToolCallLabel(block, indexer) };
    }
    return block;
  });
  if (!changed) return message;
  stats.changed = true;
  return { ...message, content };
}

function isSummarizedToolCallBlock(
  block: unknown,
  indexer: ToolCallIndexer,
): block is { id: string; name?: string; arguments?: unknown } {
  return (
    isRecord(block) &&
    block.type === "toolCall" &&
    typeof block.id === "string" &&
    indexer.isSummarized(block.id)
  );
}

function shouldDropToolResult(message: AgentMessage, indexer: ToolCallIndexer): boolean {
  return (
    message.role === "toolResult" &&
    typeof message.toolCallId === "string" &&
    indexer.isSummarized(message.toolCallId)
  );
}

function isContextPruneSummary(message: AgentMessage): boolean {
  return message.role === "custom" && message.customType === CUSTOM_TYPE_SUMMARY;
}

function compactToolCallLabel(
  block: { id: string; name?: string; arguments?: unknown },
  indexer: ToolCallIndexer,
): string {
  const record = indexer.getRecord(block.id);
  const toolName = record?.toolName ?? block.name ?? "tool";
  const args = resolveToolArgs(record?.args, block.arguments);
  const path = typeof args.path === "string" ? args.path : undefined;
  const command = typeof args.command === "string" ? shortValue(args.command, 140) : undefined;
  const extra = compactToolCallExtra(path, command);
  return `[context-prune: omitted summarized ${toolName} tool call ${block.id}${extra}. Raw arguments/result were already replaced by a context-prune-summary message; use context_tree_query if original output is needed.]`;
}

function resolveToolArgs(recordArgs: unknown, blockArguments: unknown): Record<string, unknown> {
  if (isRecord(recordArgs)) return recordArgs;
  if (isRecord(blockArguments)) return blockArguments;
  return {};
}

function compactToolCallExtra(path: string | undefined, command: string | undefined): string {
  if (path !== undefined) return ` path=${path}`;
  if (command !== undefined) return ` command=${command}`;
  return "";
}

function shortValue(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function roughChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

function createEmptyStats(): CompactSanitizeStats {
  return {
    changed: false,
    droppedToolResults: 0,
    replacedToolCalls: 0,
    summaryMessagesSeen: 0,
    beforeChars: 0,
    afterChars: 0,
  };
}
