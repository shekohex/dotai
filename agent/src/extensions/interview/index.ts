/* oxlint-disable */
import { Type } from "typebox";
import {
  StringEnum,
  complete,
  type Api,
  type AssistantMessage,
  type Model,
} from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { createTextComponent, formatToolRail, getTextContent } from "../coreui/tools.js";
import {
  startInterviewServer,
  getActiveSessions,
  type ChoiceResponseValue,
  type ResponseItem,
  type InterviewServerCallbacks,
  type SavedOptionInsight,
  type AskModelOption,
  type OptionInsightResult,
} from "./server.js";
import {
  getOptionLabel,
  isRichOption,
  validateQuestions,
  sanitizeLLMJSON,
  type OptionValue,
  type Question,
  type QuestionsFile,
} from "./schema.js";
import { openBrowserTarget } from "../executor/browser.js";
import { defaultInterviewSettings, loadSettings, type InterviewThemeSettings } from "./settings.js";

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}

function toTerminalHyperlink(url: string, label?: string): string {
  const text = label ?? url;
  return `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`;
}

function getInterviewLinkLines(
  url: string,
  theme: {
    fg: (color: "accent" | "dim", text: string) => string;
    underline: (text: string) => string;
  },
): string[] {
  return [
    theme.fg("accent", url),
    theme.fg("dim", toTerminalHyperlink(url, theme.underline("open"))),
  ];
}

function shouldAutoOpenBrowser(): boolean {
  return !process.env.SSH_CONNECTION && !process.env.SSH_CLIENT && !process.env.SSH_TTY;
}

interface InterviewDetails {
  status: "completed" | "cancelled" | "timeout" | "aborted" | "queued";
  responses: ResponseItem[];
  url: string;
  queuedMessage?: string;
  progressMessage?: string;
  title?: string;
  totalQuestions?: number;
  answeredItems?: AgentResponseItem[];
}

function getInterviewQuestionsLabel(questions: string | undefined): string {
  if (questions === undefined || questions.trim().length === 0) {
    return "interview";
  }

  const trimmed = questions.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { title?: unknown };
      if (typeof parsed.title === "string" && parsed.title.trim().length > 0) {
        return parsed.title.trim();
      }
    } catch {}
    return "inline questions";
  }

  const parts = trimmed.split(/[\\/]/);
  return parts.at(-1) ?? trimmed;
}

function getInterviewStatus(details: InterviewDetails): {
  label: string;
  color: "success" | "warning" | "error";
} {
  switch (details.status) {
    case "completed": {
      return { label: "interviewed", color: "success" };
    }
    case "cancelled": {
      return { label: "cancelled", color: "error" };
    }
    case "timeout": {
      return { label: "timed out", color: "warning" };
    }
    case "queued": {
      return { label: "queued", color: "warning" };
    }
    default: {
      return { label: "aborted", color: "error" };
    }
  }
}

// Types for saved interviews
interface SavedFromMeta {
  cwd: string;
  branch: string | null;
  sessionId: string;
}

interface SavedQuestionsFile extends QuestionsFile {
  savedAnswers?: ResponseItem[];
  savedOptionInsights?: SavedOptionInsight[];
  optionKeysByQuestion?: Record<string, string[]>;
  savedAt?: string;
  wasSubmitted?: boolean;
  savedFrom?: SavedFromMeta;
}

