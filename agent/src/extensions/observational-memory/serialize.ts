import type { Message } from "@earendil-works/pi-ai";

import { asRecord } from "../../utils/unknown-data.js";
import { estimateStringTokens } from "./tokens.js";

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function fmtLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTimestamp(v: number | string | undefined): string {
  if (v === undefined) return "????-??-?? ??:??";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "????-??-?? ??:??" : fmtLocal(d);
}

function formatRecallTimestamp(...values: Array<number | string | undefined>): string {
  for (const v of values) {
    if (v === undefined) continue;
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return fmtLocal(d);
  }
  return "Unknown time";
}

function textAndPlaceholders(
  content: unknown,
  options: { omitRedactedThinking?: boolean; includeThinking?: boolean } = {},
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "[non-text content omitted]";

  const parts: string[] = [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (block === undefined) {
      parts.push("[non-text content omitted]");
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "thinking") {
      if (options.omitRedactedThinking === true && block.redacted === true) continue;
      if (options.includeThinking === true && typeof block.thinking === "string") {
        parts.push(`[thinking: ${block.thinking}]`);
        continue;
      }
      parts.push("[non-text content omitted]");
      continue;
    }
    if (block.type === "toolCall" && typeof block.name === "string") {
      parts.push(`[${block.name}(${JSON.stringify(block.arguments ?? {})})]`);
      continue;
    }
    parts.push("[non-text content omitted]");
  }
  return parts.join("\n");
}

function textOnly(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (block !== undefined && block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts.join("\n");
}

export function serializeConversation(messages: Message[]): string {
  return messages
    .map((msg): string | null => {
      const time = formatTimestamp(msg.timestamp);
      if (msg.role === "user") {
        const text = textOnly(msg.content);
        return `[User @ ${time}]: ${text}`;
      }
      if (msg.role === "assistant") {
        const body = textAndPlaceholders(msg.content, {
          includeThinking: true,
          omitRedactedThinking: true,
        })
          .split("\n")
          .filter(Boolean)
          .join("\n");
        if (!body) return null;
        return `[Assistant @ ${time}]: ${body}`;
      }
      const text = msg.role === "toolResult" ? textOnly(msg.content) : "";
      return `[Tool result for ${msg.role === "toolResult" ? msg.toolName : "unknown"} @ ${time}]: ${text}`;
    })
    .filter((line): line is string => line !== null)
    .join("\n\n");
}

export function nowTimestamp(): string {
  return fmtLocal(new Date());
}

export const MAX_RECORD_CONTENT_CHARS = 10_000;

export function truncateRecordContent(content: string): string {
  if (content.length <= MAX_RECORD_CONTENT_CHARS) return content;
  const head = content.slice(0, MAX_RECORD_CONTENT_CHARS);
  const dropped = content.length - MAX_RECORD_CONTENT_CHARS;
  return `${head} … [truncated ${dropped} chars]`;
}

export type RenderableEntry = {
  type: string;
  id?: string;
  timestamp?: string;
  message?: unknown;
  customType?: string;
  content?: unknown;
  summary?: unknown;
};

function renderCustomMessage(entry: RenderableEntry, options: { recallFormat: boolean }): string {
  const time = options.recallFormat
    ? formatRecallTimestamp(entry.timestamp)
    : formatTimestamp(entry.timestamp);
  let text: string;
  if (options.recallFormat) {
    text = textAndPlaceholders(entry.content);
  } else if (typeof entry.content === "string") {
    text = entry.content;
  } else {
    text = textOnly(entry.content);
  }
  if (options.recallFormat) {
    const origin =
      entry.customType === undefined ? "Custom message" : `Custom message (${entry.customType})`;
    return `[${origin} @ ${time}]: ${text}`;
  }
  const tag = entry.customType === undefined ? "Custom" : `Custom (${entry.customType})`;
  return `[${tag} @ ${time}]: ${text}`;
}

export function serializeBranchEntries(entries: RenderableEntry[]): string {
  const blocks: string[] = [];
  for (const entry of entries) {
    if (entry.type === "message" && isEntryMessage(entry.message)) {
      const part = serializeConversation([entry.message]);
      if (part.length > 0) blocks.push(part);
      continue;
    }
    if (entry.type === "custom_message") {
      blocks.push(renderCustomMessage(entry, { recallFormat: false }));
      continue;
    }
    if (entry.type === "branch_summary" && typeof entry.summary === "string") {
      const time = formatTimestamp(entry.timestamp);
      blocks.push(`[Branch summary @ ${time}]: ${entry.summary}`);
    }
  }
  return blocks.join("\n\n");
}

export type SourceAddressedSerialization = {
  text: string;
  sourceEntryIds: string[];
  estimatedTokens: number;
  truncatedSourceEntryIds: string[];
};

export type SourceAddressedSerializationOptions = {
  /** Maximum estimated tokens in the final source-addressed text. */
  maxTokens?: number;
};

const SOURCE_OMISSION_MARKER =
  "\n\n[… middle omitted: source exceeds observer input budget; original source remains in the session ledger …]\n\n";

function truncateSourceBlockToTokenBudget(
  label: string,
  rendered: string,
  maxTokens: number,
): string | undefined {
  const required = `${label}\n${SOURCE_OMISSION_MARKER}`;
  if (estimateStringTokens(required) > maxTokens) return undefined;
  const full = `${label}\n${rendered}`;
  if (estimateStringTokens(full) <= maxTokens) return full;
  const maxChars = Math.max(1, maxTokens * 4);
  const fixed = `${label}\n${SOURCE_OMISSION_MARKER}`;
  const retainedChars = maxChars - fixed.length;
  const headChars = Math.ceil(retainedChars / 2);
  const tailChars = retainedChars - headChars;
  return `${label}\n${rendered.slice(0, headChars)}${SOURCE_OMISSION_MARKER}${tailChars > 0 ? rendered.slice(-tailChars) : ""}`;
}

function isSourceRenderableEntry(entry: RenderableEntry): boolean {
  return (
    entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary"
  );
}

/**
 * Serialize complete source entries up to the token budget. If the first entry alone exceeds the
 * budget, include a clearly marked head/tail excerpt so one pathological tool result cannot
 * permanently block observation coverage. The original ledger entry is never modified and remains
 * recallable by id.
 *
 * @param {RenderableEntry[]} entries Source-renderable branch entries, oldest-first.
 * @param {SourceAddressedSerializationOptions} options Serialization options (token budget).
 * @returns {SourceAddressedSerialization} The serialized text plus source id bookkeeping.
 */
export function serializeSourceAddressedBranchEntries(
  entries: RenderableEntry[],
  options: SourceAddressedSerializationOptions = {},
): SourceAddressedSerialization {
  const blocks: string[] = [];
  const sourceEntryIds: string[] = [];
  const truncatedSourceEntryIds: string[] = [];
  let estimatedTokens = 0;

  for (const entry of entries) {
    const entryId = entry.id;
    if (entryId === undefined || entryId.length === 0 || !isSourceRenderableEntry(entry)) continue;
    const rendered = serializeBranchEntries([entry]);
    if (rendered.trim().length === 0) continue;
    const label = `[Source entry id: ${entryId}]`;
    const block = `${label}\n${rendered}`;
    const separator = blocks.length > 0 ? "\n\n" : "";
    const blockTokens = estimateStringTokens(`${separator}${block}`);
    const maxTokens = options.maxTokens;

    if (maxTokens !== undefined && estimatedTokens + blockTokens > maxTokens) {
      if (blocks.length > 0) break;
      const excerpt = truncateSourceBlockToTokenBudget(label, rendered, maxTokens);
      if (excerpt === undefined) break;
      blocks.push(excerpt);
      sourceEntryIds.push(entryId);
      truncatedSourceEntryIds.push(entryId);
      estimatedTokens = estimateStringTokens(excerpt);
      break;
    }

    blocks.push(block);
    sourceEntryIds.push(entryId);
    estimatedTokens += blockTokens;
  }

  const text = blocks.join("\n\n");
  return {
    text,
    sourceEntryIds,
    estimatedTokens: estimateStringTokens(text),
    truncatedSourceEntryIds,
  };
}

/**
 * Narrow an entry's stored message payload to a pi LLM message.
 *
 * @param {unknown} value Stored message payload.
 * @returns {boolean} Whether the payload looks like an LLM message.
 */
function isEntryMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null && "role" in value;
}

