import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { Type } from "typebox";
import { Value } from "typebox/value";

import { getErrorMessage } from "./errors.js";
import { isNonNullObject, isStringArray } from "./guards.js";
import { getOptionLabel, type OptionValue, type Question } from "./schema.js";
import {
  ALLOWED_TYPES,
  BodyTooLargeError,
  getMaxBodySize,
  MAX_IMAGE_SIZE,
} from "./server-assets.js";
import { sendJson, sendText } from "./server-response.js";
import { isChoiceResponseValue } from "./responses.js";
import type { ResponseItem, ResponseValue, SavedOptionInsight } from "./types.js";

const TokenBodySchema = Type.Object(
  {
    token: Type.String(),
  },
  { additionalProperties: true },
);

export function ensureQuestionId(
  id: string,
  questionById: Map<string, Question>,
): { ok: true; question: Question } | { ok: false; error: string } {
  const question = questionById.get(id);
  return question === undefined
    ? { ok: false, error: `Unknown question id: ${id}` }
    : { ok: true, question };
}

export function sendRequestError(
  res: ServerResponse,
  status: number,
  error: string,
  field?: string,
): void {
  sendJson(res, status, field === undefined ? { ok: false, error } : { ok: false, error, field });
}

export function sendJsonResponse(res: ServerResponse, status: number, payload: unknown): void {
  sendJson(res, status, payload);
}

export function sendTextResponse(res: ServerResponse, status: number, text: string): void {
  sendText(res, status, text);
}

export function parseJSONBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > getMaxBodySize()) {
        req.destroy();
        reject(new BodyTooLargeError("Request body too large"));
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(body);
        resolve(parsed);
      } catch (error) {
        reject(new Error(`Invalid JSON: ${getErrorMessage(error)}`));
      }
    });
    req.on("error", reject);
  });
}

export function validateTokenQuery(url: URL, expectedToken: string, res: ServerResponse): boolean {
  const token = url.searchParams.get("session");
  if (token !== expectedToken) {
    sendText(res, 403, "Invalid session");
    return false;
  }
  return true;
}

export function validateTokenBody(
  body: unknown,
  expectedToken: string,
  res: ServerResponse,
): boolean {
  if (!Value.Check(TokenBodySchema, body)) {
    sendJson(res, 400, { ok: false, error: "Invalid request body" });
    return false;
  }
  const payload = Value.Parse(TokenBodySchema, body);
  if (payload.token !== expectedToken) {
    sendJson(res, 403, { ok: false, error: "Invalid session" });
    return false;
  }
  return true;
}

export async function handleImageUpload(
  image: { id: string; filename: string; mimeType: string; data: string },
  sessionId: string,
  targetDir?: string,
): Promise<string> {
  if (!ALLOWED_TYPES.includes(image.mimeType)) {
    throw new Error(`Invalid image type: ${image.mimeType}`);
  }
  const buffer = Buffer.from(image.data, "base64");
  if (buffer.length > MAX_IMAGE_SIZE) {
    throw new Error("Image exceeds 5MB limit");
  }
  const sanitizedName = image.filename.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  const fileBasename = basename(sanitizedName) || `image_${randomUUID()}`;
  const extMap: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
  };
  const filename = fileBasename.includes(".")
    ? fileBasename
    : `${fileBasename}${extMap[image.mimeType] ?? ""}`;
  const dir = targetDir ?? join(tmpdir(), `pi-interview-${sessionId}`);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, filename);
  await writeFile(filePath, buffer);
  return filePath;
}

function normalizeChoiceResponseValue(value: unknown): { option: string; note?: string } | null {
  if (!isChoiceResponseValue(value)) {
    return null;
  }
  const option = value.option.trim();
  if (option.length === 0) {
    return null;
  }
  const note = typeof value.note === "string" ? value.note.trim() : "";
  return note.length > 0 ? { option, note } : { option };
}

export function cloneResponseValue(value: ResponseValue): ResponseValue {
  if (Array.isArray(value)) {
    return value.every((item) => isChoiceResponseValue(item))
      ? value.map((item) => ({ ...item }))
      : value.filter((item): item is string => typeof item === "string");
  }
  return isChoiceResponseValue(value) ? { ...value } : value;
}

