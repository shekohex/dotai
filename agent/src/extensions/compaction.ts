import {
  convertToLlm,
  serializeConversation,
  type compact,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../utils/error-message.js";
import {
  DEFAULT_MODEL_FALLBACKS,
  isAbortSignalAborted,
  modelForOpenAIResponses,
  resolveModelFallbackAuth,
  type ModelAuth,
} from "./model-fallbacks.js";

export { isAbortSignalAborted } from "./model-fallbacks.js";
import {
  mergeCompactSanitizeStats,
  sanitizeMessagesForCompact,
} from "./context-prune/compact-sanitizer.js";
import { getContextPruneAPI } from "./context-prune/public-api.js";
import { completeModel } from "./pi-ai-models.js";

type CompactionPreparation = Parameters<typeof compact>[0];
const SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    ctx.ui.notify("Compaction extension triggered", "info");
    const preparation = event.preparation;
    const signal = event.signal;
    const sanitizedPreparation = sanitizePreparationForCompaction(ctx, preparation);
    const allMessages = [
      ...sanitizedPreparation.messagesToSummarize,
      ...sanitizedPreparation.turnPrefixMessages,
    ];

    for (const fallbackModel of DEFAULT_MODEL_FALLBACKS) {
      const modelAuth = await resolveModelFallbackAuth(ctx, fallbackModel, "Compaction");
      if (!modelAuth) {
        continue;
      }

      ctx.ui.notify(
        `Compaction: summarizing ${allMessages.length} messages (${preparation.tokensBefore.toLocaleString()} tokens) with ${modelAuth.model.id}...`,
        "info",
      );

      try {
        const summary = await summarizeCompaction(
          modelAuth,
          allMessages,
          preparation.previousSummary,
          event.customInstructions,
          signal,
        );
        if (!summary.trim()) {
          if (!isAbortSignalAborted(signal)) {
            ctx.ui.notify(
              `Compaction summary was empty for ${modelAuth.model.id}, trying next fallback`,
              "warning",
            );
          }
          continue;
        }

        return {
          compaction: {
            summary: `${SUMMARY_PREFIX}\n\n${summary}`,
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
            details: sanitizedPreparation.details,
          },
        };
      } catch (error) {
        ctx.ui.notify(
          `Compaction failed with ${modelAuth.model.id}: ${errorMessage(error)}. Trying next fallback`,
          "error",
        );
      }
    }

    if (!isAbortSignalAborted(signal)) {
      ctx.ui.notify("Compaction fallback list exhausted, using default compaction", "warning");
    }

    return {};
  });
}

function sanitizePreparationForCompaction(
  ctx: ExtensionContext,
  preparation: CompactionPreparation,
) {
  const pruner = getContextPruneAPI(ctx);
  if (pruner === null || pruner.getIndexer().getIndex().size === 0) {
    return { ...preparation, details: undefined };
  }
  const indexer = pruner.getIndexer();
  const summarized = sanitizeMessagesForCompact(preparation.messagesToSummarize, indexer);
  const turnPrefix = sanitizeMessagesForCompact(preparation.turnPrefixMessages, indexer);
  const stats = mergeCompactSanitizeStats(summarized.stats, turnPrefix.stats);
  return {
    ...preparation,
    messagesToSummarize: summarized.messages,
    turnPrefixMessages: turnPrefix.messages,
    details: stats.changed ? { contextPrune: { sanitized: true, ...stats } } : undefined,
  };
}

async function summarizeCompaction(
  modelAuth: ModelAuth,
  allMessages: Parameters<typeof convertToLlm>[0],
  previousSummary: string | undefined,
  customInstructions: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const response = await completeModel(
    modelForOpenAIResponses(modelAuth.model),
    { messages: buildSummaryMessages(allMessages, previousSummary, customInstructions) },
    {
      apiKey: modelAuth.apiKey,
      headers: modelAuth.headers,
      maxTokens: 8192,
      signal,
    },
  );

  return response.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

export function buildSummaryMessages(
  messages: Parameters<typeof convertToLlm>[0],
  previousSummary: string | undefined,
  customInstructions: string | undefined,
) {
  const conversationText = serializeConversation(convertToLlm(messages));
  const previousContext =
    previousSummary !== undefined && previousSummary.length > 0
      ? `\n\nPrevious session summary for context:\n${previousSummary}`
      : "";
  const additionalInstructions =
    customInstructions !== undefined && customInstructions.trim().length > 0
      ? `\n\n# Additional Constraints And Instructions\n${customInstructions.trim()}`
      : "";

  return [
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.
Create a comprehensive summary of this conversation that captures:${previousContext}${additionalInstructions}

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
Format the summary as structured markdown with clear sections.

<conversation>
${conversationText}
</conversation>`,
        },
      ],
      timestamp: Date.now(),
    },
  ];
}
