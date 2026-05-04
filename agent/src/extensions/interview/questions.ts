import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { createWrappedError, getErrorMessage } from "./errors.js";
import { hasStringProperty, isNonEmptyString, isNonNullObject, isStringArray } from "./guards.js";
import { isChoiceResponseValue } from "./responses.js";
import { sanitizeLLMJSON, validateQuestions, type QuestionsFile } from "./schema.js";
import type { ResponseItem, SavedOptionInsight } from "./types.js";

interface SavedFromMeta {
  cwd: string;
  branch: string | null;
  sessionId: string;
}

export interface SavedQuestionsFile extends QuestionsFile {
  savedAnswers?: ResponseItem[];
  savedOptionInsights?: SavedOptionInsight[];
  optionKeysByQuestion?: Record<string, string[]>;
  savedAt?: string;
  wasSubmitted?: boolean;
  savedFrom?: SavedFromMeta;
}

const TitleOnlySchema = Type.Object(
  {
    title: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const SavedFromMetaSchema = Type.Object(
  {
    cwd: Type.String(),
    branch: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sessionId: Type.String(),
  },
  { additionalProperties: true },
);

type SavedFromMetaInput = Static<typeof SavedFromMetaSchema>;

export function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function resolveOptionalPath(value: string | undefined, cwd: string): string | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }
  const expanded = expandHome(value);
  return path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded);
}

function parseUnknownJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function parseInlineJson(text: string): unknown {
  try {
    return parseUnknownJson(text);
  } catch {
    try {
      return parseUnknownJson(sanitizeLLMJSON(text));
    } catch (error) {
      throw createWrappedError(`Invalid inline JSON: ${getErrorMessage(error)}`, error);
    }
  }
}

export function loadQuestions(questionsInput: string, cwd: string): SavedQuestionsFile {
  const trimmed = questionsInput.trimStart();
  const looksLikeInlineJSON =
    trimmed.startsWith("{") || /^`{3,}(?:json|jsonc)?\s*\n?\s*\{/i.test(trimmed);

  if (looksLikeInlineJSON) {
    return validateQuestions(parseInlineJson(trimmed));
  }

  const expanded = expandHome(questionsInput);
  const absolutePath = path.isAbsolute(expanded) ? expanded : path.join(cwd, questionsInput);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Questions file not found: ${absolutePath}`);
  }

  const content = fs.readFileSync(absolutePath, "utf-8");
  if (absolutePath.endsWith(".html") || absolutePath.endsWith(".htm")) {
    return loadSavedInterview(content, absolutePath);
  }

  try {
    return validateQuestions(parseUnknownJson(content));
  } catch (error) {
    throw createWrappedError(`Invalid JSON in questions file: ${getErrorMessage(error)}`, error);
  }
}

function parseInlineTitle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    const parts = trimmed.split(/[\\/]/);
    return parts.at(-1) ?? trimmed;
  }

  try {
    const parsed = parseUnknownJson(trimmed);
    if (!Value.Check(TitleOnlySchema, parsed)) {
      return "inline questions";
    }
    const title = Value.Parse(TitleOnlySchema, parsed).title;
    return isNonEmptyString(title?.trim()) ? title.trim() : "inline questions";
  } catch {
    return "inline questions";
  }
}

export function getInterviewQuestionsLabel(questions: string | undefined): string {
  if (!isNonEmptyString(questions?.trim())) {
    return "interview";
  }
  return parseInlineTitle(questions);
}

function resolveImagePath(filePath: string, baseDir: string): string {
  if (filePath.includes("://") || filePath.startsWith("data:") || filePath.startsWith("file:")) {
    return filePath;
  }
  const expanded = expandHome(filePath);
  return path.isAbsolute(expanded) ? expanded : path.join(baseDir, expanded);
}

function resolvePathValue(value: ResponseItem["value"], baseDir: string): ResponseItem["value"] {
  if (Array.isArray(value)) {
    const stringValues = value.filter((item): item is string => typeof item === "string");
    return stringValues.map((item) => resolveImagePath(item, baseDir));
  }
  return typeof value === "string" && value.length > 0 ? resolveImagePath(value, baseDir) : value;
}

function resolveAnswerPaths(
  answers: ResponseItem[],
  baseDir: string,
  questionTypeById: Map<string, "single" | "multi" | "text" | "image" | "info">,
): ResponseItem[] {
  return answers.map((answer) => {
    const questionType = questionTypeById.get(answer.id);
    return {
      ...answer,
      value: questionType === "image" ? resolvePathValue(answer.value, baseDir) : answer.value,
      attachments: answer.attachments?.map((attachmentPath) =>
        resolveImagePath(attachmentPath, baseDir),
      ),
    };
  });
}