function normalizeResponseItem(
  question: Question,
  item: Record<string, unknown>,
): { ok: true; response: ResponseItem } | { ok: false; error: string } {
  const response: ResponseItem = { id: question.id, value: "" };
  const value = item.value;

  if (question.type === "image") {
    if (isStringArray(value)) {
      response.value = value;
    }
  } else if (question.type === "single") {
    if (value !== "") {
      const normalized = normalizeChoiceResponseValue(value);
      if (normalized === null) {
        return { ok: false, error: `Invalid response value for ${question.id}` };
      }
      response.value = normalized;
    }
  } else if (question.type === "multi") {
    if (!Array.isArray(value)) {
      return { ok: false, error: `Invalid response value for ${question.id}` };
    }
    const normalizedValues: Array<{ option: string; note?: string }> = [];
    for (const itemValue of value) {
      const normalized = normalizeChoiceResponseValue(itemValue);
      if (normalized === null) {
        return { ok: false, error: `Invalid response value for ${question.id}` };
      }
      normalizedValues.push(normalized);
    }
    response.value = normalizedValues;
  } else {
    if (typeof value !== "string") {
      return { ok: false, error: `Invalid response value for ${question.id}` };
    }
    response.value = value;
  }

  const attachments = item.attachments;
  if (isStringArray(attachments)) {
    response.attachments = attachments;
  }
  return { ok: true, response };
}

export function normalizeResponseItems(
  responsesInput: unknown[],
  questionById: Map<string, Question>,
): { ok: true; responses: ResponseItem[] } | { ok: false; field?: string; error: string } {
  const responses: ResponseItem[] = [];
  for (const item of responsesInput) {
    if (!isNonNullObject(item) || typeof item.id !== "string") {
      continue;
    }
    const questionCheck = ensureQuestionId(item.id, questionById);
    if (!questionCheck.ok) {
      return { ok: false, error: questionCheck.error, field: item.id };
    }
    const normalized = normalizeResponseItem(questionCheck.question, item);
    if (!normalized.ok) {
      return { ok: false, error: normalized.error, field: item.id };
    }
    responses.push(normalized.response);
  }
  return { ok: true, responses };
}

function normalizeRecommendationMatchText(value: string): string {
  return value.normalize("NFC").trim();
}

export function resolveRecommendedLabels(
  recommended: Question["recommended"],
  options: OptionValue[],
): string[] {
  if (recommended === undefined) {
    return [];
  }
  const labelsByNormalized = new Map<string, string>();
  for (const label of options.map((option) => getOptionLabel(option))) {
    const normalized = normalizeRecommendationMatchText(label);
    if (normalized.length > 0 && !labelsByNormalized.has(normalized)) {
      labelsByNormalized.set(normalized, label);
    }
  }

  const resolved: string[] = [];
  for (const candidate of Array.isArray(recommended) ? recommended : [recommended]) {
    const match = labelsByNormalized.get(normalizeRecommendationMatchText(candidate));
    if (match !== undefined && !resolved.includes(match)) {
      resolved.push(match);
    }
  }
  return resolved;
}

export function syncRecommendations(question: Question, options: OptionValue[]): void {
  if (question.recommended === undefined) {
    return;
  }
  const resolvedRecommended = resolveRecommendedLabels(question.recommended, options);
  if (question.type === "single") {
    if (resolvedRecommended.length > 0) {
      question.recommended = resolvedRecommended[0];
    } else {
      delete question.recommended;
      delete question.conviction;
    }
    return;
  }
  if (question.type !== "multi") {
    delete question.recommended;
    delete question.conviction;
    return;
  }
  if (resolvedRecommended.length === 0) {
    delete question.recommended;
    delete question.conviction;
    return;
  }
  question.recommended = resolvedRecommended;
}

export function createOptionKey(): string {
  return `opt-${randomUUID()}`;
}

export function buildOptionKeysByQuestion(
  questionsList: Question[],
  initial: Record<string, string[]> | undefined,
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const question of questionsList) {
    if (
      (question.type === "single" || question.type === "multi") &&
      question.options !== undefined
    ) {
      const existing = initial?.[question.id];
      if (
        Array.isArray(existing) &&
        existing.length === question.options.length &&
        existing.every((key) => typeof key === "string" && key.trim().length > 0)
      ) {
        next[question.id] = [...existing];
      } else {
        next[question.id] = question.options.map(() => createOptionKey());
      }
    }
  }
  return next;
}

