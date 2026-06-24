import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { createWrappedError, getErrorMessage } from "./errors.js";
import { isNonNullObject } from "./guards.js";
import { isRichOption, validateQuestions, type OptionValue } from "./schema.js";
import type { AskModelOption, OptionInsightResult } from "./types.js";
import { completeModel } from "../pi-ai-models.js";

export interface GenerateModelCandidate {
  provider: string;
  id: string;
}

const GeneratedStringOptionsSchema = Type.Array(Type.String({ minLength: 1 }), { minItems: 1 });
const ReviewedQuestionSchema = Type.Object(
  {
    question: Type.String({ minLength: 1 }),
    options: GeneratedStringOptionsSchema,
  },
  { additionalProperties: true },
);
const OptionInsightSchema = Type.Object(
  {
    summary: Type.String({ minLength: 1 }),
    bullets: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    suggestedText: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: true },
);

type ReviewedQuestion = Static<typeof ReviewedQuestionSchema>;
type OptionInsight = Static<typeof OptionInsightSchema>;

export const PREFERRED_GENERATE_MODELS = ["openai/gpt-5.4-mini", "google/gemini-2.5-flash"];

export const GENERATE_OPTIONS_SYSTEM_PROMPT =
  "You generate interview answer options. Return only JSON array of strings. Do not include explanations or markdown.";

export const REVIEW_QUESTION_SYSTEM_PROMPT =
  "You review interview questions and answer options. Preserve intent. Return only JSON with rewritten question string and options array.";

export const OPTION_INSIGHT_SYSTEM_PROMPT =
  'You analyze single interview answer option. Return only JSON with this shape: {"summary":"...","bullets":["..."],"suggestedText":"..."}. Keep summary concise, bullets short, and omit suggestedText when no rewrite is needed.';

export function formatModelRef(model: GenerateModelCandidate): string {
  return `${model.provider}/${model.id}`;
}

function findModelByRef<T extends GenerateModelCandidate>(models: T[], modelRef: string): T | null {
  for (const model of models) {
    if (formatModelRef(model) === modelRef) {
      return model;
    }
  }
  return null;
}

export function selectGenerateModels<T extends GenerateModelCandidate>(
  configuredModel: T | null,
  currentModel: T | null,
  availableModels: T[],
): { primary: T | null; fallback: T | null } {
  if (configuredModel) {
    if (currentModel === null || formatModelRef(currentModel) === formatModelRef(configuredModel)) {
      return { primary: configuredModel, fallback: null };
    }
    return { primary: configuredModel, fallback: currentModel };
  }

  if (currentModel) {
    return { primary: currentModel, fallback: null };
  }

  for (const modelRef of PREFERRED_GENERATE_MODELS) {
    const preferredModel = findModelByRef(availableModels, modelRef);
    if (preferredModel) {
      return { primary: preferredModel, fallback: null };
    }
  }

  return { primary: availableModels[0] ?? null, fallback: null };
}

export function buildAskModelsData(
  availableModels: Model<Api>[],
  currentModel: Model<Api> | null,
  primaryModel: Model<Api> | null,
  fallbackModel: Model<Api> | null,
): AskModelOption[] {
  const models: AskModelOption[] = [];
  const seen = new Set<string>();
  const addModel = (model: Model<Api> | null): void => {
    if (model === null) return;
    const value = `${model.provider}/${model.id}`;
    if (seen.has(value)) return;
    seen.add(value);
    models.push({
      value,
      provider: model.provider,
      label: model.id,
    });
  };

  addModel(currentModel);
  addModel(primaryModel);
  addModel(fallbackModel);
  for (const modelRef of PREFERRED_GENERATE_MODELS) {
    addModel(findModelByRef(availableModels, modelRef));
  }

  return models;
}

export function extractGenerateResponseText(
  modelRef: string,
  response: Pick<AssistantMessage, "content" | "stopReason" | "errorMessage">,
): string {
  if (response.stopReason === "aborted") {
    throw new Error("Aborted");
  }
  if (response.stopReason === "error") {
    if (response.errorMessage === undefined) {
      throw new Error(`${modelRef} failed`);
    }
    throw new Error(`${modelRef}: ${response.errorMessage}`);
  }

  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  if (text.length === 0) {
    throw new Error(`${modelRef} returned no text response`);
  }
  return text;
}

function extractJSONBlock(text: string, openChar: "[" | "{", closeChar: "]" | "}"): string {
  const start = text.indexOf(openChar);
  if (start === -1) {
    return text;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (character === undefined) {
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (character === "\\") {
        escaping = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === openChar) {
      depth += 1;
      continue;
    }
    if (character !== closeChar) {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return text.slice(start, index + 1);
    }
  }

  return text;
}

export function extractJSONArray(text: string): string {
  return extractJSONBlock(text, "[", "]");
}

function extractJSONObject(text: string): string {
  return extractJSONBlock(text, "{", "}");
}

export function createGenerateContext(
  prompt: string,
  systemPrompt = GENERATE_OPTIONS_SYSTEM_PROMPT,
) {
  return {
    systemPrompt,
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: prompt }],
        timestamp: Date.now(),
      },
    ],
  };
}

