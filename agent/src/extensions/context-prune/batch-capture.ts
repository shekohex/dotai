import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CapturedBatch, CapturedToolCall, BatchingMode } from "./types.js";
import {
  findToolResult,
  isAssistantMessage,
  isTextContent,
  isToolCallContent,
  isToolResultMessage,
  textFromContent,
  toRecord,
  type ToolResultMessageWithUnknownDetails,
} from "./guards.js";

export function captureBatch(
  message: AgentMessage,
  toolResults: ToolResultMessageWithUnknownDetails[],
  turnIndex: number,
  timestamp: number,
): CapturedBatch {
  const content = isAssistantMessage(message) ? message.content : [];

  const assistantText = content
    .filter((block) => isTextContent(block))
    .map((block) => block.text)
    .join("\n")
    .trim();

  const toolCalls: CapturedToolCall[] = content
    .filter((block) => isToolCallContent(block))
    .map((block) => {
      const match = findToolResult(toolResults, block.id);

      let resultText = "(no result)";
      let isError = false;

      if (match !== undefined) {
        resultText = textFromContent(match.content);
        isError = match.isError;
      }

      return {
        toolCallId: block.id,
        toolName: block.name,
        args: toRecord(block.input ?? block.args ?? block.arguments),
        resultText,
        isError,
      } satisfies CapturedToolCall;
    });

  return { turnIndex, timestamp, assistantText, toolCalls };
}

export function captureUnindexedBatchesFromSession(
  branch: SessionEntry[],
  indexer: { isSummarized(id: string): boolean },
  excludeToolNames: string[] = [],
): CapturedBatch[] {
  const resultMap = new Map<string, ToolResultMessageWithUnknownDetails>();
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    if (isToolResultMessage(entry.message)) {
      resultMap.set(entry.message.toolCallId, entry.message);
    }
  }

  const batches: CapturedBatch[] = [];
  // turnCounter increments for EVERY assistant message (not just prunable ones).
  // This makes turnIndex stable across multiple prune cycles: pruning removes
  // ToolResultMessages from the context event but leaves AssistantMessages in the
  // session branch, so the count of all assistant messages never decreases and
  // always matches Pi's own event.turnIndex numbering.
  let turnCounter = 0;

  // userTurnGroup increments on every user message seen while walking the branch.
  // All assistant tool-call batches between two consecutive user messages share the
  // same userTurnGroup. This is used by groupBatchesByMode to merge turns within
  // a single user → final-agent-message span when batchingMode === "agent-message".
  let userTurnGroup = 0;

  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const { message } = entry;

    // Advance userTurnGroup on every user message so all subsequent assistant
    // batches get a new group number.
    if (message.role === "user") {
      userTurnGroup++;
      continue;
    }

    if (!isAssistantMessage(message)) continue;

    // Stable turn index: count every assistant message regardless of pruning state
    const currentTurnIndex = turnCounter++;

    const toolCallBlocks = message.content.filter(isToolCallContent);

    // Find tool calls that have results in this branch and are not yet summarized
    const readyToPrune = toolCallBlocks.filter((tc) => {
      const id = tc.id;
      if (indexer.isSummarized(id)) return false;
      if (excludeToolNames.includes(tc.name)) return false;
      return resultMap.has(id);
    });

    if (readyToPrune.length > 0) {
      const results = readyToPrune.flatMap((tc) => {
        const result = resultMap.get(tc.id);
        return result === undefined ? [] : [result];
      });
      const readyIds = new Set(readyToPrune.map((tc) => tc.id));
      // We pass the full message but then trim back down to only the tool calls
      // whose results already exist in the session. This lets agentic-auto prune
      // an intermediate completed subset in the middle of a longer tool chain
      // without accidentally capturing later unresolved calls from the same
      // assistant message as "(no result)" placeholders.
      const timestamp =
        entry.timestamp.length > 0 ? new Date(entry.timestamp).getTime() : message.timestamp;
      const batch = captureBatch(message, results, currentTurnIndex, timestamp);
      batches.push({
        ...batch,
        toolCalls: batch.toolCalls.filter((tc) => readyIds.has(tc.toolCallId)),
        // Tag with the current group so flushPending can merge by mode
        userTurnGroup,
      });
    }
  }

  return batches;
}

export function serializeBatchForSummarizer(batch: CapturedBatch): string {
  const parts: string[] = [];

  if (batch.assistantText.length > 0) {
    parts.push(`Assistant said: ${batch.assistantText}\n`);
  }

  const toolParts = batch.toolCalls.map((tc) => {
    const status = tc.isError ? "ERROR" : "OK";
    const argsJson = JSON.stringify(tc.args, null, 2);

    let resultText = tc.resultText;
    const MAX_CHARS = 2000;
    if (resultText.length > MAX_CHARS) {
      const remaining = resultText.length - MAX_CHARS;
      resultText = resultText.slice(0, MAX_CHARS) + ` ...[${remaining} chars truncated]`;
    }

    return `Tool: ${tc.toolName}(${argsJson})\nResult (${status}): ${resultText}`;
  });

  parts.push(toolParts.join("\n---\n"));

  return parts.join("\n");
}

export function serializeBatchesForSummarizer(batches: CapturedBatch[]): string {
  return batches
    .map((batch, i) => {
      const header = `=== Turn ${batch.turnIndex}${i > 0 ? ` (batch ${i + 1})` : ""} ===`;
      const body = serializeBatchForSummarizer(batch);
      return `${header}\n${body}`;
    })
    .join("\n\n");
}

export function groupBatchesByMode(batches: CapturedBatch[], mode: BatchingMode): CapturedBatch[] {
  if (mode !== "agent-message") return batches;

  const out: CapturedBatch[] = [];
  // current tracks the mutable merged batch being built for the current group.
  // We spread into a plain object so we can mutate it without affecting the source.
  let current: (CapturedBatch & { userTurnGroup: number }) | null = null;

  for (const batch of batches) {
    // Batches without a group key are passed through individually; they break
    // any open merge group too since we can't confidently assign them a span.
    if (batch.userTurnGroup === undefined) {
      current = null;
      out.push(batch);
      continue;
    }

    if (current !== null && current.userTurnGroup === batch.userTurnGroup) {
      // Same span — merge into the current accumulated batch
      const textParts = [current.assistantText, batch.assistantText].filter(
        (text) => text.length > 0,
      );
      current.assistantText = textParts.join("\n\n");
      current.toolCalls = current.toolCalls.concat(batch.toolCalls);
      // Advance to the latest turn metadata
      current.turnIndex = batch.turnIndex;
      current.timestamp = batch.timestamp;
    } else {
      // New group — create a fresh accumulated batch (shallow copy so mutations
      // to `current` do not bleed back into the original `batch` object)
      current = { ...batch, userTurnGroup: batch.userTurnGroup };
      out.push(current);
    }
  }

  return out;
}