export function getOptionIndexByKey(
  question: Question,
  optionKeysByQuestion: Record<string, string[]>,
  optionKey: string,
): number {
  if ((question.type !== "single" && question.type !== "multi") || question.options === undefined) {
    return -1;
  }
  return (optionKeysByQuestion[question.id] ?? []).indexOf(optionKey);
}

function setOptionLabel(option: OptionValue, label: string): OptionValue {
  return typeof option === "string" ? label : { ...option, label };
}

export function normalizeGeneratedOptionValues(options: OptionValue[]): OptionValue[] {
  const uniqueOptions: OptionValue[] = [];
  const indexByLabel = new Map<string, number>();
  for (const option of options) {
    const label = getOptionLabel(option).trim();
    if (label.length === 0) {
      continue;
    }
    const normalizedOption = setOptionLabel(option, label);
    const existingIndex = indexByLabel.get(label.toLowerCase());
    if (existingIndex === undefined) {
      indexByLabel.set(label.toLowerCase(), uniqueOptions.length);
      uniqueOptions.push(normalizedOption);
    } else if (
      typeof uniqueOptions[existingIndex] === "string" &&
      typeof normalizedOption !== "string"
    ) {
      uniqueOptions[existingIndex] = normalizedOption;
    }
  }
  return uniqueOptions;
}

export function reconcileOptionKeysByLabel(
  previousOptions: OptionValue[],
  previousKeys: string[],
  nextOptions: OptionValue[],
): string[] {
  const keysByLabel = new Map<string, string[]>();
  for (const [index, option] of previousOptions.entries()) {
    const key = previousKeys[index];
    if (key === undefined) {
      continue;
    }
    const label = getOptionLabel(option).trim();
    const existing = keysByLabel.get(label);
    if (existing === undefined) {
      keysByLabel.set(label, [key]);
    } else {
      existing.push(key);
    }
  }

  return nextOptions.map((option) => {
    const matchingKeys = keysByLabel.get(getOptionLabel(option).trim());
    if (matchingKeys === undefined || matchingKeys.length === 0) {
      return createOptionKey();
    }
    return matchingKeys.shift() ?? createOptionKey();
  });
}

export function normalizeSavedOptionInsights(input: unknown): SavedOptionInsight[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const normalized: SavedOptionInsight[] = [];
  for (const item of input) {
    if (!isNonNullObject(item)) {
      continue;
    }
    if (
      typeof item.id !== "string" ||
      typeof item.questionId !== "string" ||
      typeof item.optionKey !== "string" ||
      typeof item.optionText !== "string" ||
      typeof item.prompt !== "string" ||
      typeof item.summary !== "string"
    ) {
      continue;
    }
    const bullets = Array.isArray(item.bullets)
      ? item.bullets.filter(
          (bullet): bullet is string => typeof bullet === "string" && bullet.trim().length > 0,
        )
      : undefined;
    let modelUsed: string | null | undefined;
    if (typeof item.modelUsed === "string") {
      modelUsed = item.modelUsed;
    } else if (item.modelUsed === null) {
      modelUsed = null;
    }
    normalized.push({
      id: item.id,
      questionId: item.questionId,
      optionKey: item.optionKey,
      optionText: item.optionText,
      prompt: item.prompt,
      summary: item.summary,
      bullets: bullets !== undefined && bullets.length > 0 ? bullets : undefined,
      suggestedText: typeof item.suggestedText === "string" ? item.suggestedText : undefined,
      modelUsed,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
    });
  }
  return normalized;
}

export type ParseBodyOrRespond = (req: IncomingMessage, res: ServerResponse) => Promise<unknown>;

export function createBodyParser(): ParseBodyOrRespond {
  return async (req, res) => {
    try {
      return await parseJSONBody(req);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendJson(res, error.statusCode, { ok: false, error: error.message });
      } else {
        sendJson(res, 400, { ok: false, error: getErrorMessage(error) });
      }
      return null;
    }
  };
}
