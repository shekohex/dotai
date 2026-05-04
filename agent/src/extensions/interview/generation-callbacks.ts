import type { Api, Model } from "@mariozechner/pi-ai";

import { createWrappedError, getErrorMessage, toError } from "./errors.js";
import { isNonEmptyString } from "./guards.js";
import {
  REVIEW_QUESTION_SYSTEM_PROMPT,
  OPTION_INSIGHT_SYSTEM_PROMPT,
  completeForInterview,
  parseGeneratedOptions,
  parseGeneratedOptionValues,
  parseOptionInsight,
  parseReviewedQuestion,
  parseReviewedQuestionUpdate,
} from "./generation.js";
import {
  getOptionLabel,
  isRichOption,
  type OptionValue,
  type Question,
  type QuestionsFile,
} from "./schema.js";
import type { OptionInsightResult } from "./types.js";

type GenerateCallbacksContext = {
  modelRegistry: {
    getApiKeyAndHeaders: (model: Model<Api>) => Promise<{
      ok: boolean;
      apiKey?: string;
      headers?: Record<string, string>;
      error?: string;
    }>;
    find: (provider: string, modelId: string) => Model<Api> | undefined;
  };
};

type GenerateMode = "add" | "review";
type InsightDepth = "quick" | "standard" | "deep";

function joinPromptLines(lines: Array<string | null>): string {
  return lines.filter((line): line is string => line !== null).join("\n");
}

function formatRecommended(question: Question): string | null {
  if (question.recommended === undefined) {
    return null;
  }
  const value = Array.isArray(question.recommended)
    ? question.recommended.join(", ")
    : question.recommended;
  return `\nRecommended: ${value}`;
}

function optionalPromptLine(prefix: string, value: string | undefined): string | null {
  return isNonEmptyString(value) ? `${prefix}${value}` : null;
}

function buildReviewPrompt(
  question: Question,
  questionsData: QuestionsFile,
  usesRichOptions: boolean,
): string {
  const recommended = formatRecommended(question);
  if (usesRichOptions) {
    return joinPromptLines([
      "Review this interview question and its options.",
      "Rewrite question so it is easier to understand while preserving original intent.",
      "Review rich options as full structured objects: keep good ones as-is, fix bad ones, add missing ones, and remove bad ones.",
      "Return ONLY JSON in this format:",
      '{"question":"Clearer question text","options":[{"label":"Option A","content":{"source":"Explanation","lang":"md"}}]}',
      "Each option must be object with `label` and optional `content`.",
      "",
      optionalPromptLine("Interview: ", questionsData.title),
      optionalPromptLine("Interview context: ", questionsData.description),
      `Question: ${question.question}`,
      optionalPromptLine("Question context: ", question.context),
      recommended,
      "",
      "Current options JSON:",
      JSON.stringify(question.options ?? [], null, 2),
    ]);
  }

  const existingList = (question.options ?? [])
    .map((option) => `- ${getOptionLabel(option)}`)
    .join("\n");
  return joinPromptLines([
    "Review this interview question and its options.",
    "Rewrite question so it is easier to understand while preserving original intent.",
    "Review options the same way you already would: keep good ones as-is, fix bad ones, add missing ones, and remove bad ones.",
    "Return ONLY JSON in this format:",
    '{"question":"Clearer question text","options":["Option A","Option B","Option C"]}',
    "",
    optionalPromptLine("Interview: ", questionsData.title),
    optionalPromptLine("Interview context: ", questionsData.description),
    `Question: ${question.question}`,
    optionalPromptLine("Question context: ", question.context),
    recommended,
    "",
    "Current options:",
    existingList.length > 0 ? existingList : "(none)",
  ]);
}

function buildAddPrompt(question: Question, usesRichOptions: boolean): string {
  if (usesRichOptions) {
    return joinPromptLines([
      "Generate 3 new, distinct options for this question.",
      "Return ONLY JSON array.",
      "Each item may be short option string or object with `label` and optional `content`.",
      "Use object when new option needs supporting detail or example content.",
      "",
      `Question: ${question.question}`,
      optionalPromptLine("Context: ", question.context),
      "",
      "Existing options JSON (do NOT repeat labels):",
      JSON.stringify(question.options ?? [], null, 2),
      "",
      'Format: ["Option A", {"label":"Option B","content":{"source":"Explanation","lang":"md"}}]',
    ]);
  }

  const existingList = (question.options ?? [])
    .map((option) => `- ${getOptionLabel(option)}`)
    .join("\n");
  return joinPromptLines([
    "Generate 3 new, distinct options for this question.",
    "Return ONLY JSON array of short option strings. No explanation, no markdown.",
    "",
    `Question: ${question.question}`,
    optionalPromptLine("Context: ", question.context),
    "",
    "Existing options (do NOT repeat):",
    existingList.length > 0 ? existingList : "(none)",
    "",
    'Format: ["Option A", "Option B", "Option C"]',
  ]);
}

function getExplicitModel(ctx: GenerateCallbacksContext, modelOverride: string): Model<Api> {
  const slashIndex = modelOverride.indexOf("/");
  if (slashIndex <= 0 || slashIndex === modelOverride.length - 1) {
    throw new Error(`Invalid model override: ${modelOverride}. Use provider/model-id.`);
  }
  const selectedModel = ctx.modelRegistry.find(
    modelOverride.slice(0, slashIndex),
    modelOverride.slice(slashIndex + 1),
  );
  if (selectedModel === undefined) {
    throw new Error(`Model not found: ${modelOverride}`);
  }
  return selectedModel;
}

