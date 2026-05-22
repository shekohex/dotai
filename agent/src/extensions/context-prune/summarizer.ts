import { stream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  CapturedBatch,
  ContextPruneConfig,
  SummarizerThinking,
  SummarizeBatchOptions,
  SummarizeBatchesOptions,
  SummarizeResult,
} from "./types.js";
import { serializeBatchForSummarizer } from "./batch-capture.js";
import { errorMessage, isTextContent } from "./guards.js";

const SYSTEM_PROMPT = `You are summarizing a batch of tool calls made by an AI coding assistant.
For each tool call provide:
- Tool name and a one-sentence description of what it did
- Key outcome: success/failure and the most important data returned
- Any findings the future conversation needs to remember

Keep each tool call to 1-3 bullet points. Be concise.`;

export function summarizerThinkingOptions(config: ContextPruneConfig): Record<string, unknown> {
  const level: SummarizerThinking = config.summarizerThinking;
  if (level === "default") {
    return {};
  }

  // stream()/complete() accept provider-level options. For reasoning-capable providers,
  // pi-ai adapters translate reasoningEffort into the provider-specific field.
  // "off" intentionally sends no effort; adapters that support explicit disable
  // handle that the same way as an absent effort, while preserving compatibility.
  return { reasoningEffort: level === "off" ? undefined : level };
}

export function resolveModel(modelName: string, ctx: ExtensionContext): Model<Api> | undefined {
  if (modelName === "default") {
    return ctx.model;
  }

  const slashIndex = modelName.indexOf("/");
  if (slashIndex === -1) {
    return ctx.model;
  }

  return ctx.modelRegistry.find(modelName.slice(0, slashIndex), modelName.slice(slashIndex + 1));
}

function receivedTextChars(message: AssistantMessage): number {
  return message.content.reduce((sum, content) => {
    return isTextContent(content) ? sum + content.text.length : sum;
  }, 0);
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function summarizeBatch(
  batch: CapturedBatch,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions = {},
): Promise<SummarizeResult | null> {
  // Fast-fail if already aborted before we even start.
  if (isSignalAborted(options.signal)) throw new Error("summarizeBatch: aborted before start");

  try {
    const serialized = serializeBatchForSummarizer(batch);
    const userMessage =
      SYSTEM_PROMPT + "\n\n<tool-call-batch>\n" + serialized + "\n</tool-call-batch>";
    const failures: string[] = [];

    for (const modelName of config.summarizerModels) {
      const result = await trySummarizeWithModel(modelName, config, ctx, userMessage, options);
      if (result.ok) return result.value;
      failures.push(result.error);
    }

    ctx.ui.notify(`pruner: summarization failed: ${failures.join("; ")}`, "error");
    return null;
  } catch (err: unknown) {
    if (isSignalAborted(options.signal)) throw err;
    ctx.ui.notify(`pruner: summarization failed: ${errorMessage(err)}`, "error");
    return null;
  }
}

async function trySummarizeWithModel(
  modelName: string,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  userMessage: string,
  options: SummarizeBatchOptions,
): Promise<{ ok: true; value: SummarizeResult } | { ok: false; error: string }> {
  try {
    const model = resolveModel(modelName, ctx);
    if (model === undefined) {
      return { ok: false, error: `${modelName}: not found` };
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      const authMessage = "error" in auth ? auth.error : "authentication failed";
      return { ok: false, error: `${model.id}: ${authMessage}` };
    }

    // Pass the abort signal so the underlying fetch is cancelled immediately
    // when the user presses Esc while the tool is running.
    const responseStream = stream(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userMessage }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: options.signal,
        ...summarizerThinkingOptions(config),
      },
    );

    let lastReportedChars = -1;
    options.onTextProgress?.(0);
    const reportTextProgress = (message: AssistantMessage) => {
      const chars = receivedTextChars(message);
      if (chars !== lastReportedChars) {
        lastReportedChars = chars;
        options.onTextProgress?.(chars);
      }
    };

    for await (const event of responseStream) {
      // Belt-and-suspenders: break early when signal fires mid-stream.
      if (isSignalAborted(options.signal)) break;
      if (event.type === "text_start" || event.type === "text_delta" || event.type === "text_end") {
        reportTextProgress(event.partial);
      }
    }

    // If signal fired while we were iterating, propagate the abort so
    // flushPending can detect it and restore batches.
    if (isSignalAborted(options.signal)) throw new Error("summarizeBatch: aborted during stream");

    const response = await responseStream.result();
    reportTextProgress(response);
    // stopReason "aborted" means the provider cut the stream short (e.g. signal
    // fired just before the final chunk). Treat identically to the signal check
    // above — throw so flushPending's catch can detect options.signal.aborted.
    if (response.stopReason === "aborted") {
      throw new Error("summarizeBatch: stream stopped with reason aborted");
    }
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage ?? "Summarizer stopped with reason: error");
    }

    const llmText = response.content
      .filter(isTextContent)
      .map((content) => content.text)
      .join("\n");

    if (llmText.trim().length === 0) {
      return { ok: false, error: `${model.id}: empty summary` };
    }
    return { ok: true, value: { summaryText: llmText, usage: response.usage } };
  } catch (err: unknown) {
    if (isSignalAborted(options.signal)) throw err;
    return { ok: false, error: `${modelName}: ${errorMessage(err)}` };
  }
}

export async function summarizeBatches(
  batches: CapturedBatch[],
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchesOptions = {},
): Promise<Array<SummarizeResult | null>> {
  if (batches.length === 0) return [];
  // Single batch — delegate to the single-batch path (no extra overhead)
  if (batches.length === 1) {
    const batch = batches[0];
    if (batch === undefined) return [];
    return [
      await summarizeBatch(batch, config, ctx, {
        signal: options.signal,
        onTextProgress: (receivedChars) => {
          options.onBatchTextProgress?.(0, 1, batch, receivedChars);
        },
      }),
    ];
  }

  // Multiple batches — run in parallel; each produces its own SummarizeResult
  return Promise.all(
    batches.map((batch, index) =>
      summarizeBatch(batch, config, ctx, {
        signal: options.signal,
        onTextProgress: (receivedChars) => {
          options.onBatchTextProgress?.(index, batches.length, batch, receivedChars);
        },
      }),
    ),
  );
}