function isSavedOptionInsight(value: unknown): value is SavedOptionInsight {
  return (
    isNonNullObject(value) &&
    isNonEmptyString(typeof value.id === "string" ? value.id : undefined) &&
    isNonEmptyString(typeof value.questionId === "string" ? value.questionId : undefined) &&
    isNonEmptyString(typeof value.optionKey === "string" ? value.optionKey : undefined) &&
    isNonEmptyString(typeof value.optionText === "string" ? value.optionText : undefined) &&
    isNonEmptyString(typeof value.prompt === "string" ? value.prompt : undefined) &&
    isNonEmptyString(typeof value.summary === "string" ? value.summary : undefined)
  );
}

function normalizeSavedOptionInsights(input: unknown): SavedOptionInsight[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const savedOptionInsights = input.filter((item) => isSavedOptionInsight(item));
  return savedOptionInsights.length > 0 ? savedOptionInsights : undefined;
}

function normalizeOptionKeysByQuestion(input: unknown): Record<string, string[]> | undefined {
  if (!isNonNullObject(input)) {
    return undefined;
  }

  const optionKeysByQuestion: Record<string, string[]> = {};
  for (const [questionId, keys] of Object.entries(input)) {
    if (isStringArray(keys)) {
      optionKeysByQuestion[questionId] = [...keys];
    }
  }

  return Object.keys(optionKeysByQuestion).length > 0 ? optionKeysByQuestion : undefined;
}

function normalizeSavedFrom(input: unknown): SavedFromMeta | undefined {
  if (!Value.Check(SavedFromMetaSchema, input)) {
    return undefined;
  }
  const parsed: SavedFromMetaInput = Value.Parse(SavedFromMetaSchema, input);
  return {
    cwd: parsed.cwd,
    branch: parsed.branch ?? null,
    sessionId: parsed.sessionId,
  };
}

function isResponseValue(value: unknown): value is ResponseItem["value"] {
  if (typeof value === "string") {
    return true;
  }
  if (isChoiceResponseValue(value)) {
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  return (
    value.every((item) => typeof item === "string") ||
    value.every((item) => isChoiceResponseValue(item))
  );
}

function normalizeResponseItems(input: unknown): ResponseItem[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const responseItems = input.flatMap((item) => {
    if (!hasStringProperty(item, "id") || !isNonNullObject(item) || !("value" in item)) {
      return [];
    }
    if (!isResponseValue(item.value)) {
      return [];
    }
    const attachmentsValue = getOptionalAttachments(item);

    return [
      {
        id: item.id,
        value: item.value,
        attachments: attachmentsValue,
      } satisfies ResponseItem,
    ];
  });
  return responseItems.length > 0 ? responseItems : undefined;
}

function getOptionalAttachments(value: Record<string, unknown>): string[] | undefined {
  return isStringArray(value.attachments) ? value.attachments : undefined;
}

function extractQuestionsData(data: unknown): unknown {
  if (!isNonNullObject(data)) {
    return data;
  }
  return {
    title: typeof data.title === "string" ? data.title : undefined,
    description: typeof data.description === "string" ? data.description : undefined,
    questions: data.questions,
  };
}

export function loadSavedInterview(html: string, filePath: string): SavedQuestionsFile {
  const match = html.match(/<script[^>]+id=["']pi-interview-data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (match?.[1] === undefined) {
    throw new Error("Invalid saved interview: missing embedded data");
  }

  let data: unknown;
  try {
    data = parseUnknownJson(match[1]);
  } catch (error) {
    throw createWrappedError(
      `Invalid saved interview: malformed JSON (${getErrorMessage(error)})`,
      error,
    );
  }

  const validated = validateQuestions(extractQuestionsData(data));
  const questionTypeById = new Map(
    validated.questions.map((question) => [question.id, question.type]),
  );
  const raw = isNonNullObject(data) ? data : {};
  const snapshotDir = path.dirname(filePath);
  const savedAnswers = normalizeResponseItems(raw.savedAnswers);

  return {
    ...validated,
    savedAnswers:
      savedAnswers === undefined
        ? undefined
        : resolveAnswerPaths(savedAnswers, snapshotDir, questionTypeById),
    savedOptionInsights: normalizeSavedOptionInsights(raw.savedOptionInsights),
    optionKeysByQuestion: normalizeOptionKeysByQuestion(raw.optionKeysByQuestion),
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : undefined,
    wasSubmitted: typeof raw.wasSubmitted === "boolean" ? raw.wasSubmitted : undefined,
    savedFrom: normalizeSavedFrom(raw.savedFrom),
  };
}
