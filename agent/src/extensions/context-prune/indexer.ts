import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapturedBatch, IndexEntryData, ToolCallRecord } from "./types.js";
import { CUSTOM_TYPE_INDEX, CUSTOM_TYPE_SUMMARY } from "./types.js";
import {
  buildShortToolCallRefs,
  normalizeSummaryToolCallRefs,
  type SummaryToolCallRef,
} from "./summary-refs.js";
import { isCustomEntry, isIndexEntryData } from "./guards.js";

export class ToolCallIndexer {
  private index = new Map<string, ToolCallRecord>();
  private aliasToToolCallId = new Map<string, string>();
  private nextShortAliasNumber = 1;

  reconstructFromSession(ctx: ExtensionContext): void {
    this.index.clear();
    this.aliasToToolCallId.clear();
    this.nextShortAliasNumber = 1;

    const branch = ctx.sessionManager.getBranch();
    for (const entry of branch) {
      if (isCustomEntry(entry, CUSTOM_TYPE_INDEX, isIndexEntryData)) {
        for (const toolCall of entry.data.toolCalls) {
          this.index.set(toolCall.toolCallId, toolCall);
        }
        continue;
      }

      if (entry.type === "custom_message" && entry.customType === CUSTOM_TYPE_SUMMARY) {
        const refs = normalizeSummaryToolCallRefs(entry.details);
        this.registerSummaryRefs(refs);
      }
    }
  }

  isSummarized(toolCallId: string): boolean {
    return this.index.has(toolCallId);
  }

  getIndex(): Map<string, ToolCallRecord> {
    return this.index;
  }

  registerSummaryRefs(refs: SummaryToolCallRef[]): void {
    for (const ref of refs) {
      if (ref.shortId.length === 0 || ref.toolCallId.length === 0) continue;
      if (ref.shortId !== ref.toolCallId) {
        this.aliasToToolCallId.set(ref.shortId, ref.toolCallId);
      }
      const match = /^t(\d+)$/.exec(ref.shortId);
      if (match) {
        this.nextShortAliasNumber = Math.max(this.nextShortAliasNumber, Number(match[1]) + 1);
      }
    }
  }

  allocateSummaryRefs(batch: CapturedBatch): SummaryToolCallRef[] {
    const toolCallIds = batch.toolCalls.map((tc) => tc.toolCallId);
    const { refs, nextIndex } = buildShortToolCallRefs(toolCallIds, this.nextShortAliasNumber);
    this.nextShortAliasNumber = nextIndex;
    return refs;
  }

  resolveToolCallId(toolCallIdOrAlias: string): string | undefined {
    if (this.index.has(toolCallIdOrAlias)) return toolCallIdOrAlias;
    return this.aliasToToolCallId.get(toolCallIdOrAlias);
  }

  getRecord(toolCallIdOrAlias: string): ToolCallRecord | undefined {
    const resolved = this.resolveToolCallId(toolCallIdOrAlias);
    if (resolved === undefined) return undefined;
    return this.index.get(resolved);
  }

  lookupToolCalls(toolCallIds: string[]): ToolCallRecord[] {
    const results: ToolCallRecord[] = [];
    for (const id of toolCallIds) {
      const record = this.getRecord(id);
      if (record !== undefined) {
        results.push(record);
      }
    }
    return results;
  }

  addBatch(batch: CapturedBatch, pi: ExtensionAPI): void {
    const records: ToolCallRecord[] = [];

    for (const tc of batch.toolCalls) {
      const record: ToolCallRecord = {
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
        resultText: tc.resultText,
        isError: tc.isError,
        turnIndex: batch.turnIndex,
        timestamp: batch.timestamp,
      };
      this.index.set(record.toolCallId, record);
      records.push(record);
    }

    pi.appendEntry(CUSTOM_TYPE_INDEX, { toolCalls: records } as IndexEntryData);
  }
}
