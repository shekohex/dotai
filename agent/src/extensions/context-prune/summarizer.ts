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
import { modelForOpenAIResponses } from "../model-fallbacks.js";

const RATE_LIMIT_FALLBACK_DELAY_MS = 2000;
const MIN_RATE_LIMIT_DELAY_MS = 250;

interface SummarizerCooldownState {
  readonly modelCooldownUntilMs: Map<string, number>;
}

const SYSTEM_PROMPT = `You are summarizing a batch of tool calls made by an AI coding assistant.
For each tool call provide:
- Tool name and a one-sentence description of what it did
- Key outcome: success/failure and the most important data returned
- Any findings the future conversation needs to remember

Preserve concrete recovery details:
- Exact file paths, symbols, commands, errors, test results, commit hashes, and user feedback when present
- Decisions made and constraints discovered
- Failed approaches and why they failed

Do not invent details or infer beyond the tool results. If output is truncated or inconclusive, say so.
Keep each tool call to 1-3 bullet points. Be concise but complete enough to avoid repeating work after pruning.`;

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

function createSummarizerCooldownState(): SummarizerCooldownState {
  return { modelCooldownUntilMs: new Map() };
}

function modelCooldownKey(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function modelErrorLabel(modelName: string, model: Model<Api> | undefined): string {
  return model === undefined ? modelName : modelCooldownKey(model);
}

function availableAfterMs(cooldownState: SummarizerCooldownState, model: Model<Api>): number {
  const cooldownUntilMs = cooldownState.modelCooldownUntilMs.get(modelCooldownKey(model)) ?? 0;
  return Math.max(0, cooldownUntilMs - Date.now());
}

function markRateLimited(
  cooldownState: SummarizerCooldownState,
  model: Model<Api>,
  error: unknown,
): number {
  const delayMs = rateLimitDelayMs(error);
  const cooldownUntilMs = Date.now() + delayMs;
  const key = modelCooldownKey(model);
  cooldownState.modelCooldownUntilMs.set(
    key,
    Math.max(cooldownState.modelCooldownUntilMs.get(key) ?? 0, cooldownUntilMs),
  );
  return delayMs;
}

function rateLimitDelayMs(error: unknown): number {
  const message = errorMessage(error);
  const parsedDelayMs = parseRateLimitDelayMs(message);
  if (parsedDelayMs !== undefined) return Math.max(MIN_RATE_LIMIT_DELAY_MS, parsedDelayMs);
  return RATE_LIMIT_FALLBACK_DELAY_MS;
}

function parseRateLimitDelayMs(message: string): number | undefined {
  const durationMatch =
    /(?:retryDelay|quotaResetDelay|retry after|quota will reset after)[^0-9]*(\d+(?:\.\d+)?)\s*(ms|s)?/i.exec(
      message,
    );
  if (durationMatch !== null) {
    const value = Number(durationMatch[1]);
    const unit = durationMatch[2]?.toLowerCase();
    if (Number.isFinite(value)) return unit === "ms" ? value : value * 1000;
  }

  const timestampMatch = /quotaResetTimeStamp[^0-9]*(\d{4}-\d{2}-\d{2}T[^\s"}]+)/i.exec(message);
  if (timestampMatch !== null) {
    const timestampMs = Date.parse(timestampMatch[1]);
    if (Number.isFinite(timestampMs)) return Math.max(0, timestampMs - Date.now());
  }

  return undefined;
}

function isRateLimitError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("rate_limit") ||
    message.includes("ratelimit") ||
    message.includes("resource_exhausted") ||
    message.includes("throttling_error") ||
    message.includes("quota will reset") ||
    message.includes("retryinfo")
  );
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
    const cooldownState = options.cooldownState ?? createSummarizerCooldownState();

    for (const modelName of config.summarizerModels) {
      const result = await trySummarizeWithModel(
        modelName,
        config,
        ctx,
        userMessage,
        options,
        cooldownState,
      );
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
  cooldownState: SummarizerCooldownState,
): Promise<{ ok: true; value: SummarizeResult } | { ok: false; error: string }> {
  let model: Model<Api> | undefined;
  try {
    model = resolveModel(modelName, ctx);
    if (model === undefined) {
      return { ok: false, error: `${modelName}: not found` };
    }

    const cooldownMs = availableAfterMs(cooldownState, model);
    if (cooldownMs > 0) {
      return { ok: false, error: `${modelCooldownKey(model)}: rate limited for ${cooldownMs}ms` };
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      const authMessage = "error" in auth ? auth.error : "authentication failed";
      return { ok: false, error: `${model.id}: ${authMessage}` };
    }

    const postAuthCooldownMs = availableAfterMs(cooldownState, model);
    if (postAuthCooldownMs > 0) {
      return {
        ok: false,
        error: `${modelCooldownKey(model)}: rate limited for ${postAuthCooldownMs}ms`,
      };
    }

    // Pass the abort signal so the underlying fetch is cancelled immediately
    // when the user presses Esc while the tool is running.
    const streamModel = modelForOpenAIResponses(model);
    const responseStream = stream(
      streamModel,
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
      return { ok: false, error: `${modelCooldownKey(model)}: empty summary` };
    }
    return { ok: true, value: { summaryText: llmText, usage: response.usage } };
  } catch (err: unknown) {
    if (isSignalAborted(options.signal)) throw err;
    if (model !== undefined && isRateLimitError(err)) {
      const delayMs = markRateLimited(cooldownState, model, err);
      return {
        ok: false,
        error: `${modelCooldownKey(model)}: rate limited for ${delayMs}ms: ${errorMessage(err)}`,
      };
    }
    return { ok: false, error: `${modelErrorLabel(modelName, model)}: ${errorMessage(err)}` };
  }
}

export async function summarizeBatches(
  batches: CapturedBatch[],
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchesOptions = {},
): Promise<Array<SummarizeResult | null>> {
  if (batches.length === 0) return [];
  const cooldownState = createSummarizerCooldownState();
  // Single batch — delegate to the single-batch path (no extra overhead)
  if (batches.length === 1) {
    const batch = batches[0];
    if (batch === undefined) return [];
    return [
      await summarizeBatch(batch, config, ctx, {
        cooldownState,
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
        cooldownState,
        signal: options.signal,
        onTextProgress: (receivedChars) => {
          options.onBatchTextProgress?.(index, batches.length, batch, receivedChars);
        },
      }),
    ),
  );
}