function parseJsonText(text: string, selector: (value: string) => string): unknown {
  const parsed: unknown = JSON.parse(selector(text));
  return parsed;
}

function normalizeGeneratedOptions(parsed: unknown): string[] {
  if (!Value.Check(GeneratedStringOptionsSchema, parsed)) {
    throw new TypeError("Expected array of non-empty option strings");
  }
  return Value.Parse(GeneratedStringOptionsSchema, parsed).map((option) => option.trim());
}

function normalizeGeneratedOptionValues(parsed: unknown): OptionValue[] {
  if (!Array.isArray(parsed)) {
    throw new TypeError("Expected array of options");
  }

  const normalizedInput = parsed
    .map((option): unknown => {
      if (typeof option === "string") {
        return option.trim();
      }
      if (!isNonNullObject(option)) {
        return option;
      }
      return {
        ...option,
        label: typeof option.label === "string" ? option.label.trim() : option.label,
      };
    })
    .filter((option): boolean => {
      if (typeof option === "string") {
        return option.length > 0;
      }
      if (!isNonNullObject(option)) {
        return true;
      }
      const label = option.label;
      return typeof label !== "string" || label.length > 0;
    });

  const validated = validateQuestions({
    questions: [
      {
        id: "generated-options",
        type: "single",
        question: "Generated options",
        options: normalizedInput,
      },
    ],
  });
  const options = validated.questions[0]?.options;
  if (options === undefined || options.length === 0) {
    throw new Error("No valid options generated");
  }
  return options;
}

export function parseGeneratedOptions(text: string): string[] {
  try {
    return normalizeGeneratedOptions(parseJsonText(text, extractJSONArray));
  } catch (error) {
    throw createWrappedError(`Failed to parse generated options: ${getErrorMessage(error)}`, error);
  }
}

export function parseGeneratedOptionValues(text: string): OptionValue[] {
  try {
    return normalizeGeneratedOptionValues(parseJsonText(text, extractJSONArray));
  } catch (error) {
    throw createWrappedError(`Failed to parse generated options: ${getErrorMessage(error)}`, error);
  }
}

function parseReviewedQuestionObject(text: string): ReviewedQuestion {
  const parsed = parseJsonText(text, extractJSONObject);
  if (!Value.Check(ReviewedQuestionSchema, parsed)) {
    throw new TypeError("Expected reviewed question object");
  }
  return Value.Parse(ReviewedQuestionSchema, parsed);
}

export function parseReviewedQuestion(text: string): { question: string; options: string[] } {
  try {
    const review = parseReviewedQuestionObject(text);
    return {
      question: review.question.trim(),
      options: normalizeGeneratedOptions(review.options),
    };
  } catch (error) {
    throw createWrappedError(`Failed to parse reviewed question: ${getErrorMessage(error)}`, error);
  }
}

export function parseReviewedQuestionUpdate(text: string): {
  question: string;
  options: OptionValue[];
} {
  try {
    const review = parseReviewedQuestionObject(text);
    const options = normalizeGeneratedOptionValues(review.options);
    if (options.some((option) => !isRichOption(option))) {
      throw new Error("Reviewed rich options must all be objects with label");
    }
    return {
      question: review.question.trim(),
      options,
    };
  } catch (error) {
    throw createWrappedError(`Failed to parse reviewed question: ${getErrorMessage(error)}`, error);
  }
}

export function parseOptionInsight(text: string): OptionInsightResult {
  try {
    const parsed = parseJsonText(text, extractJSONObject);
    if (!Value.Check(OptionInsightSchema, parsed)) {
      throw new TypeError("Expected option insight object");
    }
    const insight: OptionInsight = Value.Parse(OptionInsightSchema, parsed);
    const bullets = insight.bullets
      ?.map((bullet) => bullet.trim())
      .filter((bullet) => bullet.length > 0);
    return {
      summary: insight.summary.trim(),
      bullets: bullets !== undefined && bullets.length > 0 ? bullets : undefined,
      suggestedText:
        insight.suggestedText !== undefined && insight.suggestedText.trim().length > 0
          ? insight.suggestedText.trim()
          : undefined,
    };
  } catch (error) {
    throw createWrappedError(`Failed to parse option insight: ${getErrorMessage(error)}`, error);
  }
}

export async function completeForInterview<T>(options: {
  ctx: {
    modelRegistry: {
      getApiKeyAndHeaders: (model: Model<Api>) => Promise<{
        ok: boolean;
        apiKey?: string;
        headers?: Record<string, string>;
        error?: string;
      }>;
    };
  };
  model: Model<Api>;
  prompt: string;
  signal: AbortSignal;
  parse: (text: string) => T;
  systemPrompt?: string;
}): Promise<T> {
  const { ctx, model, prompt, signal, parse, systemPrompt } = options;
  const modelRef = formatModelRef(model);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(`${modelRef}: ${auth.error ?? "Authentication failed"}`);
  }
  if (auth.apiKey === undefined) {
    throw new Error(`No API key for ${modelRef}`);
  }

  const response = await completeModel(model, createGenerateContext(prompt, systemPrompt), {
    apiKey: auth.apiKey,
    headers: auth.headers,
    signal,
  });
  return parse(extractGenerateResponseText(modelRef, response));
}
