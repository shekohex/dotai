import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { getErrorMessage } from "./errors.js";
import { resolveCoderPublicBaseUrl } from "./public-url.js";
import { getOptionLabel, type OptionValue } from "./schema.js";
import { log, STYLES } from "./server-assets.js";
import type {
  InterviewServerCallbacks,
  InterviewServerHandle,
  InterviewServerOptions,
  ResponseItem,
} from "./server-contract.js";
import {
  cleanupOldRecoveryFiles,
  getActiveSessions,
  normalizePath,
  registerSession,
  saveToRecovery,
  sanitizeForFilename,
  SNAPSHOTS_DIR,
  STALE_THRESHOLD_MS,
  touchSession,
  unregisterSession,
} from "./server-session-store.js";
import {
  cloneResponseValue,
  createBodyParser,
  createOptionKey,
  ensureQuestionId,
  getOptionIndexByKey,
  normalizeGeneratedOptionValues,
  normalizeResponseItems,
  normalizeSavedOptionInsights,
  reconcileOptionKeysByLabel,
  sendJsonResponse,
  sendRequestError,
  sendTextResponse,
  syncRecommendations,
  validateTokenBody,
  validateTokenQuery,
} from "./server-request.js";
import { copyMediaImages, generateSavedHtml } from "./server-saved-html.js";
import {
  applyUploadedImages,
  createRuntimeState,
  getRootHtml,
  getScriptAsset,
  getThemeCss,
  getWatchdogIntervalMs,
  handleMediaRequest,
  hasText,
  markCompleted,
  normalizeCancelReason,
  shouldMarkStale,
  touchHeartbeat,
  type InterviewRuntimeState,
} from "./server-runtime-support.js";

const MAX_IMAGES = 12;

