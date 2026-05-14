import type { IncomingMessage, ServerResponse } from "node:http";

import type { AgentJobHandlerOptions } from "./agent-jobs.js";
import type { ReviewMutableState, ReviewRouteContext } from "./review-diff-routes.js";
import {
  handleReviewDiffSwitch,
  handleReviewFileContent,
  handleReviewPrContext,
  handleReviewPrDiffScope,
  handleReviewPrList,
  handleReviewPrSwitch,
} from "./review-diff-routes.js";
import {
  handleReviewAiProxy,
  handleReviewConfig,
  handleReviewFeedback,
  handleReviewGitAdd,
  handleReviewPrAction,
  handleReviewPrViewed,
} from "./review-route-helpers.js";
import { handleCodeNavFile, handleCodeNavResolve } from "./review-code-nav.js";
import { html, json, parseBody } from "./helpers.js";
import {
  handleDraftRequest,
  handleFavicon,
  handleImageRequest,
  handleUploadRequest,
} from "./handlers.js";
import { resolveVcsCwd } from "./vcs.js";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";

function isChecklistPayload(value: unknown): value is { checked: boolean[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "checked" in value &&
    Array.isArray(value.checked) &&
    value.checked.every((item) => typeof item === "boolean")
  );
}

function getHtmlContent(diffPayload: Record<string, unknown>): string {
  const htmlContent = diffPayload.htmlContent;
  return typeof htmlContent === "string" ? htmlContent : "";
}

async function handleTourRoutes(context: ReviewDispatchContext): Promise<boolean> {
  const { req, res, url } = context;
  if (url.pathname.match(/^\/api\/tour\/[^/]+$/) && req.method === "GET") {
    const jobId = url.pathname.slice("/api/tour/".length);
    const result = context.tour.getTour(jobId);
    if (result === null || result === undefined) {
      json(res, { error: "Tour not found" }, 404);
      return true;
    }
    json(res, result);
    return true;
  }

  const checklistMatch = url.pathname.match(/^\/api\/tour\/([^/]+)\/checklist$/);
  if (!checklistMatch || req.method !== "PUT") {
    return false;
  }

  const jobId = checklistMatch[1];
  try {
    const body = await parseBody(req);
    if (!Value.Check(context.tourChecklistSchema, body)) {
      json(res, { error: "Invalid JSON" }, 400);
      return true;
    }
    if (!isChecklistPayload(body)) {
      json(res, { error: "Invalid JSON" }, 400);
      return true;
    }
    const payload = body;
    context.tour.saveChecklist(jobId, payload.checked);
    json(res, { ok: true });
  } catch {
    json(res, { error: "Invalid JSON" }, 400);
  }
  return true;
}

async function handlePrRoutes(context: ReviewDispatchContext): Promise<boolean> {
  const { req, res, url } = context;
  if (url.pathname === "/api/pr-diff-scope" && req.method === "POST") {
    context.syncStateFromLocals();
    await handleReviewPrDiffScope(context);
    context.syncLocalsFromState();
    return true;
  }
  if (url.pathname === "/api/pr-switch" && req.method === "POST") {
    context.syncStateFromLocals();
    await handleReviewPrSwitch(context);
    context.syncLocalsFromState();
    return true;
  }
  if (url.pathname === "/api/pr-list" && req.method === "GET") {
    context.syncStateFromLocals();
    await handleReviewPrList(context);
    context.syncLocalsFromState();
    return true;
  }
  if (url.pathname === "/api/pr-context" && req.method === "GET") {
    context.syncStateFromLocals();
    await handleReviewPrContext(context);
    context.syncLocalsFromState();
    return true;
  }
  if (url.pathname === "/api/pr-action" && req.method === "POST") {
    if (
      !context.isPRModeValue ||
      !context.prMetaPresent ||
      !context.prRefPresent ||
      context.state.prMeta === undefined ||
      context.state.prRef === null
    ) {
      json(res, { error: "Not in PR mode" }, 400);
      return true;
    }
    await handleReviewPrAction({
      req,
      res,
      prMeta: context.state.prMeta,
      prRef: context.state.prRef,
      prSwitchCache: context.prSwitchCache,
      currentPRDiffScope: context.state.currentPRDiffScope,
    });
    return true;
  }
  if (url.pathname === "/api/pr-viewed" && req.method === "POST") {
    if (
      !context.isPRModeValue ||
      !context.prMetaPresent ||
      !context.prRefPresent ||
      context.state.prMeta === undefined ||
      context.state.prRef === null
    ) {
      json(res, { error: "Not in PR mode" }, 400);
      return true;
    }
    await handleReviewPrViewed({
      req,
      res,
      prMeta: context.state.prMeta,
      prRef: context.state.prRef,
    });
    return true;
  }
  return false;
}

