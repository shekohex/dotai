import { Type } from "typebox";
import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { FlushOptions } from "./types.js";
import { CONTEXT_PRUNE_TOOL_NAME } from "./types.js";
import { pruneProgressText } from "./progress-text.js";
import { errorMessage } from "./guards.js";
import { renderContextPruneCall, renderContextPruneResult } from "./tool-render.js";

type FlushResult =
  | {
      ok: true;
      reason: "flushed";
      batchCount: number;
      toolCallCount: number;
      rawCharCount: number;
      summaryCharCount: number;
    }
  | {
      ok: true;
      reason: "skipped-oversized" | "skipped-undersized";
      batchCount: number;
      toolCallCount: number;
      rawCharCount: number;
      summaryCharCount: number;
    }
  | { ok: false; reason: string; error?: string };

function sendToolProgress(
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  text: string,
): void {
  onUpdate?.({
    content: [{ type: "text", text }],
    details: {},
  });
}

export function registerContextPruneTool(
  pi: ExtensionAPI,
  flushFn: (ctx: ExtensionContext, options?: FlushOptions) => Promise<FlushResult>,
): void {
  pi.registerTool({
    name: CONTEXT_PRUNE_TOOL_NAME,
    label: "Prune Context",
    renderShell: "self",
    description:
      "Summarize and prune preceding tool-call results from context to reduce context size. " +
      "Call this after completing a batch of 8–10 related tool calls to keep context lean. " +
      "Pruned outputs can be recovered in full using the context_tree_query tool.",
    promptSnippet: "Summarize and prune preceding tool-call results to reduce context size",
    promptGuidelines: [
      "Use after completing a batch of 8–10 related tool calls, not after every 2–3 calls.",
      "Pruned outputs can be recovered in full using context_tree_query with the short refs from the summary.",
      "Do NOT use this tool for trivial or single tool calls — only when context is getting large.",
    ],
    parameters: Type.Object({}),
    renderCall: renderContextPruneCall,
    renderResult: renderContextPruneResult,

    async execute(_toolCallId, _params, signal, onUpdate, ctx) {
      try {
        sendToolProgress(onUpdate, "Context prune running… (press Esc to cancel)");

        let lastProgressText = "Context prune running…";
        const result = await flushFn(ctx, {
          signal,
          onBatchTextProgress: (index, total, batch, receivedChars) => {
            const next = pruneProgressText(batch, index, total, receivedChars, "running");
            if (next === lastProgressText) return;
            lastProgressText = next;
            sendToolProgress(onUpdate, next);
          },
        });
        if (!result.ok) {
          if (result.reason === "aborted") {
            const cancelledText =
              "Context prune was cancelled (Esc pressed). No batches were summarized and the prune frontier was not advanced. You can call context_prune again when ready.";
            sendToolProgress(onUpdate, "⊘ Context prune cancelled.");
            return {
              content: [{ type: "text", text: cancelledText }],
              details: result,
            };
          }
          const suffix =
            "error" in result && result.error !== undefined && result.error.length > 0
              ? ` (${result.error})`
              : "";
          return {
            content: [
              {
                type: "text",
                text: `Context prune did not run: ${result.reason}${suffix}.`,
              },
            ],
            details: result,
          };
        }

        if (result.reason === "skipped-oversized") {
          return {
            content: [
              {
                type: "text",
                text: `Context prune skipped ${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"}: the summary was ${result.summaryCharCount} chars while the raw tool results were ${result.rawCharCount} chars. The original tool results were kept, and the prune frontier advanced so the next prune starts after this range.`,
              },
            ],
            details: result,
          };
        }

        if (result.reason === "skipped-undersized") {
          return {
            content: [
              {
                type: "text",
                text: `Context prune skipped ${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"}: raw results were below the configured minimum size. The original tool results were kept, and the prune frontier advanced so the next prune starts after this range.`,
              },
            ],
            details: result,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Context prune completed. Summarized ${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"} from ${result.batchCount} batch${result.batchCount === 1 ? "" : "es"}. Summary size: ${result.summaryCharCount} chars vs ${result.rawCharCount} raw chars. Use context_tree_query with the short refs from the summary to retrieve full outputs if needed.`,
            },
          ],
          details: result,
        };
      } catch (err: unknown) {
        const message = errorMessage(err);
        return {
          content: [
            {
              type: "text",
              text: `Context prune failed: ${message}`,
            },
          ],
          details: { ok: false, reason: "failed", error: message },
        };
      }
    },
  });
}
