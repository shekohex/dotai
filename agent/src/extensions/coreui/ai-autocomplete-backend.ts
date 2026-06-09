import { complete, type Api, type Message, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../../utils/error-message.js";
import {
  isAbortSignalAborted,
  modelForOpenAIResponses,
  type ModelFallbackCandidate,
} from "../model-fallbacks.js";
import type { AiAutocompleteSettings } from "./ai-autocomplete-settings.js";

const AI_AUTOCOMPLETE_SYSTEM_PROMPT = `You are an inline autocomplete engine.
Return only text that should be inserted at <cursor>.
No markdown. No explanations. No quotes around the answer.
Prefer short completions: next words or one small phrase.
If no useful completion exists, return an empty response.
Do not repeat text already present before or after the cursor.
Make the completion connect naturally to the suffix when present.`;

const ZETA_NEXT_EDIT_SYSTEM_PROMPT = `You are a next-edit prediction engine, similar to Zed Zeta.
Predict the most likely small edit the user wants next at <cursor>.
Return only insertion text for <cursor>.
No markdown. No explanations. No quotes around the answer.
Prefer short, high-confidence completions.
Use prefix and suffix as constraints. Do not duplicate either side.
You are completing the user's prompt text, not answering it.
If the text before the cursor is a complete question or instruction for an assistant, return an empty response instead of answering.
If there is no obvious next edit, return an empty response.`;

const MAX_PREVIOUS_SUGGESTIONS_CHARS = 250;

export type AiAutocompleteInput = {
  text: string;
  cursorOffset: number;
  cwd: string;
  assistantSummary?: string;
  previousSuggestions?: string[];
  trigger?: "eager" | "manual";
  generationAttempt?: number;
  signal: AbortSignal;
};

export type AutocompleteResponse = {
  suggestions: string[];
  model?: string;
};

export type AiAutocompleteResult = AutocompleteResponse;

export interface AiAutocompleteBackend {
  readonly id: string;
  complete(input: AiAutocompleteInput): Promise<AiAutocompleteResult>;
}

type ModelAuth = {
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
};

export function createAiAutocompleteBackend(
  ctx: ExtensionContext,
  settings: AiAutocompleteSettings,
): AiAutocompleteBackend {
  return createPiAiAutocompleteBackend(ctx, settings);
}

export function createPiAiAutocompleteBackend(
  ctx: ExtensionContext,
  settings: AiAutocompleteSettings,
): AiAutocompleteBackend {
  return {
    id: "pi-ai",
    async complete(input) {
      if (input.text.trim().length < settings.minInputChars) return { suggestions: [] };

      const context = buildFimContext(input, settings);
      const candidates = buildModelCandidates(settings.models, ctx.model);
      for (const candidate of candidates) {
        if (isAbortSignalAborted(input.signal)) return { suggestions: [] };

        const modelAuth = await resolveAutocompleteModelAuth(ctx, candidate);
        if (modelAuth === undefined) continue;

        try {
          const response = await complete(
            modelForOpenAIResponses(modelAuth.model),
            {
              systemPrompt: buildSystemPrompt(settings.promptFormat),
              messages: [buildFimMessage(context, settings.promptFormat)],
            },
            {
              apiKey: modelAuth.apiKey,
              headers: modelAuth.headers,
              maxTokens: settings.maxTokens,
              temperature: settings.temperature,
              timeoutMs: settings.timeoutMs,
              maxRetries: 0,
              signal: input.signal,
            },
          );
          if (response.stopReason === "aborted") return { suggestions: [] };
          if (response.stopReason === "error") {
            ctx.ui.setStatus(
              "ai-autocomplete",
              ctx.ui.theme.fg(
                "warning",
                `autocomplete:${candidate.provider}/${candidate.model} failed: ${response.errorMessage ?? "provider error"}`,
              ),
            );
            continue;
          }

          const text = normalizeCompletion(extractText(response.content), context.suffix);
          if (text.length === 0) continue;
          ctx.ui.setStatus("ai-autocomplete", undefined);
          return {
            suggestions: [text],
            model: `${modelAuth.model.provider}/${modelAuth.model.id}`,
          };
        } catch (error) {
          if (isAbortSignalAborted(input.signal)) return { suggestions: [] };
          ctx.ui.setStatus(
            "ai-autocomplete",
            ctx.ui.theme.fg(
              "warning",
              `autocomplete:${candidate.provider}/${candidate.model} failed: ${errorMessage(error)}`,
            ),
          );
        }
      }

      return { suggestions: [] };
    },
  };
}

export function buildFimContext(
  input: AiAutocompleteInput,
  settings: Pick<
    AiAutocompleteSettings,
    "maxPrefixChars" | "maxSuffixChars" | "maxAssistantSummaryChars"
  >,
): {
  prefix: string;
  suffix: string;
  cwd: string;
  assistantSummary?: string;
  previousSuggestions?: string;
  trigger: "eager" | "manual";
  generationAttempt: number;
} {
  const cursorOffset = Math.max(0, Math.min(input.cursorOffset, input.text.length));
  const prefix = input.text.slice(0, cursorOffset).slice(-settings.maxPrefixChars);
  const suffix = input.text.slice(cursorOffset).slice(0, settings.maxSuffixChars);
  const assistantSummary = input.assistantSummary?.trim().slice(-settings.maxAssistantSummaryChars);
  const previousSuggestions = formatPreviousSuggestions(input.previousSuggestions);
  return {
    prefix,
    suffix,
    cwd: input.cwd,
    trigger: input.trigger ?? "eager",
    generationAttempt: Math.max(1, input.generationAttempt ?? 1),
    ...(assistantSummary !== undefined && assistantSummary.length > 0 ? { assistantSummary } : {}),
    ...(previousSuggestions.length > 0 ? { previousSuggestions } : {}),
  };
}

export function buildFimPrompt(context: {
  prefix: string;
  suffix: string;
  cwd: string;
  assistantSummary?: string;
  previousSuggestions?: string;
  trigger?: "eager" | "manual";
  generationAttempt?: number;
}): string {
  const summarySection = buildAssistantSummarySection(context.assistantSummary);
  const previousSuggestionsSection = buildPreviousSuggestionsSection(context.previousSuggestions);
  const triggerSection = buildAutocompleteTriggerSection(
    context.trigger,
    context.generationAttempt,
  );
  return `Working directory: ${context.cwd}
${summarySection}
${previousSuggestionsSection}
${triggerSection}

Complete text at <cursor>.

<prefix>
${context.prefix}
</prefix>
<cursor>
<suffix>
${context.suffix}
</suffix>

Return only insertion text.`;
}

export function buildZetaNextEditPrompt(context: {
  prefix: string;
  suffix: string;
  cwd: string;
  assistantSummary?: string;
  previousSuggestions?: string;
  trigger?: "eager" | "manual";
  generationAttempt?: number;
}): string {
  const summarySection = buildAssistantSummarySection(context.assistantSummary);
  const previousSuggestionsSection = buildPreviousSuggestionsSection(context.previousSuggestions);
  const triggerSection = buildAutocompleteTriggerSection(
    context.trigger,
    context.generationAttempt,
  );
  return `Working directory: ${context.cwd}
${summarySection}
${previousSuggestionsSection}
${triggerSection}

Predict the user's next edit. The edit must be an insertion at <cursor>.
Use recent trajectory/context to infer intent. If no clear next edit exists, return empty output.

<before_cursor>
${context.prefix}
</before_cursor>
<cursor />
<after_cursor>
${context.suffix}
</after_cursor>

Return only the insertion text. Empty output is allowed.`;
}

function buildAssistantSummarySection(assistantSummary: string | undefined): string {
  if (assistantSummary === undefined || assistantSummary.length === 0) return "";
  return `\n\nPrevious assistant/session summary:\n<summary>\n${assistantSummary}\n</summary>`;
}

function buildPreviousSuggestionsSection(previousSuggestions: string | undefined): string {
  if (previousSuggestions === undefined || previousSuggestions.length === 0) return "";
  return `\n\nPrevious suggestions for this cursor to avoid repeating:\n<previous_suggestions>\n${previousSuggestions}\n</previous_suggestions>\nReturn a different completion if possible.`;
}

function buildAutocompleteTriggerSection(
  trigger: "eager" | "manual" | undefined,
  generationAttempt: number | undefined,
): string {
  if (trigger !== "manual") return "";
  const attempt = Math.max(1, generationAttempt ?? 1);
  const retryInstruction =
    attempt > 1
      ? "\nThe user explicitly requested a fresh alternative. Avoid repeating the likely earlier completion."
      : "";
  return `\n\n<autocomplete_context>\n<trigger>manual</trigger>\n<generation_attempt>${attempt}</generation_attempt>\n</autocomplete_context>${retryInstruction}`;
}

export function formatPreviousSuggestions(previousSuggestions: string[] | undefined): string {
  if (previousSuggestions === undefined) return "";
  const formatted = previousSuggestions
    .map((suggestion) => suggestion.trim())
    .filter((suggestion) => suggestion.length > 0)
    .map(
      (suggestion) => `<suggestion>${escapeXml(suggestion).replaceAll("\n", "\\n")}</suggestion>`,
    )
    .join("\n");
  return formatted.slice(0, MAX_PREVIOUS_SUGGESTIONS_CHARS);
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function normalizeCompletion(text: string, suffix: string): string {
  const trimmed = text
    .replace(/^```[\w-]*\n?/, "")
    .replace(/\n?```$/, "")
    .replace(/^<completion>/, "")
    .replace(/<\/completion>$/, "")
    .replace(/\s+$/, "");
  if (!trimmed) return "";

  const suffixPrefix = suffix.slice(0, Math.min(suffix.length, trimmed.length));
  if (suffixPrefix && trimmed === suffixPrefix) return "";

  for (
    let overlapLength = Math.min(suffix.length, trimmed.length);
    overlapLength > 0;
    overlapLength -= 1
  ) {
    if (trimmed.startsWith(suffix.slice(0, overlapLength))) {
      return trimmed.slice(overlapLength);
    }
  }

  return trimmed;
}

export class DebouncedAiAutocompleteRunner {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private requestId = 0;

  constructor(private readonly debounceMs: number) {}

  schedule<T>(
    run: (signal: AbortSignal) => Promise<T>,
    onResult: (result: T) => void,
    onSettled?: () => void,
  ): void {
    this.scheduleWithDelay(this.debounceMs, run, onResult, onSettled);
  }

  runNow<T>(
    run: (signal: AbortSignal) => Promise<T>,
    onResult: (result: T) => void,
    onSettled?: () => void,
  ): void {
    this.scheduleWithDelay(0, run, onResult, onSettled);
  }

  private scheduleWithDelay<T>(
    delayMs: number,
    run: (signal: AbortSignal) => Promise<T>,
    onResult: (result: T) => void,
    onSettled?: () => void,
  ): void {
    this.cancel();
    const requestId = ++this.requestId;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void run(signal)
        .then((result) => {
          if (requestId === this.requestId && !signal.aborted) onResult(result);
        })
        .catch(() => {})
        .finally(() => {
          if (requestId === this.requestId && !signal.aborted) onSettled?.();
        });
    }, delayMs);
  }

  cancel(): void {
    this.requestId += 1;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.controller?.abort();
    this.controller = undefined;
  }
}