function renderRecallMessage(entry: RenderableEntry): string | null {
  if (entry.message === undefined || entry.message === null || !isEntryMessage(entry.message))
    return null;
  const msg: Message = entry.message;
  const time = formatRecallTimestamp(msg.timestamp, entry.timestamp);
  if (msg.role === "user") {
    return `[User @ ${time}]: ${textAndPlaceholders(msg.content)}`;
  }
  if (msg.role === "assistant") {
    const body = textAndPlaceholders(msg.content, {
      includeThinking: true,
      omitRedactedThinking: true,
    })
      .split("\n")
      .filter(Boolean)
      .join("\n");
    if (!body) return null;
    return `[Assistant @ ${time}]: ${body}`;
  }
  if (msg.role !== "toolResult") return null;
  return `[Tool result: ${msg.toolName} @ ${time}]: ${textAndPlaceholders(msg.content)}`;
}

export function renderRecallSourceEntry(entry: RenderableEntry): string | null {
  if (entry.type === "message") return renderRecallMessage(entry);
  if (entry.type === "custom_message") return renderCustomMessage(entry, { recallFormat: true });
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    const time = formatRecallTimestamp(entry.timestamp);
    return `[Branch summary @ ${time}]: ${entry.summary}`;
  }
  return null;
}

export function renderRecallSourceEntries(entries: RenderableEntry[]): string {
  return entries
    .map((entry) => renderRecallSourceEntry(entry))
    .filter((block): block is string => block !== null && block.trim().length > 0)
    .join("\n\n");
}