async function handleMiscRoutes(context: ReviewDispatchContext): Promise<boolean> {
  const { req, res, url } = context;
  if (url.pathname === "/api/config" && req.method === "POST") {
    await handleReviewConfig(req, res);
    return true;
  }
  if (url.pathname === "/api/image") {
    handleImageRequest(res, url);
    return true;
  }
  if (url.pathname === "/api/upload" && req.method === "POST") {
    await handleUploadRequest(req, res);
    return true;
  }
  if (url.pathname === "/api/agents" && req.method === "GET") {
    json(res, { agents: [] });
    return true;
  }
  if (url.pathname === "/api/git-add" && req.method === "POST") {
    const stageCwd = resolveVcsCwd(context.currentDiffType, context.options.gitContext?.cwd);
    await handleReviewGitAdd({
      req,
      res,
      currentDiffType: context.currentDiffType,
      stageCwd,
      isPRMode: context.isPRModeValue,
    });
    return true;
  }
  if (url.pathname === "/api/draft") {
    await handleDraftRequest(req, res, context.draftKey);
    return true;
  }
  if (url.pathname === "/favicon.svg") {
    handleFavicon(res);
    return true;
  }
  if (url.pathname === "/api/exit" && req.method === "POST") {
    context.deleteDraft();
    context.resolveDecision({ approved: false, feedback: "", annotations: [], exit: true });
    json(res, { ok: true });
    return true;
  }
  if (url.pathname === "/api/feedback" && req.method === "POST") {
    await handleReviewFeedback({
      req,
      res,
      deleteDraft: context.deleteDraft,
      resolveDecision: context.resolveDecision,
    });
    return true;
  }
  return false;
}

async function handleCodeNavRoutes(context: ReviewDispatchContext): Promise<boolean> {
  const { req, res, url } = context;
  const hasCodeNavAccess =
    context.options.gitContext !== undefined ||
    context.options.agentCwd !== undefined ||
    context.options.worktreePool !== undefined;
  if (url.pathname === "/api/code-nav/resolve" && req.method === "POST") {
    if (!hasCodeNavAccess) {
      json(res, { error: "Code navigation requires local access" }, 400);
      return true;
    }
    await handleCodeNavResolve({
      req,
      res,
      cwd: context.resolveAgentCwd(),
      currentPatch: context.getCurrentPatch(),
    });
    return true;
  }
  if (url.pathname === "/api/code-nav/file" && req.method === "GET") {
    if (!hasCodeNavAccess) {
      json(res, { error: "Code navigation requires local access" }, 400);
      return true;
    }
    await handleCodeNavFile({ res, url, cwd: context.resolveAgentCwd() });
    return true;
  }
  return false;
}

export interface ReviewDispatchContext extends Omit<ReviewRouteContext, "req" | "res"> {
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  isPRModeValue: boolean;
  prMetaPresent: boolean;
  prRefPresent: boolean;
  sharingPayload: Record<string, unknown>;
  diffPayload: Record<string, unknown>;
  tour: {
    getTour: (jobId: string) => unknown;
    saveChecklist: (jobId: string, checked: boolean[]) => void;
  };
  tourChecklistSchema: TSchema;
  syncStateFromLocals: () => void;
  syncLocalsFromState: () => void;
  agentJobs: {
    handle: AgentJobHandlerOptions extends never
      ? never
      : (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
  };
  editorAnnotations: {
    handle: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
  };
  externalAnnotations: {
    handle: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
  };
  aiEndpoints: Record<string, (req: Request) => Promise<Response>> | null;
  resolveAgentCwd: () => string;
  getCurrentPatch: () => string;
  currentDiffType: ReviewMutableState["currentDiffType"];
  draftKey: string;
  deleteDraft: () => void;
  resolveDecision: (result: {
    approved: boolean;
    feedback: string;
    annotations: unknown[];
    agentSwitch?: string;
    exit?: boolean;
  }) => void;
}

export async function dispatchReviewServerRequest(context: ReviewDispatchContext): Promise<void> {
  const { req, res, url } = context;
  if (await handleTourRoutes(context)) return;

  if (url.pathname === "/api/diff" && req.method === "GET") {
    json(res, { ...context.diffPayload, ...context.sharingPayload });
    return;
  }
  if (url.pathname === "/api/diff/switch" && req.method === "POST") {
    context.syncStateFromLocals();
    await handleReviewDiffSwitch(context);
    context.syncLocalsFromState();
    return;
  }
  if (await handlePrRoutes(context)) return;
  if (url.pathname === "/api/file-content" && req.method === "GET") {
    context.syncStateFromLocals();
    await handleReviewFileContent(context);
    context.syncLocalsFromState();
    return;
  }
  if (await handleCodeNavRoutes(context)) return;
  if (await handleMiscRoutes(context)) return;
  if (await context.editorAnnotations.handle(req, res, url)) {
    return;
  }
  if (await context.externalAnnotations.handle(req, res, url)) {
    return;
  }
  if (await context.agentJobs.handle(req, res, url)) {
    return;
  }
  if (context.aiEndpoints !== null && url.pathname.startsWith("/api/ai/")) {
    const handler = context.aiEndpoints[url.pathname];
    if (handler !== undefined) {
      await handleReviewAiProxy({ req, res, handler });
      return;
    }
    json(res, { error: "Not found" }, 404);
    return;
  }
  html(res, getHtmlContent(context.diffPayload));
}