const InterviewParams = Type.Object({
  questions: Type.String({
    description:
      "Inline JSON string with questions, or path to a questions JSON / saved interview HTML file",
  }),
  timeout: Type.Optional(Type.Number({ description: "Seconds before auto-timeout", default: 600 })),
  verbose: Type.Optional(Type.Boolean({ description: "Enable debug logging", default: false })),
  theme: Type.Optional(
    Type.Object(
      {
        mode: Type.Optional(StringEnum(["auto", "light", "dark"])),
        name: Type.Optional(Type.String()),
        lightPath: Type.Optional(Type.String()),
        darkPath: Type.Optional(Type.String()),
        toggleHotkey: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
  ),
});

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  // Handle both Unix (/) and Windows (\) separators for user convenience
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function resolveOptionalPath(value: string | undefined, cwd: string): string | undefined {
  if (!value) return undefined;
  const expanded = expandHome(value);
  return path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded);
}

const DEFAULT_THEME_HOTKEY = "mod+shift+l";

function mergeThemeConfig(
  base: InterviewThemeSettings | undefined,
  override: InterviewThemeSettings | undefined,
  cwd: string,
): InterviewThemeSettings {
  const merged: InterviewThemeSettings = { ...(base ?? {}), ...(override ?? {}) };
  return {
    ...merged,
    toggleHotkey: merged.toggleHotkey ?? DEFAULT_THEME_HOTKEY,
    lightPath: resolveOptionalPath(merged.lightPath, cwd),
    darkPath: resolveOptionalPath(merged.darkPath, cwd),
  };
}

function loadQuestions(questionsInput: string, cwd: string): SavedQuestionsFile {
  const trimmed = questionsInput.trimStart();
  const looksLikeInlineJSON =
    trimmed.startsWith("{") || /^`{3,}(?:json|jsonc)?\s*\n?\s*\{/i.test(trimmed);

  if (looksLikeInlineJSON) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      try {
        data = JSON.parse(sanitizeLLMJSON(trimmed));
      } catch (repairErr) {
        const message = repairErr instanceof Error ? repairErr.message : String(repairErr);
        throw new Error(`Invalid inline JSON: ${message}`);
      }
    }
    return validateQuestions(data);
  }

  const expanded = expandHome(questionsInput);
  const absolutePath = path.isAbsolute(expanded) ? expanded : path.join(cwd, questionsInput);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Questions file not found: ${absolutePath}`);
  }

  const content = fs.readFileSync(absolutePath, "utf-8");

  // Handle HTML files (saved interviews)
  if (absolutePath.endsWith(".html") || absolutePath.endsWith(".htm")) {
    return loadSavedInterview(content, absolutePath);
  }

  // Original JSON handling
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in questions file: ${message}`);
  }

  return validateQuestions(data);
}

interface GenerateModelCandidate {
  provider: string;
  id: string;
}

const PREFERRED_GENERATE_MODELS = ["openai/gpt-5.4-mini", "google/gemini-2.5-flash"];

const GENERATE_OPTIONS_SYSTEM_PROMPT =
  "You generate interview answer options. Return only a JSON array of strings. Do not include explanations or markdown.";

const REVIEW_QUESTION_SYSTEM_PROMPT =
  "You review interview questions and answer options. Preserve intent. Return only JSON with a rewritten question string and an options array.";

const OPTION_INSIGHT_SYSTEM_PROMPT =
  'You analyze a single interview answer option. Return only JSON with this shape: {"summary":"...","bullets":["..."],"suggestedText":"..."}. Keep summary concise, bullets short, and omit suggestedText when no rewrite is needed.';

function formatModelRef(model: GenerateModelCandidate): string {
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
    if (!currentModel || formatModelRef(currentModel) === formatModelRef(configuredModel)) {
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
  const addModel = (model: Model<Api> | null) => {
    if (!model) return;
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
    const preferredModel = findModelByRef(availableModels, modelRef);
    addModel(preferredModel);
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
    throw new Error(
      response.errorMessage ? `${modelRef}: ${response.errorMessage}` : `${modelRef} failed`,
    );
  }

  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  if (!text) {
    throw new Error(`${modelRef} returned no text response`);
  }
  return text;
}

function extractJSONBlock(text: string, openChar: "[" | "{", closeChar: "]" | "}"): string {
  const start = text.indexOf(openChar);
  if (start === -1) return text;

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === openChar) {
      depth++;
      continue;
    }
    if (char !== closeChar) {
      continue;
    }

    depth--;
    if (depth === 0) {
      return text.slice(start, i + 1);
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

function normalizeGeneratedOptions(parsed: unknown): string[] {
  if (!Array.isArray(parsed)) {
    throw new Error("Expected array of options");
  }

  const options = parsed
    .filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0)
    .map((option: string) => option.trim());
  if (options.length === 0) {
    throw new Error("No valid options generated");
  }
  return options;
}

function normalizeGeneratedOptionValues(parsed: unknown): OptionValue[] {
  if (!Array.isArray(parsed)) {
    throw new Error("Expected array of options");
  }

  const normalizedInput = parsed
    .map((option) => {
      if (typeof option === "string") {
        return option.trim();
      }
      if (!option || typeof option !== "object") {
        return option;
      }
      const raw = option as Record<string, unknown>;
      return {
        ...raw,
        label: typeof raw.label === "string" ? raw.label.trim() : raw.label,
      };
    })
    .filter((option) => {
      if (typeof option === "string") {
        return option.length > 0;
      }
      if (!option || typeof option !== "object") {
        return true;
      }
      const label = (option as Record<string, unknown>).label;
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
  if (!options || options.length === 0) {
    throw new Error("No valid options generated");
  }
  return options;
}

export function parseGeneratedOptions(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJSONArray(text));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse generated options: ${detail}`);
  }
  return normalizeGeneratedOptions(parsed);
}

export function parseGeneratedOptionValues(text: string): OptionValue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJSONArray(text));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse generated options: ${detail}`);
  }
  return normalizeGeneratedOptionValues(parsed);
}

export function parseReviewedQuestion(text: string): { question: string; options: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJSONObject(text));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse reviewed question: ${detail}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Expected reviewed question object");
  }

  const review = parsed as Record<string, unknown>;
  if (typeof review.question !== "string" || !review.question.trim()) {
    throw new Error("Reviewed question must include a non-empty question string");
  }

  return {
    question: review.question.trim(),
    options: normalizeGeneratedOptions(review.options),
  };
}

export function parseReviewedQuestionUpdate(text: string): {
  question: string;
  options: OptionValue[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJSONObject(text));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse reviewed question: ${detail}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Expected reviewed question object");
  }

  const review = parsed as Record<string, unknown>;
  if (typeof review.question !== "string" || !review.question.trim()) {
    throw new Error("Reviewed question must include a non-empty question string");
  }

  const options = normalizeGeneratedOptionValues(review.options);
  if (options.some((option) => !isRichOption(option))) {
    throw new Error("Reviewed rich options must all be objects with label");
  }

  return {
    question: review.question.trim(),
    options,
  };
}

export function parseOptionInsight(text: string): OptionInsightResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJSONObject(text));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse option insight: ${detail}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Expected option insight object");
  }

  const insight = parsed as Record<string, unknown>;
  if (typeof insight.summary !== "string" || !insight.summary.trim()) {
    throw new Error("Option insight must include a non-empty summary string");
  }
  const bullets = Array.isArray(insight.bullets)
    ? insight.bullets
        .filter(
          (bullet): bullet is string => typeof bullet === "string" && bullet.trim().length > 0,
        )
        .map((bullet) => bullet.trim())
    : [];

  return {
    summary: insight.summary.trim(),
    bullets: bullets.length > 0 ? bullets : undefined,
    suggestedText:
      typeof insight.suggestedText === "string" && insight.suggestedText.trim().length > 0
        ? insight.suggestedText.trim()
        : undefined,
  };
}

export function loadSavedInterview(html: string, filePath: string): SavedQuestionsFile {
  // Extract JSON from <script id="pi-interview-data">
  const match = html.match(/<script[^>]+id=["']pi-interview-data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) {
    throw new Error("Invalid saved interview: missing embedded data");
  }

  let data: unknown;
  try {
    data = JSON.parse(match[1]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid saved interview: malformed JSON (${message})`);
  }

  const raw = data as Record<string, unknown>;
  const validated = validateQuestions(data);
  const questionTypeById = new Map(
    validated.questions.map((question) => [question.id, question.type]),
  );

  // Resolve relative image paths to absolute based on HTML file location.
  // Only image-question values are treated as paths; text/single/multi values must stay literal.
  const snapshotDir = path.dirname(filePath);
  const savedAnswers = Array.isArray(raw.savedAnswers)
    ? resolveAnswerPaths(raw.savedAnswers as ResponseItem[], snapshotDir, questionTypeById)
    : undefined;
  const savedOptionInsights = Array.isArray(raw.savedOptionInsights)
    ? (raw.savedOptionInsights as SavedOptionInsight[]).filter(
        (item) =>
          item &&
          typeof item.id === "string" &&
          typeof item.questionId === "string" &&
          typeof item.optionKey === "string" &&
          typeof item.optionText === "string" &&
          typeof item.prompt === "string" &&
          typeof item.summary === "string",
      )
    : undefined;
  const optionKeysByQuestion =
    raw.optionKeysByQuestion && typeof raw.optionKeysByQuestion === "object"
      ? Object.fromEntries(
          Object.entries(raw.optionKeysByQuestion as Record<string, unknown>)
            .filter(
              ([, value]) => Array.isArray(value) && value.every((key) => typeof key === "string"),
            )
            .map(([questionId, value]) => [questionId, [...(value as string[])]]),
        )
      : undefined;

  // Validate savedFrom if present
  let savedFrom: SavedFromMeta | undefined;
  if (raw.savedFrom && typeof raw.savedFrom === "object") {
    const sf = raw.savedFrom as Record<string, unknown>;
    if (typeof sf.cwd === "string" && typeof sf.sessionId === "string") {
      savedFrom = {
        cwd: sf.cwd,
        branch: typeof sf.branch === "string" ? sf.branch : null,
        sessionId: sf.sessionId,
      };
    }
  }

  // Return validated questions plus saved interview metadata
  return {
    ...validated,
    savedAnswers,
    savedOptionInsights,
    optionKeysByQuestion,
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : undefined,
    wasSubmitted: typeof raw.wasSubmitted === "boolean" ? raw.wasSubmitted : undefined,
    savedFrom,
  };
}

