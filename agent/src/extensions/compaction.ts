/**
 * Custom Compaction Extension
 *
 * Replaces the default compaction behavior with a full summary of the entire context.
 * Instead of keeping the last 20k tokens of conversation turns, this extension:
 * 1. Summarizes ALL messages (messagesToSummarize + turnPrefixMessages)
 * 2. Discards all old turns completely, keeping only the summary
 */

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";

const COMPACTION_PROVIDER = "gemini" as const;
const COMPACTION_MODEL = "gemini-3.1-flash-lite-preview" as const;

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    ctx.ui.notify("Compaction extension triggered", "info");

    const { preparation, branchEntries: _, signal } = event;
    const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

    const model = ctx.modelRegistry.find(COMPACTION_PROVIDER, COMPACTION_MODEL);
    if (!model) {
      ctx.ui.notify(`Could not find ${COMPACTION_PROVIDER}/${COMPACTION_MODEL} model, using default compaction`, "warning");
      return;
    }

    // Resolve request auth for the summarization model
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      ctx.ui.notify(`Compaction auth failed: ${auth.error}`, "warning");
      return;
    }

    if (!auth.apiKey) {
      ctx.ui.notify(`No API key for ${model.provider}, using default compaction`, "warning");
      return;
    }

    // Combine all messages for full summary
    const allMessages = [...messagesToSummarize, ...turnPrefixMessages];

    ctx.ui.notify(
      `Compaction: summarizing ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens) with ${model.id}...`,
      "info",
    );

    // Convert messages to readable text format
    const conversationText = serializeConversation(convertToLlm(allMessages));

    // Include previous summary context if available
    const previousContext = previousSummary ? `\n\nPrevious session summary for context:\n${previousSummary}` : "";

    // Build messages that ask for a comprehensive summary
    const summaryMessages = [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.
            Create a comprehensive summary of this conversation that captures:\n${previousContext}
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

    try {
      // Pass signal to honor abort requests (e.g., user cancels compaction)
      const response = await complete(
        model,
        { messages: summaryMessages },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          maxTokens: 8192,
          signal,
        },
      );

      const summary = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      if (!summary.trim()) {
        if (!signal.aborted) ctx.ui.notify("Compaction summary was empty, using default compaction", "warning");
        return;
      }

      const summeryPrefix = `Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:`;

      // Return compaction content - SessionManager adds id/parentId
      // Use firstKeptEntryId from preparation to keep recent messages
      return {
        compaction: {
          summary: `${summeryPrefix}\n\n${summary}`,
          firstKeptEntryId,
          tokensBefore,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Compaction failed: ${message}`, "error");
      // Fall back to default compaction on error
      return;
    }
  });
}