const ImageUploadSchema = Type.Object(
  {
    id: Type.String(),
    filename: Type.String(),
    mimeType: Type.String(),
    data: Type.String(),
    isAttachment: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const CancelBodySchema = Type.Object(
  {
    token: Type.String(),
    reason: Type.Optional(Type.String()),
    responses: Type.Optional(Type.Array(Type.Unknown())),
  },
  { additionalProperties: true },
);
const ProgressBodySchema = Type.Object(
  { token: Type.String(), responses: Type.Optional(Type.Array(Type.Unknown())) },
  { additionalProperties: true },
);
const SubmitBodySchema = Type.Object(
  {
    token: Type.String(),
    responses: Type.Optional(Type.Array(Type.Unknown())),
    images: Type.Optional(Type.Array(ImageUploadSchema)),
  },
  { additionalProperties: true },
);
const SaveBodySchema = Type.Object(
  {
    token: Type.String(),
    responses: Type.Optional(Type.Array(Type.Unknown())),
    savedOptionInsights: Type.Optional(Type.Array(Type.Unknown())),
    images: Type.Optional(Type.Array(ImageUploadSchema)),
    submitted: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);
const GenerateBodySchema = Type.Object(
  { token: Type.String(), questionId: Type.String(), mode: Type.Optional(Type.String()) },
  { additionalProperties: true },
);
const OptionInsightBodySchema = Type.Object(
  {
    token: Type.String(),
    questionId: Type.String(),
    optionKey: Type.String(),
    prompt: Type.String(),
    model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    depth: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

type ImageUpload = Static<typeof ImageUploadSchema>;

function parseBodyWithSchema<T>(body: unknown, schema: ReturnType<typeof Type.Object>): T | null {
  if (!Value.Check(schema, body)) return null;
  return Value.Parse(schema, body) as T;
}

function sendStaticAsset(res: ServerResponse, type: string, content: string): void {
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(content);
}

function handleGetRequest(
  state: InterviewRuntimeState,
  method: string,
  url: URL,
  res: ServerResponse,
): boolean {
  if (method !== "GET") return false;
  if (url.pathname === "/") {
    if (validateTokenQuery(url, state.options.sessionToken, res)) {
      touchHeartbeat(state);
      sendStaticAsset(res, "text/html; charset=utf-8", getRootHtml(state));
    }
    return true;
  }
  if (url.pathname === "/health") {
    if (validateTokenQuery(url, state.options.sessionToken, res))
      sendJsonResponse(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/sessions") {
    if (!validateTokenQuery(url, state.options.sessionToken, res)) return true;
    sendJsonResponse(res, 200, {
      ok: true,
      sessions: getActiveSessions().map((session) => ({
        ...session,
        status: Date.now() - session.lastSeen < STALE_THRESHOLD_MS ? "active" : "waiting",
      })),
    });
    return true;
  }
  if (url.pathname === "/styles.css") {
    if (validateTokenQuery(url, state.options.sessionToken, res))
      sendStaticAsset(res, "text/css; charset=utf-8", STYLES);
    return true;
  }
  const themeCss = getThemeCss(state);
  if (url.pathname === "/theme-light.css") {
    if (validateTokenQuery(url, state.options.sessionToken, res))
      sendStaticAsset(res, "text/css; charset=utf-8", themeCss.lightCss);
    return true;
  }
  if (url.pathname === "/theme-dark.css") {
    if (validateTokenQuery(url, state.options.sessionToken, res))
      sendStaticAsset(res, "text/css; charset=utf-8", themeCss.darkCss);
    return true;
  }
  if (url.pathname === "/script.js") {
    if (validateTokenQuery(url, state.options.sessionToken, res))
      sendStaticAsset(res, "application/javascript; charset=utf-8", getScriptAsset());
    return true;
  }
  if (url.pathname === "/media") {
    if (validateTokenQuery(url, state.options.sessionToken, res))
      handleMediaRequest(state, url, res);
    return true;
  }
  return false;
}

async function handleSaveRoute(
  state: InterviewRuntimeState,
  body: unknown,
  res: ServerResponse,
): Promise<boolean> {
  const payload = parseBodyWithSchema<{
    token: string;
    responses?: unknown[];
    savedOptionInsights?: unknown[];
    images?: ImageUpload[];
    submitted?: boolean;
  }>(body, SaveBodySchema);
  if (payload === null) {
    sendRequestError(res, 400, "Invalid request body");
    return true;
  }
  if (!validateTokenBody(payload, state.options.sessionToken, res)) return true;
  const normalizedResponses = normalizeResponseItems(payload.responses ?? [], state.questionById);
  if (!normalizedResponses.ok) {
    sendRequestError(res, 400, normalizedResponses.error, normalizedResponses.field);
    return true;
  }
  const now = new Date();
  const timestamp = `${now.toISOString().slice(0, 10)}-${now.toTimeString().slice(0, 8).replaceAll(":", "")}`;
  const titleSlug = sanitizeForFilename(state.options.questions.title ?? "interview");
  const projectSlug = sanitizeForFilename(basename(state.options.cwd) || "unknown");
  const branchSlug = sanitizeForFilename(state.gitBranch ?? "nogit");
  const folderName = `${titleSlug}-${projectSlug}-${branchSlug}-${timestamp}${payload.submitted === true ? "-submitted" : ""}`;
  const snapshotPath = join(state.options.snapshotDir ?? SNAPSHOTS_DIR, folderName);
  const imagesPath = join(snapshotPath, "images");
  await mkdir(snapshotPath, { recursive: true });
  const savedResponses = normalizedResponses.responses.map((response) => ({
    ...response,
    value: cloneResponseValue(response.value),
    attachments: response.attachments === undefined ? undefined : [...response.attachments],
  }));
  if ((payload.images ?? []).length > 0) {
    await mkdir(imagesPath, { recursive: true });
    try {
      await applyUploadedImages({
        responses: savedResponses,
        images: payload.images ?? [],
        questionById: state.questionById,
        sessionId: state.options.sessionId,
        targetDir: imagesPath,
        toRelative: true,
      });
    } catch (error) {
      sendRequestError(res, 400, getErrorMessage(error));
      return true;
    }
  }
  const rewrittenQuestions = await copyMediaImages(
    state.options.questions.questions,
    imagesPath,
    state.options.cwd,
  );
  const themeCss = state.themeMode === "light" ? state.themeLightCss : state.themeDarkCss;
  const html = generateSavedHtml({
    questions: { ...state.options.questions, questions: rewrittenQuestions },
    answers: savedResponses,
    optionInsights: normalizeSavedOptionInsights(payload.savedOptionInsights),
    optionKeysByQuestion: state.optionKeysByQuestion,
    meta: {
      savedAt: new Date().toISOString(),
      wasSubmitted: payload.submitted === true,
      savedFrom: {
        cwd: state.normalizedCwd,
        branch: state.gitBranch,
        sessionId: state.options.sessionId,
      },
    },
    baseStyles: STYLES,
    themeCss,
  });
  await writeFile(join(snapshotPath, "index.html"), html);
  sendJsonResponse(res, 200, {
    ok: true,
    path: snapshotPath,
    relativePath: normalizePath(snapshotPath),
  });
  return true;
}

function handleCancelRoute(
  state: InterviewRuntimeState,
  body: unknown,
  res: ServerResponse,
): boolean {
  const payload = parseBodyWithSchema<{ token: string; reason?: string; responses?: unknown[] }>(
    body,
    CancelBodySchema,
  );
  if (payload === null) {
    sendRequestError(res, 400, "Invalid request body");
    return true;
  }
  if (!validateTokenBody(payload, state.options.sessionToken, res)) return true;
  if (state.completed) {
    sendJsonResponse(res, 200, { ok: true });
    return true;
  }
  if (payload.reason === "timeout" || payload.reason === "stale")
    log(
      state.options.verbose,
      `Interview ${payload.reason}. Saved to: ${saveToRecovery(state.options.questions, state.options.cwd, state.gitBranch, state.options.sessionId)}`,
    );
  let partialResponses: ResponseItem[] | undefined;
  if (Array.isArray(payload.responses)) {
    const normalized = normalizeResponseItems(payload.responses, state.questionById);
    if (normalized.ok) partialResponses = normalized.responses;
  }
  markCompleted(state);
  unregisterSession(state.options.sessionId);
  sendJsonResponse(res, 200, { ok: true });
  setImmediate(() => {
    state.callbacks.onCancel(normalizeCancelReason(payload.reason), partialResponses);
  });
  return true;
}

function handleProgressRoute(
  state: InterviewRuntimeState,
  body: unknown,
  res: ServerResponse,
): boolean {
  const payload = parseBodyWithSchema<{ token: string; responses?: unknown[] }>(
    body,
    ProgressBodySchema,
  );
  if (payload === null) {
    sendRequestError(res, 400, "Invalid request body");
    return true;
  }
  if (!validateTokenBody(payload, state.options.sessionToken, res)) return true;
  if (state.callbacks.onProgress === undefined || state.completed) {
    sendJsonResponse(res, 200, { ok: true });
    return true;
  }
  const normalizedResponses = normalizeResponseItems(payload.responses ?? [], state.questionById);
  if (!normalizedResponses.ok) {
    sendRequestError(res, 400, normalizedResponses.error, normalizedResponses.field);
    return true;
  }
  touchHeartbeat(state);
  sendJsonResponse(res, 200, { ok: true });
  state.callbacks.onProgress(normalizedResponses.responses);
  return true;
}

async function handleSubmitRoute(
  state: InterviewRuntimeState,
  body: unknown,
  res: ServerResponse,
): Promise<boolean> {
  const payload = parseBodyWithSchema<{
    token: string;
    responses?: unknown[];
    images?: ImageUpload[];
  }>(body, SubmitBodySchema);
  if (payload === null) {
    sendRequestError(res, 400, "Invalid request body");
    return true;
  }
  if (!validateTokenBody(payload, state.options.sessionToken, res)) return true;
  if (state.completed) {
    sendRequestError(res, 409, "Session closed");
    return true;
  }
  if ((payload.images ?? []).length > MAX_IMAGES) {
    sendRequestError(res, 400, `Too many images (max ${MAX_IMAGES})`);
    return true;
  }
  const normalizedResponses = normalizeResponseItems(payload.responses ?? [], state.questionById);
  if (!normalizedResponses.ok) {
    sendRequestError(res, 400, normalizedResponses.error, normalizedResponses.field);
    return true;
  }
  try {
    await applyUploadedImages({
      responses: normalizedResponses.responses,
      images: payload.images ?? [],
      questionById: state.questionById,
      sessionId: state.options.sessionId,
    });
  } catch (error) {
    sendRequestError(res, 400, getErrorMessage(error));
    return true;
  }
  markCompleted(state);
  unregisterSession(state.options.sessionId);
  const nextSession = getActiveSessions()
    .filter((session) => session.id !== state.options.sessionId)
    .toSorted((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))[0];
  sendJsonResponse(res, 200, { ok: true, nextUrl: nextSession?.url ?? null });
  setImmediate(() => {
    state.callbacks.onSubmit(normalizedResponses.responses);
  });
  return true;
}

async function handleGenerateRoute(
  state: InterviewRuntimeState,
  body: unknown,
  res: ServerResponse,
): Promise<boolean> {
  const payload = parseBodyWithSchema<{ token: string; questionId: string; mode?: string }>(
    body,
    GenerateBodySchema,
  );
  if (payload === null) {
    sendRequestError(res, 400, "Invalid request body");
    return true;
  }
  if (!validateTokenBody(payload, state.options.sessionToken, res)) return true;
  if (state.completed) return (sendRequestError(res, 409, "Session closed"), true);
  if (state.callbacks.onGenerate === undefined)
    return (sendRequestError(res, 501, "Generation not available"), true);
  const question = state.questionById.get(payload.questionId);
  if (question === undefined || (question.type !== "single" && question.type !== "multi"))
    return (sendRequestError(res, 400, "Invalid question for generation"), true);
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  touchHeartbeat(state);
  try {
    const result = await state.callbacks.onGenerate(
      payload.questionId,
      (question.options ?? []).map((option) => getOptionLabel(option).trim()),
      controller.signal,
      payload.mode === "review" ? "review" : "add",
    );
    const uniqueOptions = normalizeGeneratedOptionValues(result.options);
    const reviewedQuestion =
      typeof result.question === "string" ? result.question.trim() : undefined;
    let nextOptionKeys = state.optionKeysByQuestion[payload.questionId] ?? [];
    let appliedOptions: OptionValue[] = [];
    if (payload.mode === "review" && reviewedQuestion !== undefined && uniqueOptions.length > 0) {
      const previousOptions = [...(question.options ?? [])];
      const previousKeys = [...(state.optionKeysByQuestion[payload.questionId] ?? [])];
      question.question = reviewedQuestion;
      question.options = uniqueOptions;
      syncRecommendations(question, uniqueOptions);
      nextOptionKeys = reconcileOptionKeysByLabel(previousOptions, previousKeys, uniqueOptions);
      state.optionKeysByQuestion[payload.questionId] = nextOptionKeys;
      appliedOptions = uniqueOptions;
    } else if (payload.mode !== "review") {
      const existingLabels = new Set(
        (question.options ?? []).map((option) => getOptionLabel(option).trim().toLowerCase()),
      );
      appliedOptions = uniqueOptions.filter(
        (option) => !existingLabels.has(getOptionLabel(option).trim().toLowerCase()),
      );
      if (appliedOptions.length > 0) {
        question.options = [...(question.options ?? []), ...appliedOptions];
        nextOptionKeys = [
          ...(state.optionKeysByQuestion[payload.questionId] ?? []),
          ...appliedOptions.map(() => createOptionKey()),
        ];
        state.optionKeysByQuestion[payload.questionId] = nextOptionKeys;
      }
    }
    sendJsonResponse(res, 200, {
      ok: true,
      options: appliedOptions,
      question: reviewedQuestion,
      optionKeys: nextOptionKeys,
    });
  } catch (error) {
    sendRequestError(
      res,
      controller.signal.aborted ? 409 : 500,
      controller.signal.aborted ? "Request cancelled" : getErrorMessage(error),
    );
  }
  return true;
}

async function handleOptionInsightRoute(
  state: InterviewRuntimeState,
  body: unknown,
  res: ServerResponse,
): Promise<boolean> {
  const payload = parseBodyWithSchema<{
    token: string;
    questionId: string;
    optionKey: string;
    prompt: string;
    model?: string | null;
    depth?: string;
  }>(body, OptionInsightBodySchema);
  if (payload === null) {
    sendRequestError(res, 400, "Invalid request body");
    return true;
  }
  if (!validateTokenBody(payload, state.options.sessionToken, res)) return true;
  if (state.completed) return (sendRequestError(res, 409, "Session closed"), true);
  if (state.callbacks.onOptionInsight === undefined)
    return (sendRequestError(res, 501, "Option insight not available"), true);
  if (payload.prompt.trim().length === 0)
    return (sendRequestError(res, 400, "Prompt is required"), true);
  const questionCheck = ensureQuestionId(payload.questionId, state.questionById);
  if (!questionCheck.ok) return (sendRequestError(res, 400, questionCheck.error), true);
  const question = questionCheck.question;
  const optionIndex = getOptionIndexByKey(question, state.optionKeysByQuestion, payload.optionKey);
  if (
    optionIndex === -1 ||
    question.options === undefined ||
    optionIndex >= question.options.length
  )
    return (sendRequestError(res, 400, "Invalid option for insight"), true);
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  touchHeartbeat(state);
  try {
    const option = question.options[optionIndex];
    const result = await state.callbacks.onOptionInsight(
      payload.questionId,
      option,
      payload.prompt.trim(),
      payload.model ?? null,
      payload.depth ?? "standard",
      controller.signal,
    );
    sendJsonResponse(res, 200, { ok: true, optionText: getOptionLabel(option), ...result });
  } catch (error) {
    sendRequestError(
      res,
      controller.signal.aborted ? 409 : 500,
      controller.signal.aborted ? "Request cancelled" : getErrorMessage(error),
    );
  }
  return true;
}

function handlePostRequest(
  state: InterviewRuntimeState,
  method: string,
  url: URL,
  body: unknown,
  res: ServerResponse,
): Promise<boolean> {
  if (method !== "POST") return Promise.resolve(false);
  if (url.pathname === "/heartbeat") {
    if (validateTokenBody(body, state.options.sessionToken, res)) {
      touchHeartbeat(state);
      sendJsonResponse(res, 200, { ok: true });
    }
    return Promise.resolve(true);
  }
  if (url.pathname === "/cancel") return Promise.resolve(handleCancelRoute(state, body, res));
  if (url.pathname === "/progress") return Promise.resolve(handleProgressRoute(state, body, res));
  if (url.pathname === "/submit") return handleSubmitRoute(state, body, res);
  if (url.pathname === "/save") return handleSaveRoute(state, body, res);
  if (url.pathname === "/generate") return handleGenerateRoute(state, body, res);
  if (url.pathname === "/option-insight") return handleOptionInsightRoute(state, body, res);
  return Promise.resolve(false);
}

async function handleRequest(
  state: InterviewRuntimeState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    log(state.options.verbose, `${method} ${url.pathname}`);
    if (handleGetRequest(state, method, url, res)) return;
    const body = await createBodyParser()(req, res);
    if (body === undefined || body === null) return;
    if (await handlePostRequest(state, method, url, body, res)) return;
    sendTextResponse(res, 404, "Not found");
  } catch (error) {
    sendJsonResponse(res, 500, { ok: false, error: getErrorMessage(error) || "Server error" });
  }
}

function buildPublicUrl(state: InterviewRuntimeState, port: number): string {
  const baseUrl = hasText(state.options.publicBaseUrl?.trim())
    ? state.options.publicBaseUrl.trim()
    : (resolveCoderPublicBaseUrl(port) ??
      `http://${state.listenHost === "0.0.0.0" || state.listenHost === "::" ? "127.0.0.1" : state.listenHost}:${port}`);
  const publicUrl = new URL(baseUrl);
  publicUrl.pathname = "/";
  publicUrl.search = `?session=${encodeURIComponent(state.options.sessionToken)}`;
  publicUrl.hash = "";
  return publicUrl.toString();
}

function scheduleStateTimers(state: InterviewRuntimeState): void {
  const keepAliveEntry = state.sessionEntry;
  if (keepAliveEntry !== null) {
    state.sessionKeepAlive = setInterval(() => {
      if (!state.completed) touchSession(keepAliveEntry);
    }, 10_000);
  }
  state.watchdog = setInterval(() => {
    if (shouldMarkStale(state) && markCompleted(state)) {
      log(
        state.options.verbose,
        `Interview stale. Saved to: ${saveToRecovery(state.options.questions, state.options.cwd, state.gitBranch, state.options.sessionId)}`,
      );
      unregisterSession(state.options.sessionId);
      setImmediate(() => {
        state.callbacks.onCancel("stale");
      });
    }
  }, getWatchdogIntervalMs());
}

function listenForServerStart(
  state: InterviewRuntimeState,
  server: http.Server,
): Promise<InterviewServerHandle> {
  return new Promise((resolveHandle, rejectHandle) => {
    const onError = (error: Error): void => {
      rejectHandle(new Error(`Failed to start server: ${error.message}`));
    };
    server.once("error", onError);
    server.listen(state.options.port ?? 0, state.listenHost, () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectHandle(new Error("Failed to start server: invalid address"));
        return;
      }
      cleanupOldRecoveryFiles();
      const now = Date.now();
      const url = buildPublicUrl(state, address.port);
      state.sessionEntry = {
        id: state.options.sessionId,
        url,
        cwd: state.normalizedCwd,
        gitBranch: state.gitBranch,
        title: state.options.questions.title ?? "Interview",
        startedAt: now,
        lastSeen: now,
      };
      registerSession(state.sessionEntry);
      scheduleStateTimers(state);
      resolveHandle({
        server,
        url,
        close: () => {
          markCompleted(state);
          unregisterSession(state.options.sessionId);
          server.close();
        },
      });
    });
  });
}

export function startInterviewServer(
  options: InterviewServerOptions,
  callbacks: InterviewServerCallbacks,
): Promise<InterviewServerHandle> {
  const state = createRuntimeState(
    options,
    callbacks,
    normalizeSavedOptionInsights(options.savedOptionInsights),
  );
  const server = http.createServer((req, res) => {
    void handleRequest(state, req, res);
  });
  return listenForServerStart(state, server);
}
