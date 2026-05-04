import type { ServerResponse } from "node:http";

import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

import { getResolvedThemeAssets, SCRIPT, TEMPLATE } from "./server-assets.js";
import type {
  InterviewServerCallbacks,
  InterviewServerOptions,
  ResponseItem,
  SavedOptionInsight,
  SessionEntry,
} from "./server-contract.js";
import { getMediaList } from "./server-contract.js";
import { getGitBranch, normalizePath, touchSession } from "./server-session-store.js";
import {
  buildOptionKeysByQuestion,
  ensureQuestionId,
  handleImageUpload,
} from "./server-request.js";
import { sendTextResponse } from "./server-request.js";
import type { Question } from "./schema.js";

const ABANDONED_GRACE_MS = 60_000;
const WATCHDOG_INTERVAL_MS = 5000;

export interface InterviewRuntimeState {
  options: InterviewServerOptions;
  callbacks: InterviewServerCallbacks;
  questionById: Map<string, Question>;
  optionKeysByQuestion: Record<string, string[]>;
  initialSavedOptionInsights: SavedOptionInsight[];
  normalizedCwd: string;
  gitBranch: string | null;
  listenHost: string;
  cdnScripts: string;
  themeLightCss: string;
  themeDarkCss: string;
  themeMode: "auto" | "light" | "dark";
  sessionEntry: SessionEntry | null;
  browserConnected: boolean;
  lastHeartbeatAt: number;
  watchdog: NodeJS.Timeout | null;
  sessionKeepAlive: NodeJS.Timeout | null;
  completed: boolean;
}

export function hasText(value: string | undefined | null): value is string {
  return typeof value === "string" && value.length > 0;
}

export function normalizeCancelReason(
  reason: string | undefined,
): "timeout" | "user" | "stale" | undefined {
  return reason === "timeout" || reason === "user" || reason === "stale" ? reason : undefined;
}

function getMediaContentType(filePath: string): string {
  const ext = filePath.split(".").at(-1)?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
  };
  return mimeTypes[ext ?? ""] ?? "application/octet-stream";
}

function resolveMediaPath(cwd: string, filePath: string): string {
  if (filePath.startsWith("~")) return resolve(join(homedir(), filePath.slice(1)));
  if (filePath.startsWith("/")) return resolve(filePath);
  return resolve(join(cwd, filePath));
}

function isAllowedMediaPath(cwd: string, resolvedPath: string): boolean {
  return [cwd, homedir(), tmpdir()].some(
    (directory) => resolvedPath === directory || resolvedPath.startsWith(`${directory}/`),
  );
}