export function buildSystemPrompt(format: AiAutocompleteSettings["promptFormat"]): string {
  return format === "zeta-inspired-next-edit"
    ? ZETA_NEXT_EDIT_SYSTEM_PROMPT
    : AI_AUTOCOMPLETE_SYSTEM_PROMPT;
}

function buildFimMessage(
  context: { prefix: string; suffix: string; cwd: string; assistantSummary?: string },
  format: AiAutocompleteSettings["promptFormat"],
): Message {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text:
          format === "zeta-inspired-next-edit"
            ? buildZetaNextEditPrompt(context)
            : buildFimPrompt(context),
      },
    ],
    timestamp: Date.now(),
  };
}

function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .flatMap((item) => (item.type === "text" && typeof item.text === "string" ? [item.text] : []))
    .join("");
}

function buildModelCandidates(
  modelRefs: readonly string[],
  currentModel: Model<Api> | undefined,
): ModelFallbackCandidate[] {
  return modelRefs.flatMap((modelRef) => parseModelCandidate(modelRef, currentModel));
}

function parseModelCandidate(
  modelRef: string,
  currentModel: Model<Api> | undefined,
): ModelFallbackCandidate[] {
  if (modelRef === "default") {
    return currentModel === undefined
      ? []
      : [{ provider: currentModel.provider, model: currentModel.id }];
  }
  const slashIndex = modelRef.indexOf("/");
  if (slashIndex <= 0 || slashIndex === modelRef.length - 1) return [];
  return [{ provider: modelRef.slice(0, slashIndex), model: modelRef.slice(slashIndex + 1) }];
}

async function resolveAutocompleteModelAuth(
  ctx: ExtensionContext,
  candidate: ModelFallbackCandidate,
): Promise<ModelAuth | undefined> {
  const model = ctx.modelRegistry.find(candidate.provider, candidate.model);
  if (model === undefined) return undefined;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || auth.apiKey === undefined || auth.apiKey.length === 0) return undefined;
  return { model, apiKey: auth.apiKey, headers: auth.headers };
}