function resolveAnswerPaths(
  answers: ResponseItem[],
  baseDir: string,
  questionTypeById: Map<string, "single" | "multi" | "text" | "image" | "info">,
): ResponseItem[] {
  return answers.map((ans) => {
    const questionType = questionTypeById.get(ans.id);
    return {
      ...ans,
      value: questionType === "image" ? resolvePathValue(ans.value, baseDir) : ans.value,
      attachments: ans.attachments?.map((attachmentPath) =>
        resolveImagePath(attachmentPath, baseDir),
      ),
    };
  });
}

function resolveImagePath(p: string, baseDir: string): string {
  if (!p) return p;
  // Skip URLs and data/file URIs
  if (p.includes("://") || p.startsWith("data:") || p.startsWith("file:")) return p;
  const expanded = expandHome(p);
  if (path.isAbsolute(expanded)) return expanded;
  return path.join(baseDir, expanded);
}

function resolvePathValue(value: ResponseItem["value"], baseDir: string): ResponseItem["value"] {
  if (Array.isArray(value)) {
    const stringValues = value.filter((item): item is string => typeof item === "string");
    return stringValues.map((item) => resolveImagePath(item, baseDir));
  }
  return typeof value === "string" && value ? resolveImagePath(value, baseDir) : value;
}

function isChoiceResponseValue(value: unknown): value is ChoiceResponseValue {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as ChoiceResponseValue).option === "string"
  );
}

function formatResponseValue(value: ResponseItem["value"]): string {
  if (Array.isArray(value)) {
    if (value.every(isChoiceResponseValue)) {
      return value
        .map((item) => (item.note ? `${item.option} (${item.note})` : item.option))
        .join(", ");
    }
    return value.join(", ");
  }
  if (isChoiceResponseValue(value)) {
    return value.note ? `${value.option} (${value.note})` : value.option;
  }
  return value;
}

function hasAnswerValue(value: ResponseItem["value"]): boolean {
  if (Array.isArray(value)) {
    if (value.every(isChoiceResponseValue)) {
      return value.some((item) => item.option.trim() !== "");
    }
    return value.some((item) => typeof item === "string" && item.trim() !== "");
  }
  if (isChoiceResponseValue(value)) {
    return value.option.trim() !== "";
  }
  return typeof value === "string" && value.trim() !== "";
}

function hasResponseContent(response: ResponseItem): boolean {
  return hasAnswerValue(response.value) || !!response.attachments?.length;
}

function summarizeResponseValue(question: Question, response: ResponseItem): string {
  if (question.type === "image") {
    if (Array.isArray(response.value)) {
      return response.value.length === 1
        ? "1 image attached"
        : `${response.value.length} images attached`;
    }
    if (typeof response.value === "string" && response.value.trim() !== "") {
      return "1 image attached";
    }
  }

  if (hasAnswerValue(response.value)) {
    return String(formatResponseValue(response.value));
  }

  if (response.attachments?.length) {
    return response.attachments.length === 1
      ? "1 attachment included"
      : `${response.attachments.length} attachments included`;
  }

  return "";
}

interface AgentResponseItem {
  id: string;
  question: string;
  type: Question["type"];
  value: ResponseItem["value"];
  attachments?: string[];
}

export function buildAnsweredAgentResponseItems(
  responses: ResponseItem[],
  questions: Question[],
): AgentResponseItem[] {
  const responseById = new Map<string, ResponseItem>();
  for (const response of responses) {
    if (!response || typeof response.id !== "string") continue;
    responseById.set(response.id, response);
  }

  return questions
    .map((question) => {
      const response = responseById.get(question.id);
      if (!response || !hasResponseContent(response)) return null;
      return {
        id: question.id,
        question: question.question,
        type: question.type,
        value: response.value,
        attachments: response.attachments?.length ? [...response.attachments] : undefined,
      } satisfies AgentResponseItem;
    })
    .filter((item) => item !== null);
}

