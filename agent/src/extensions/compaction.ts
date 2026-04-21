import { complete } from "@mariozechner/pi-ai";
import {
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";

const COMPACTION_PROVIDER = "gemini" as const;
const COMPACTION_MODEL = "gemini-3.1-flash-lite-preview" as const;
const SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

type CompactionModelAuth = {
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  headers?: Record<string, string>;
};

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    ctx.ui.notify("Compaction extension triggered", "info");
    const modelAuth = await resolveCompactionModelAndAuth(ctx);
    if (!modelAuth) {
      return {};
    }

    const preparation = event.preparation;
    const allMessages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
    ctx.ui.notify(
      `Compaction: summarizing ${allMessages.length} messages (${preparation.tokensBefore.toLocaleString()} tokens) with ${modelAuth.model.id}...`,
      "info",
    );

    try {
      const summary = await summarizeCompaction(
        modelAuth,
        allMessages,
        preparation.previousSummary,
        event.signal,
      );
      if (!summary.trim()) {
        if (!event.signal.aborted) {
          ctx.ui.notify("Compaction summary was empty, using default compaction", "warning");
        }
        return {};
      }

      return {
        compaction: {
          summary: `${SUMMARY_PREFIX}\n\n${summary}`,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
        },
      };
    } catch (error) {
      ctx.ui.notify(
        `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return {};
    }
  });
}

async function resolveCompactionModelAndAuth(
  ctx: ExtensionContext,
): Promise<CompactionModelAuth | undefined> {
  const model = ctx.modelRegistry.find(COMPACTION_PROVIDER, COMPACTION_MODEL);
  if (!model) {
    ctx.ui.notify(
      `Could not find ${COMPACTION_PROVIDER}/${COMPACTION_MODEL} model, using default compaction`,
      "warning",
    );
    return undefined;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    ctx.ui.notify(`Compaction auth failed: ${auth.error}`, "warning");
    return undefined;
  }
  if (auth.apiKey === undefined || auth.apiKey.length === 0) {
    ctx.ui.notify(`No API key for ${model.provider}, using default compaction`, "warning");
    return undefined;
  }

  return { model, apiKey: auth.apiKey, headers: auth.headers };
}

async function summarizeCompaction(
  modelAuth: CompactionModelAuth,
  allMessages: Parameters<typeof convertToLlm>[0],
  previousSummary: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const response = await complete(
    modelAuth.model,
    { messages: buildSummaryMessages(allMessages, previousSummary) },
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

function buildSummaryMessages(
  messages: Parameters<typeof convertToLlm>[0],
  previousSummary: string | undefined,
) {
  const conversationText = serializeConversation(convertToLlm(messages));
  const previousContext =
    previousSummary !== undefined && previousSummary.length > 0
      ? `\n\nPrevious session summary for context:\n${previousSummary}`
      : "";

  return [
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.
Create a comprehensive summary of this conversation that captures:${previousContext}

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
