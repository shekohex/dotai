import { estimateTokens as estimateMessageTokens } from "@earendil-works/pi-coding-agent";

import { asRecord } from "../../utils/unknown-data.js";

export function estimateStringTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate the rendered footprint of an observation line as it appears in summaries / pool
 * listings: "[id] YYYY-MM-DD HH:MM [relevance] content". Pool budgets that only count bare content
 * undercount every line's metadata overhead (id + timestamp + relevance tags), so the configured
 * pool target was reached later than the rendered memory actually allowed.
 */
/**
 * Estimate the rendered footprint of an observation summary line.
 *
 * @param {{ id: string; timestamp: string; relevance: string; content: string }} observation
 *   Observation fields.
 * @returns {number} Estimated token count of the rendered line.
 */
export function observationLineTokenCount(observation: {
  id: string;
  timestamp: string;
  relevance: string;
  content: string;
}): number {
  return estimateStringTokens(
    `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`,
  );
}

/**
 * Narrow an unknown value to the message shape pi's token estimator accepts.
 *
 * @param {unknown} value Candidate value.
 * @returns {boolean} Whether the value looks like an LLM message.
 */
function isLlmMessage(value: unknown): value is Parameters<typeof estimateMessageTokens>[0] {
  return typeof value === "object" && value !== null && "role" in value;
}

/**
 * Estimate the token footprint of a raw/source session entry.
 *
 * @param {{ type: string; message?: unknown; content?: unknown; summary?: unknown }} entry Session
 *   entry.
 * @returns {number} Estimated token count (0 for unsupported entry shapes).
 */
export function estimateEntryTokens(entry: {
  type: string;
  message?: unknown;
  content?: unknown;
  summary?: unknown;
}): number {
  if (entry.type === "message" && isLlmMessage(entry.message)) {
    return estimateMessageTokens(entry.message);
  }
  if (entry.type === "custom_message" && entry.content !== undefined && entry.content !== null) {
    const content: unknown = entry.content;
    if (typeof content === "string") return estimateStringTokens(content);
    if (Array.isArray(content)) {
      let total = 0;
      for (const block of content) {
        const record = asRecord(block);
        if (record !== undefined && record.type === "text" && typeof record.text === "string") {
          total += estimateStringTokens(record.text);
        }
      }
      return total;
    }
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    return estimateStringTokens(entry.summary);
  }
  return 0;
}