function hasQueuedMessages(ctx: object): boolean {
  const value = Reflect.get(ctx, "hasQueuedMessages");
  if (typeof value !== "function") {
    return false;
  }
  const result = value.call(ctx);
  return result === true;
}

export function formatAnsweredResponsesForAgent(
  responses: ResponseItem[],
  questions: Question[],
): string {
  const answeredItems = buildAnsweredAgentResponseItems(responses, questions);
  if (answeredItems.length === 0) return "(none)";
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const responseById = new Map(responses.map((response) => [response.id, response]));

  const summary = answeredItems
    .map((item) => {
      const question = questionById.get(item.id);
      const response = responseById.get(item.id);
      if (!question || !response) {
        return `- ${item.question}`;
      }
      let line = `- ${item.question}: ${summarizeResponseValue(question, response)}`;
      if (item.attachments?.length) {
        line += ` [attachments: ${item.attachments.join(", ")}]`;
      }
      return line;
    })
    .join("\n");

  const json = JSON.stringify(answeredItems, null, 2);
  return `${summary}\n\nStructured response data:\n\n\`\`\`json\n${json}\n\`\`\``;
}

function hasAnyAnswers(responses: ResponseItem[]): boolean {
  if (!responses || responses.length === 0) return false;
  return responses.some((resp) => !!resp && hasResponseContent(resp));
}

function filterAnsweredResponses(responses: ResponseItem[]): ResponseItem[] {
  if (!responses) return [];
  return responses.filter((resp) => !!resp && hasResponseContent(resp));
}

function formatInterviewProgressMessage(responses: ResponseItem[], questions: Question[]): string {
  const answered = buildAnsweredAgentResponseItems(responses, questions);
  if (answered.length === 0) {
    return "waiting for answers";
  }
  return `${answered.length} answered`;
}

function getInterviewQuestionCount(questions: Question[]): number {
  return questions.filter((question) => question.type !== "info").length;
}

function formatInterviewCountSummary(answeredCount: number, totalQuestions: number): string {
  return `${answeredCount}/${totalQuestions} ${answeredCount === 1 ? "response" : "responses"}`;
}

function formatInterviewExpandedDetails(
  details: InterviewDetails,
  theme: { fg: (color: "muted" | "dim", text: string) => string },
  rail: string,
): string {
  const answeredItems = details.answeredItems ?? [];
  if (answeredItems.length === 0) {
    return `${rail}${theme.fg("dim", "No answers yet")}`;
  }

  return answeredItems
    .map((item) => {
      const value = summarizeInterviewAnswerValue(item.value);
      const attachments =
        item.attachments && item.attachments.length > 0
          ? ` ${theme.fg("dim", `[${item.attachments.length} attachment${item.attachments.length === 1 ? "" : "s"}]`)}`
          : "";
      return `${rail}${theme.fg("muted", item.question)}\n${rail}${theme.fg("dim", value)}${attachments}`;
    })
    .join("\n");
}