function buildInlineData(state: InterviewRuntimeState): string {
  const { options } = state;
  return JSON.stringify({
    questions: options.questions.questions,
    title: options.questions.title,
    description: options.questions.description,
    sessionToken: options.sessionToken,
    sessionId: options.sessionId,
    cwd: state.normalizedCwd,
    gitBranch: state.gitBranch,
    startedAt: Date.now(),
    timeout: options.timeout,
    theme: { mode: state.themeMode, toggleHotkey: options.theme?.toggleHotkey },
    savedAnswers: options.savedAnswers,
    savedOptionInsights: state.initialSavedOptionInsights,
    optionKeysByQuestion: state.optionKeysByQuestion,
    autoSaveOnSubmit: options.autoSaveOnSubmit ?? true,
    canGenerate: options.canGenerate ?? false,
    askModels: options.askModels ?? [],
    defaultAskModel: options.defaultAskModel ?? null,
  })
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function buildCdnScripts(questions: Question[]): string {
  const needsChartJs = questions.some((question) =>
    getMediaList(question).some((media) => media.type === "chart"),
  );
  const needsMermaid = questions.some((question) =>
    getMediaList(question).some((media) => media.type === "mermaid"),
  );
  return `${needsChartJs ? '<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>\n' : ""}${needsMermaid ? '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>\n' : ""}`;
}

export function createRuntimeState(
  options: InterviewServerOptions,
  callbacks: InterviewServerCallbacks,
  initialSavedOptionInsights: SavedOptionInsight[],
): InterviewRuntimeState {
  const themeAssets = getResolvedThemeAssets({ theme: options.theme, verbose: options.verbose });
  return {
    options,
    callbacks,
    questionById: new Map(options.questions.questions.map((question) => [question.id, question])),
    optionKeysByQuestion: buildOptionKeysByQuestion(
      options.questions.questions,
      options.optionKeysByQuestion,
    ),
    initialSavedOptionInsights,
    normalizedCwd: normalizePath(options.cwd),
    gitBranch: getGitBranch(options.cwd),
    listenHost: hasText(options.host?.trim()) ? options.host.trim() : "127.0.0.1",
    cdnScripts: buildCdnScripts(options.questions.questions),
    themeLightCss: themeAssets.lightCss,
    themeDarkCss: themeAssets.darkCss,
    themeMode: themeAssets.mode,
    sessionEntry: null,
    browserConnected: false,
    lastHeartbeatAt: Date.now(),
    watchdog: null,
    sessionKeepAlive: null,
    completed: false,
  };
}

export function markCompleted(state: InterviewRuntimeState): boolean {
  if (state.completed) return false;
  state.completed = true;
  if (state.watchdog !== null) clearInterval(state.watchdog);
  if (state.sessionKeepAlive !== null) clearInterval(state.sessionKeepAlive);
  state.watchdog = null;
  state.sessionKeepAlive = null;
  return true;
}

export function touchHeartbeat(state: InterviewRuntimeState): void {
  state.lastHeartbeatAt = Date.now();
  state.browserConnected = true;
  if (state.sessionEntry !== null) touchSession(state.sessionEntry);
}

export function handleMediaRequest(
  state: InterviewRuntimeState,
  url: URL,
  res: ServerResponse,
): void {
  const filePath = url.searchParams.get("path");
  if (!hasText(filePath)) {
    sendTextResponse(res, 400, "Missing path parameter");
    return;
  }
  const resolvedPath = resolveMediaPath(state.options.cwd, filePath);
  if (!isAllowedMediaPath(state.options.cwd, resolvedPath)) {
    sendTextResponse(res, 403, "Path not allowed");
    return;
  }
  if (!existsSync(resolvedPath)) {
    sendTextResponse(res, 404, "File not found");
    return;
  }
  const data = readFileSync(resolvedPath);
  res.writeHead(200, {
    "Content-Type": getMediaContentType(resolvedPath),
    "Cache-Control": "private, max-age=300",
    "Content-Length": data.length,
  });
  res.end(data);
}

export async function applyUploadedImages(options: {
  responses: ResponseItem[];
  images: Array<{
    id: string;
    filename: string;
    mimeType: string;
    data: string;
    isAttachment?: boolean;
  }>;
  questionById: Map<string, Question>;
  sessionId: string;
  targetDir?: string;
  toRelative?: boolean;
}): Promise<void> {
  for (const image of options.images) {
    const questionCheck = ensureQuestionId(image.id, options.questionById);
    if (!questionCheck.ok) throw new Error(questionCheck.error);
    const uploadedPath = await handleImageUpload(image, options.sessionId, options.targetDir);
    const valuePath =
      options.toRelative === true ? `images/${basename(uploadedPath)}` : uploadedPath;
    const existing = options.responses.find((response) => response.id === image.id);
    if (image.isAttachment === true) {
      if (existing === undefined)
        options.responses.push({ id: image.id, value: "", attachments: [valuePath] });
      else existing.attachments = [...(existing.attachments ?? []), valuePath];
      continue;
    }
    if (existing === undefined) options.responses.push({ id: image.id, value: valuePath });
    else if (
      Array.isArray(existing.value) &&
      existing.value.every((item) => typeof item === "string")
    )
      existing.value.push(valuePath);
    else if (existing.value === "") existing.value = valuePath;
    else if (typeof existing.value === "string") existing.value = [existing.value, valuePath];
    else existing.value = valuePath;
  }
}

export function getRootHtml(state: InterviewRuntimeState): string {
  return TEMPLATE.replace("<!-- __CDN_SCRIPTS__ -->", state.cdnScripts)
    .replace("/* __INTERVIEW_DATA_PLACEHOLDER__ */", buildInlineData(state))
    .replaceAll("__SESSION_TOKEN__", state.options.sessionToken);
}

export function getScriptAsset(): string {
  return SCRIPT;
}

export function getThemeCss(state: InterviewRuntimeState): { lightCss: string; darkCss: string } {
  return { lightCss: state.themeLightCss, darkCss: state.themeDarkCss };
}

export function shouldMarkStale(state: InterviewRuntimeState): boolean {
  return (
    !state.completed &&
    state.browserConnected &&
    Date.now() - state.lastHeartbeatAt > ABANDONED_GRACE_MS
  );
}

export function getWatchdogIntervalMs(): number {
  return WATCHDOG_INTERVAL_MS;
}