function buildQuestionPrompt(
  question: Question,
  option: OptionValue,
  prompt: string,
  depth: InsightDepth,
  questionsData: QuestionsFile,
): string {
  const optionText = getOptionLabel(option);
  const optionContent = typeof option === "string" ? undefined : option.content;
  const depthInstructions: Record<InsightDepth, string> = {
    quick: "Keep analysis very brief: one-sentence summary and at most one bullet point.",
    standard: "Be concrete and concise. Short summary and few bullet points.",
    deep: "Provide thorough analysis: detailed summary, multiple bullet points covering tradeoffs, risks, and edge cases.",
  };

  return joinPromptLines([
    "Analyze this single interview answer option.",
    depthInstructions[depth],
    "Explain what is good or risky about option, and suggest rewrite only if it would materially improve clarity.",
    "Return ONLY JSON with summary, bullets, and optional suggestedText.",
    "",
    optionalPromptLine("Interview: ", questionsData.title),
    optionalPromptLine("Interview context: ", questionsData.description),
    `Question: ${question.question}`,
    optionalPromptLine("Question context: ", question.context),
    `Option: ${optionText}`,
    optionalPromptLine("Option content title: ", optionContent?.title),
    optionalPromptLine("Option content file: ", optionContent?.file),
    optionalPromptLine("Option content lines: ", optionContent?.lines),
    optionalPromptLine("Option content language: ", optionContent?.lang),
    isNonEmptyString(optionContent?.source) ? `Option content:\n${optionContent.source}` : null,
    `User request: ${prompt}`,
  ]);
}

async function withFallback<T>(options: {
  primaryModel: Model<Api>;
  fallbackModel: Model<Api> | null;
  signal: AbortSignal;
  run: (model: Model<Api>) => Promise<T>;
}): Promise<T> {
  const { primaryModel, fallbackModel, signal, run } = options;
  try {
    return await run(primaryModel);
  } catch (error) {
    if (fallbackModel === null || signal.aborted) {
      throw error;
    }
    try {
      return await run(fallbackModel);
    } catch (fallbackError) {
      throw createWrappedError(
        `${getErrorMessage(error)}. Fallback failed: ${getErrorMessage(fallbackError)}`,
        toError(fallbackError),
      );
    }
  }
}

function findQuestion(questionsData: QuestionsFile, questionId: string): Question {
  const question = questionsData.questions.find((candidate) => candidate.id === questionId);
  if (question === undefined) {
    throw new Error(`Unknown question: ${questionId}`);
  }
  return question;
}

export function createGenerationCallbacks(options: {
  ctx: GenerateCallbacksContext;
  questionsData: QuestionsFile;
  generateModel: Model<Api> | null;
  fallbackGenerateModel: Model<Api> | null;
}): {
  onGenerate?: (
    questionId: string,
    existingOptions: string[],
    signal: AbortSignal,
    mode: GenerateMode,
  ) => Promise<{ options: OptionValue[]; question?: string }>;
  onOptionInsight?: (
    questionId: string,
    option: OptionValue,
    prompt: string,
    modelOverride: string | null,
    depth: string,
    signal: AbortSignal,
  ) => Promise<OptionInsightResult>;
} {
  const { ctx, questionsData, generateModel, fallbackGenerateModel } = options;
  if (generateModel === null) {
    return {};
  }

  const onGenerate = async (
    questionId: string,
    _existingOptions: string[],
    generateSignal: AbortSignal,
    mode: GenerateMode,
  ): Promise<{ options: OptionValue[]; question?: string }> => {
    const question = findQuestion(questionsData, questionId);
    const usesRichOptions = (question.options ?? []).some((option) => isRichOption(option));
    const prompt =
      mode === "review"
        ? buildReviewPrompt(question, questionsData, usesRichOptions)
        : buildAddPrompt(question, usesRichOptions);

    if (mode === "review") {
      return withFallback({
        primaryModel: generateModel,
        fallbackModel: fallbackGenerateModel,
        signal: generateSignal,
        run: (model) =>
          completeForInterview({
            ctx,
            model,
            prompt,
            signal: generateSignal,
            parse: usesRichOptions ? parseReviewedQuestionUpdate : parseReviewedQuestion,
            systemPrompt: REVIEW_QUESTION_SYSTEM_PROMPT,
          }),
      });
    }

    const generatedOptions = await withFallback({
      primaryModel: generateModel,
      fallbackModel: fallbackGenerateModel,
      signal: generateSignal,
      run: (model) =>
        completeForInterview({
          ctx,
          model,
          prompt,
          signal: generateSignal,
          parse: usesRichOptions ? parseGeneratedOptionValues : parseGeneratedOptions,
        }),
    });
    return { options: generatedOptions };
  };

  const onOptionInsight = (
    questionId: string,
    option: OptionValue,
    prompt: string,
    modelOverride: string | null,
    depth: string,
    generateSignal: AbortSignal,
  ): Promise<OptionInsightResult> => {
    const question = findQuestion(questionsData, questionId);
    const typedDepth: InsightDepth = depth === "quick" || depth === "deep" ? depth : "standard";
    const questionPrompt = buildQuestionPrompt(question, option, prompt, typedDepth, questionsData);

    const runInsight = async (model: Model<Api>): Promise<OptionInsightResult> => {
      const result = await completeForInterview({
        ctx,
        model,
        prompt: questionPrompt,
        signal: generateSignal,
        parse: parseOptionInsight,
        systemPrompt: OPTION_INSIGHT_SYSTEM_PROMPT,
      });
      return {
        ...result,
        modelUsed: `${model.provider}/${model.id}`,
      };
    };

    if (modelOverride !== null && modelOverride.length > 0) {
      return runInsight(getExplicitModel(ctx, modelOverride));
    }

    return withFallback({
      primaryModel: generateModel,
      fallbackModel: fallbackGenerateModel,
      signal: generateSignal,
      run: runInsight,
    });
  };

  return { onGenerate, onOptionInsight };
}