function summarizeInterviewAnswerValue(value: ResponseItem["value"]): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : "(empty)";
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "(none)";
    }

    return value
      .map((item) =>
        typeof item === "string" ? item : item.option + (item.note ? `: ${item.note}` : ""),
      )
      .join(", ");
  }

  return value.note ? `${value.option}: ${value.note}` : value.option;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "interview",
    label: "Interview",
    renderShell: "self",
    description:
      "Present an interactive form to gather user responses. " +
      "Runs in browser and returns structured responses to agent. " +
      "Use proactively when: choosing between multiple approaches, gathering requirements before implementation, " +
      "exploring design tradeoffs, or when decisions have multiple dimensions worth discussing. " +
      "Provides better UX than back-and-forth chat for structured input. " +
      "Image responses and attachments are returned as file paths - use read tool directly to display them. " +
      "Pass questions as inline JSON string directly (preferred) or as a path to a JSON file. " +
      'Questions JSON format: { "title": "...", "description": "...", "questions": [{ "id": "q1", "type": "single|multi|text|image|info", "question": "...", "options": ["A", "B"], "content": { "source": "...", "lang": "ts" }, "media": { "type": "image|chart|mermaid|table|html", ... } }] }. ' +
      "Options can be strings or objects: { label: string, content?: { source, lang?, file?, lines?, highlights?, title?, showSource? } }. " +
      "Always set recommended with context explaining your reasoning. Recommended options show a 'Recommended' badge and are pre-selected for the user. " +
      'Use conviction: "slight" when unsure (does NOT pre-select), conviction: "strong" when very confident (shows Recommended badge). ' +
      "Omit conviction for normal recommendations (pre-selects). " +
      'Use weight: "critical" for key decisions (visually prominent), weight: "minor" for low-stakes questions (compact card). ' +
      "When questions have recommendations, set description to guide review (e.g., 'Review my suggestions and adjust as needed'). " +
      'Questions can have a content field to display code or markdown above options. lang: "md" or "markdown" defaults to markdown preview unless showSource is true. Types: single (radio), multi (checkbox), text (textarea), image (file upload), info (non-interactive). ' +
      'Media blocks: { type: "image", src, alt, caption }, { type: "table", table: { headers, rows, highlights }, caption }, { type: "chart", chart: { type, data, options }, caption }, { type: "mermaid", mermaid: "graph LR\\n..." }, { type: "html", html }. ' +
      "Info type is a non-interactive content panel for displaying context with media. Media position: above (default), below, side (two-column).",
    promptSnippet:
      "Gather structured user input through an interactive form for requirements, tradeoffs, or multi-dimensional decisions.",
    parameters: InterviewParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const { questions, timeout, verbose, theme } = params as {
        questions: string;
        timeout?: number;
        verbose?: boolean;
        theme?: InterviewThemeSettings;
      };

      if (!ctx.hasUI) {
        throw new Error(
          "Interview tool requires interactive mode. " + "Cannot run in headless/RPC/print mode.",
        );
      }

      if (hasQueuedMessages(ctx)) {
        return {
          content: [{ type: "text", text: "Interview skipped - user has queued input." }],
          details: { status: "cancelled", url: "", responses: [] },
        };
      }

      const loadedSettings = loadSettings();
      const settings = {
        ...defaultInterviewSettings,
        ...loadedSettings,
        theme: { ...defaultInterviewSettings.theme, ...(loadedSettings.theme ?? {}) },
      };
      const timeoutSeconds = timeout ?? settings.timeout ?? defaultInterviewSettings.timeout;
      const themeConfig = mergeThemeConfig(settings.theme, theme, ctx.cwd);
      const questionsData = loadQuestions(questions, ctx.cwd);

      let configuredGenerateModel: Model<Api> | null = null;
      if (settings.generateModel) {
        const slashIdx = settings.generateModel.indexOf("/");
        if (slashIdx > 0) {
          configuredGenerateModel =
            ctx.modelRegistry.find(
              settings.generateModel.slice(0, slashIdx),
              settings.generateModel.slice(slashIdx + 1),
            ) ?? null;
        }
      }

      let availableGenerateModels: Model<Api>[] = [];
      try {
        availableGenerateModels = ctx.modelRegistry.getAvailable();
      } catch {
        // Leave generation disabled when model discovery is unavailable.
      }

      const { primary: generateModel, fallback: fallbackGenerateModel } = selectGenerateModels(
        configuredGenerateModel,
        ctx.model ?? null,
        availableGenerateModels,
      );
      const askModels = buildAskModelsData(
        availableGenerateModels,
        ctx.model ?? null,
        generateModel,
        fallbackGenerateModel,
      );
      const defaultAskModel = generateModel ? formatModelRef(generateModel) : null;

      // Expand ~ in snapshotDir if present
      const snapshotDir = settings.snapshotDir ? expandHome(settings.snapshotDir) : undefined;

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Interview was aborted." }],
          details: { status: "aborted", url: "", responses: [] },
        };
      }

      const sessionId = randomUUID();
      const sessionToken = randomUUID();
      let server: { close: () => void } | null = null;
      let resolved = false;
      let url = "";
      const cleanup = () => {
        if (server) {
          server.close();
          server = null;
        }
      };

      return new Promise((resolve, reject) => {
        const interviewTitle = questionsData.title || "Interview";
        const totalQuestions = getInterviewQuestionCount(questionsData.questions);
        const finish = (
          status: InterviewDetails["status"],
          responses: ResponseItem[] = [],
          cancelReason?: "timeout" | "user" | "stale",
        ) => {
          if (resolved) return;
          resolved = true;
          cleanup();

          let text = "";
          if (status === "completed") {
            text = `User completed the interview form.\n\nAnswered responses:\n${formatAnsweredResponsesForAgent(responses, questionsData.questions)}`;
          } else if (status === "cancelled") {
            if (cancelReason === "stale") {
              text =
                "Interview session ended due to lost heartbeat.\n\nQuestions saved to: ~/.pi/interview-recovery/";
            } else if (hasAnyAnswers(responses)) {
              const answered = filterAnsweredResponses(responses);
              text = `User cancelled the interview with partial responses.\n\nAnswered responses:\n${formatAnsweredResponsesForAgent(answered, questionsData.questions)}\n\nProceed with these inputs and use your best judgment for unanswered questions.`;
            } else {
              text =
                "User skipped the interview without providing answers. Proceed with your best judgment - use recommended options where specified, make reasonable choices elsewhere. Don't ask for clarification unless absolutely necessary.";
            }
          } else if (status === "timeout") {
            if (hasAnyAnswers(responses)) {
              const answered = filterAnsweredResponses(responses);
              text = `Interview form timed out after ${timeoutSeconds} seconds.\n\nAnswered responses before timeout:\n${formatAnsweredResponsesForAgent(answered, questionsData.questions)}\n\nQuestions saved to: ~/.pi/interview-recovery/\n\nProceed with these inputs and use your best judgment for unanswered questions.`;
            } else {
              text = `Interview form timed out after ${timeoutSeconds} seconds.\n\nQuestions saved to: ~/.pi/interview-recovery/`;
            }
          } else {
            text = "Interview was aborted.";
          }

          resolve({
            content: [{ type: "text", text }],
            details: {
              status,
              url,
              responses,
              title: interviewTitle,
              totalQuestions,
              answeredItems: buildAnsweredAgentResponseItems(responses, questionsData.questions),
            },
          });
        };

        const handleAbort = () => {
          finish("aborted");
        };
        signal?.addEventListener("abort", handleAbort, { once: true });

        let onGenerate: InterviewServerCallbacks["onGenerate"];
        let onOptionInsight: InterviewServerCallbacks["onOptionInsight"];
        if (generateModel) {
          const generateOptions = async <T>(
            model: Model<Api>,
            prompt: string,
            generateSignal: AbortSignal,
            parse: (text: string) => T,
          ) => {
            const modelRef = formatModelRef(model);
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
            if (!auth.ok) throw new Error(`${modelRef}: ${auth.error}`);
            if (!auth.apiKey) throw new Error(`No API key for ${modelRef}`);

            const response = await complete(model, createGenerateContext(prompt), {
              apiKey: auth.apiKey,
              headers: auth.headers,
              signal: generateSignal,
            });

            return parse(extractGenerateResponseText(modelRef, response));
          };

          const reviewQuestion = async <T>(
            model: Model<Api>,
            prompt: string,
            generateSignal: AbortSignal,
            parse: (text: string) => T,
          ) => {
            const modelRef = formatModelRef(model);
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
            if (!auth.ok) throw new Error(`${modelRef}: ${auth.error}`);
            if (!auth.apiKey) throw new Error(`No API key for ${modelRef}`);

            const response = await complete(
              model,
              createGenerateContext(prompt, REVIEW_QUESTION_SYSTEM_PROMPT),
              { apiKey: auth.apiKey, headers: auth.headers, signal: generateSignal },
            );

            return parse(extractGenerateResponseText(modelRef, response));
          };

          const optionInsight = async (
            model: Model<Api>,
            prompt: string,
            generateSignal: AbortSignal,
          ) => {
            const modelRef = formatModelRef(model);
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
            if (!auth.ok) throw new Error(`${modelRef}: ${auth.error}`);
            if (!auth.apiKey) throw new Error(`No API key for ${modelRef}`);

            const response = await complete(
              model,
              createGenerateContext(prompt, OPTION_INSIGHT_SYSTEM_PROMPT),
              { apiKey: auth.apiKey, headers: auth.headers, signal: generateSignal },
            );

            const parsed = parseOptionInsight(extractGenerateResponseText(modelRef, response));
            return { ...parsed, modelUsed: modelRef };
          };

          onGenerate = async (questionId, existingOptions, generateSignal, mode) => {
            const question = questionsData.questions.find((q) => q.id === questionId);
            if (!question) throw new Error(`Unknown question: ${questionId}`);
            const optionValues = question.options ?? [];
            const usesRichOptions = optionValues.some(isRichOption);

            const existingList =
              existingOptions.length > 0
                ? existingOptions.map((option) => `- ${option}`).join("\n")
                : "(none)";

            let prompt: string;
            if (mode === "review") {
              let recommended = "";
              if (question.recommended) {
                const value = Array.isArray(question.recommended)
                  ? question.recommended.join(", ")
                  : question.recommended;
                recommended = `\nRecommended: ${value}`;
              }
              if (usesRichOptions) {
                prompt = [
                  "Review this interview question and its options.",
                  "Rewrite the question so it is easier to understand while preserving the original intent.",
                  "Review the rich options as full structured objects: keep good ones as-is, fix bad ones, add missing ones, and remove bad ones.",
                  "Return ONLY JSON in this format:",
                  '{"question":"Clearer question text","options":[{"label":"Option A","content":{"source":"Explanation","lang":"md"}}]}',
                  "Each option must be an object with `label` and optional `content`.",
                  "",
                  questionsData.title ? `Interview: ${questionsData.title}` : null,
                  questionsData.description
                    ? `Interview context: ${questionsData.description}`
                    : null,
                  `Question: ${question.question}`,
                  question.context ? `Question context: ${question.context}` : null,
                  recommended || null,
                  "",
                  "Current options JSON:",
                  JSON.stringify(optionValues, null, 2),
                ]
                  .filter((line) => line !== null)
                  .join("\n");
              } else {
                prompt = [
                  "Review this interview question and its options.",
                  "Rewrite the question so it is easier to understand while preserving the original intent.",
                  "Review the options the same way you already would: keep good ones as-is, fix bad ones, add missing ones, and remove bad ones.",
                  "Return ONLY JSON in this format:",
                  '{"question":"Clearer question text","options":["Option A","Option B","Option C"]}',
                  "",
                  questionsData.title ? `Interview: ${questionsData.title}` : null,
                  questionsData.description
                    ? `Interview context: ${questionsData.description}`
                    : null,
                  `Question: ${question.question}`,
                  question.context ? `Question context: ${question.context}` : null,
                  recommended || null,
                  "",
                  "Current options:",
                  existingList,
                ]
                  .filter((line) => line !== null)
                  .join("\n");
              }
            } else {
              if (usesRichOptions) {
                prompt = [
                  "Generate 3 new, distinct options for this question.",
                  "Return ONLY a JSON array.",
                  "Each item may be either a short option string or an object with `label` and optional `content`.",
                  "Use an object when a new option needs supporting detail or example content.",
                  "",
                  `Question: ${question.question}`,
                  question.context ? `Context: ${question.context}` : null,
                  "",
                  "Existing options JSON (do NOT repeat labels):",
                  JSON.stringify(optionValues, null, 2),
                  "",
                  'Format: ["Option A", {"label":"Option B","content":{"source":"Explanation","lang":"md"}}]',
                ]
                  .filter((line) => line !== null)
                  .join("\n");
              } else {
                prompt = [
                  "Generate 3 new, distinct options for this question.",
                  "Return ONLY a JSON array of short option strings. No explanation, no markdown.",
                  "",
                  `Question: ${question.question}`,
                  question.context ? `Context: ${question.context}` : null,
                  "",
                  "Existing options (do NOT repeat):",
                  existingList,
                  "",
                  'Format: ["Option A", "Option B", "Option C"]',
                ]
                  .filter((line) => line !== null)
                  .join("\n");
              }
            }

            if (mode === "review") {
              let result: { question: string; options: OptionValue[] };
              try {
                result = await reviewQuestion(
                  generateModel,
                  prompt,
                  generateSignal,
                  usesRichOptions ? parseReviewedQuestionUpdate : parseReviewedQuestion,
                );
              } catch (err) {
                if (!fallbackGenerateModel || generateSignal.aborted) {
                  throw err;
                }
                try {
                  result = await reviewQuestion(
                    fallbackGenerateModel,
                    prompt,
                    generateSignal,
                    usesRichOptions ? parseReviewedQuestionUpdate : parseReviewedQuestion,
                  );
                } catch (fallbackErr) {
                  const primaryMessage = err instanceof Error ? err.message : String(err);
                  const fallbackMessage =
                    fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
                  throw new Error(`${primaryMessage}. Fallback failed: ${fallbackMessage}`);
                }
              }

              return result;
            }

            let options: OptionValue[];
            try {
              options = await generateOptions(
                generateModel,
                prompt,
                generateSignal,
                usesRichOptions ? parseGeneratedOptionValues : parseGeneratedOptions,
              );
            } catch (err) {
              if (!fallbackGenerateModel || generateSignal.aborted) {
                throw err;
              }
              try {
                options = await generateOptions(
                  fallbackGenerateModel,
                  prompt,
                  generateSignal,
                  usesRichOptions ? parseGeneratedOptionValues : parseGeneratedOptions,
                );
              } catch (fallbackErr) {
                const primaryMessage = err instanceof Error ? err.message : String(err);
                const fallbackMessage =
                  fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
                throw new Error(`${primaryMessage}. Fallback failed: ${fallbackMessage}`);
              }
            }

            return { options };
          };

          const getExplicitModel = (modelOverride: string): Model<Api> => {
            const slashIndex = modelOverride.indexOf("/");
            if (slashIndex <= 0 || slashIndex === modelOverride.length - 1) {
              throw new Error(`Invalid model override: ${modelOverride}. Use provider/model-id.`);
            }
            const selectedModel = ctx.modelRegistry.find(
              modelOverride.slice(0, slashIndex),
              modelOverride.slice(slashIndex + 1),
            );
            if (!selectedModel) {
              throw new Error(`Model not found: ${modelOverride}`);
            }
            return selectedModel;
          };

          onOptionInsight = async (
            questionId,
            option,
            prompt,
            modelOverride,
            depth,
            generateSignal,
          ) => {
            const question = questionsData.questions.find((q) => q.id === questionId);
            if (!question) throw new Error(`Unknown question: ${questionId}`);
            const optionText = getOptionLabel(option);
            const optionContent = typeof option === "string" ? null : option.content;

            const depthInstructions = {
              quick:
                "Keep the analysis very brief: a one-sentence summary and at most one bullet point.",
              standard: "Be concrete and concise. A short summary and a few bullet points.",
              deep: "Provide a thorough analysis: detailed summary, multiple bullet points covering tradeoffs, risks, and edge cases.",
            };

            const questionPrompt = [
              "Analyze this single interview answer option.",
              depthInstructions[depth as keyof typeof depthInstructions] ||
                depthInstructions.standard,
              "Explain what is good or risky about the option, and suggest a rewrite only if it would materially improve clarity.",
              "Return ONLY JSON with summary, bullets, and optional suggestedText.",
              "",
              questionsData.title ? `Interview: ${questionsData.title}` : null,
              questionsData.description ? `Interview context: ${questionsData.description}` : null,
              `Question: ${question.question}`,
              question.context ? `Question context: ${question.context}` : null,
              `Option: ${optionText}`,
              optionContent?.title ? `Option content title: ${optionContent.title}` : null,
              optionContent?.file ? `Option content file: ${optionContent.file}` : null,
              optionContent?.lines ? `Option content lines: ${optionContent.lines}` : null,
              optionContent?.lang ? `Option content language: ${optionContent.lang}` : null,
              optionContent?.source ? `Option content:\n${optionContent.source}` : null,
              `User request: ${prompt}`,
            ]
              .filter((line) => line !== null)
              .join("\n");

            if (modelOverride) {
              return await optionInsight(
                getExplicitModel(modelOverride),
                questionPrompt,
                generateSignal,
              );
            }

            try {
              return await optionInsight(generateModel, questionPrompt, generateSignal);
            } catch (err) {
              if (!fallbackGenerateModel || generateSignal.aborted) {
                throw err;
              }
              try {
                return await optionInsight(fallbackGenerateModel, questionPrompt, generateSignal);
              } catch (fallbackErr) {
                const primaryMessage = err instanceof Error ? err.message : String(err);
                const fallbackMessage =
                  fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
                throw new Error(`${primaryMessage}. Fallback failed: ${fallbackMessage}`);
              }
            }
          };
        }

        startInterviewServer(
          {
            questions: questionsData,
            sessionToken,
            sessionId,
            cwd: ctx.cwd,
            timeout: timeoutSeconds,
            port: settings.port,
            host: settings.host,
            publicBaseUrl: settings.publicBaseUrl,
            verbose,
            theme: themeConfig,
            snapshotDir,
            autoSaveOnSubmit: settings.autoSaveOnSubmit,
            savedAnswers: questionsData.savedAnswers,
            savedOptionInsights: questionsData.savedOptionInsights,
            optionKeysByQuestion: questionsData.optionKeysByQuestion,
            canGenerate: generateModel !== null,
            askModels,
            defaultAskModel,
          },
          {
            onSubmit: (responses) => finish("completed", responses),
            onCancel: (reason, partialResponses) =>
              reason === "timeout"
                ? finish("timeout", partialResponses ?? [])
                : finish("cancelled", partialResponses ?? [], reason),
            onProgress: (responses) => {
              if (!onUpdate || resolved) {
                return;
              }
              onUpdate({
                content: [
                  {
                    type: "text",
                    text: `Interview in progress. ${formatInterviewProgressMessage(responses, questionsData.questions)}`,
                  },
                ],
                details: {
                  status: "queued",
                  url,
                  responses,
                  title: interviewTitle,
                  totalQuestions,
                  answeredItems: buildAnsweredAgentResponseItems(
                    responses,
                    questionsData.questions,
                  ),
                  queuedMessage: [
                    "Interview in progress:",
                    `  Open: ${toTerminalHyperlink(url, url)}`,
                    `  Progress: ${formatInterviewProgressMessage(responses, questionsData.questions)}`,
                  ].join("\n"),
                  progressMessage: formatInterviewProgressMessage(
                    responses,
                    questionsData.questions,
                  ),
                },
              });
            },
            onGenerate,
            onOptionInsight,
          },
        )
          .then(async (handle) => {
            if (resolved) {
              handle.close();
              return;
            }
            server = handle;
            url = handle.url;
            const openLink = toTerminalHyperlink(url, url);

            const activeSessions = getActiveSessions();
            const otherActive = activeSessions.filter((s) => s.id !== sessionId);

            if (otherActive.length > 0) {
              const active = otherActive[0];
              const queuedLines = [
                "Interview already active:",
                `  Title: ${active.title}`,
                `  Project: ${active.cwd}${active.gitBranch ? ` (${active.gitBranch})` : ""}`,
                `  Session: ${active.id.slice(0, 8)}`,
                `  Started: ${formatTimeAgo(active.startedAt)}`,
                "",
                "New interview ready:",
                `  Title: ${questionsData.title || "Interview"}`,
              ];
              const normalizedCwd = ctx.cwd.startsWith(os.homedir())
                ? "~" + ctx.cwd.slice(os.homedir().length)
                : ctx.cwd;
              const gitBranch = (() => {
                try {
                  return (
                    execSync("git rev-parse --abbrev-ref HEAD", {
                      cwd: ctx.cwd,
                      encoding: "utf8",
                      timeout: 2000,
                      stdio: ["pipe", "pipe", "pipe"],
                    }).trim() || null
                  );
                } catch {
                  return null;
                }
              })();
              queuedLines.push(`  Project: ${normalizedCwd}${gitBranch ? ` (${gitBranch})` : ""}`);
              queuedLines.push(`  Session: ${sessionId.slice(0, 8)}`);
              queuedLines.push("");
              queuedLines.push(`Open when ready: ${openLink}`);
              queuedLines.push("");
              queuedLines.push("Server waiting until you open the link.");
              const queuedMessage = queuedLines.join("\n");
              const queuedSummary = "Interview queued; see tool panel for link.";
              if (onUpdate) {
                onUpdate({
                  content: [{ type: "text", text: queuedSummary }],
                  details: {
                    status: "queued",
                    url,
                    responses: [],
                    queuedMessage,
                    title: interviewTitle,
                    totalQuestions,
                    answeredItems: [],
                  },
                });
              } else {
                ctx.ui.notify(queuedSummary, "info");
              }
            } else {
              const launchMessage = [
                "Interview ready:",
                `  Title: ${questionsData.title || "Interview"}`,
                `  Open: ${openLink}`,
              ].join("\n");
              if (onUpdate) {
                onUpdate({
                  content: [{ type: "text", text: launchMessage }],
                  details: {
                    status: "queued",
                    url,
                    responses: [],
                    queuedMessage: launchMessage,
                    title: interviewTitle,
                    totalQuestions,
                    answeredItems: [],
                  },
                });
              } else {
                ctx.ui.notify(`Interview ready: ${url}`, "info");
              }

              if (settings.autoOpenBrowser && shouldAutoOpenBrowser()) {
                try {
                  await openBrowserTarget(url);
                } catch (err) {
                  if (verbose) {
                    const message = err instanceof Error ? err.message : String(err);
                    ctx.ui.notify(`Open browser manually: ${url}\n${message}`, "warning");
                  }
                }
              }
            }
          })
          .catch((err) => {
            cleanup();
            reject(err);
          });
      });
    },

    renderCall(args, theme, context) {
      return createTextComponent(context.lastComponent, "");
    },

    renderResult(result, options, theme, context) {
      const details = result.details as InterviewDetails | undefined;
      if (!details) {
        const rail = formatToolRail(theme, context);
        const status = context.isError
          ? getInterviewStatus({ status: "aborted", responses: [], url: "" })
          : { label: "interviewing", color: "dim" as const };
        return createTextComponent(
          context.lastComponent,
          `${rail}${theme.bold(theme.fg(status.color, status.label))} ${theme.fg("muted", "interview")}`,
        );
      }

      const rail = formatToolRail(theme, context);
      const title = details.title ?? "interview";
      const totalQuestions = details.totalQuestions ?? details.responses.length;
      const answeredCount =
        details.answeredItems?.length ?? filterAnsweredResponses(details.responses).length;

      if (details.status === "queued") {
        const progressText =
          typeof details.progressMessage === "string" && details.progressMessage.length > 0
            ? details.progressMessage
            : "waiting for browser";
        const header = `${rail}${theme.bold(theme.fg(context.isError ? "error" : "dim", "interviewing"))} ${theme.fg("muted", title)} ${theme.fg("dim", "·")} ${theme.fg("muted", `${answeredCount}/${totalQuestions} answered`)} ${theme.fg("dim", "·")} ${theme.fg("dim", toTerminalHyperlink(details.url, theme.underline("open")))}`;
        if (!options.expanded) {
          return createTextComponent(context.lastComponent, header);
        }

        const message = details.queuedMessage ?? getTextContent(result);
        const lines = [...message.split("\n"), ...getInterviewLinkLines(details.url, theme)]
          .map((line) => `${rail}${theme.fg("dim", line)}`)
          .join("\n");
        return createTextComponent(
          context.lastComponent,
          `${header}\n${rail}${theme.fg("dim", progressText)}\n${formatInterviewExpandedDetails(details, theme, rail)}\n${lines}`,
        );
      }

      const status = getInterviewStatus(details);
      const summary = formatInterviewCountSummary(answeredCount, totalQuestions);
      const header = `${rail}${theme.bold(theme.fg(status.color, status.label))} ${theme.fg("muted", title)} ${theme.fg("dim", "·")} ${theme.fg("muted", summary)}`;
      if (!options.expanded) {
        return createTextComponent(context.lastComponent, header);
      }

      return createTextComponent(
        context.lastComponent,
        `${header}\n${formatInterviewExpandedDetails(details, theme, rail)}`,
      );
    },
  });
}
