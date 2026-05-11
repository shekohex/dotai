import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { contentHash } from "../generated/draft.js";
import {
  type ArchivedPlan,
  generateSlug,
  getPlanVersion,
  getVersionCount,
  listArchivedPlans,
  readArchivedPlan,
  saveToHistory,
} from "../generated/storage.js";
import { createEditorAnnotationHandler } from "./annotations.js";
import { createExternalAnnotationHandler } from "./external-annotations.js";
import { html, json, parseBody, requestUrl } from "./helpers.js";
import { listenOnPort } from "./network.js";

import { saveConfig, detectGitUser } from "../generated/config.js";
import { detectProjectName, getRepoInfo } from "./project.js";
import { warmFileListCache } from "../generated/resolve-file.js";
import {
  handlePlanServerRequest,
  type PlanReviewDecision,
  type PlanServerSetup,
} from "./plan-review-helpers.js";

export interface PlanServerResult {
  reviewId: string;
  port: number;
  portSource: "env" | "remote-default" | "random";
  url: string;
  waitForDecision: () => Promise<PlanReviewDecision>;
  onDecision: (listener: (result: PlanReviewDecision) => void | Promise<void>) => () => void;
  waitForDone?: () => Promise<void>;
  stop: () => void;
}

function createPlanServerSetup(options: {
  plan: string;
  mode?: "archive";
  customPlanPath?: string | null;
}): PlanServerSetup {
  let archivePlans: ArchivedPlan[] = [];
  let initialArchivePlan = "";
  let resolveDone: (() => void) | undefined;
  let donePromise: Promise<void> | undefined;

  if (options.mode === "archive") {
    archivePlans = listArchivedPlans(options.customPlanPath ?? undefined);
    initialArchivePlan =
      archivePlans.length > 0
        ? (readArchivedPlan(archivePlans[0].filename, options.customPlanPath ?? undefined) ?? "")
        : "";
    donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
  }

  const isArchiveMode = options.mode === "archive";
  const repoInfo = isArchiveMode ? null : getRepoInfo();
  const slug = isArchiveMode ? "" : generateSlug(options.plan);
  const project = isArchiveMode ? "" : detectProjectName();
  const historyResult = isArchiveMode
    ? { version: 0, path: "", isNew: false }
    : saveToHistory(project, slug, options.plan);
  const previousPlan =
    isArchiveMode || historyResult.version <= 1
      ? null
      : getPlanVersion(project, slug, historyResult.version - 1);
  const versionInfo = isArchiveMode
    ? null
    : { version: historyResult.version, totalVersions: getVersionCount(project, slug), project };
  const draftKey = isArchiveMode ? "" : contentHash(options.plan);

  return {
    archivePlans,
    initialArchivePlan,
    donePromise,
    resolveDone,
    repoInfo,
    slug,
    project,
    historyResult,
    previousPlan,
    versionInfo,
    draftKey,
    editorAnnotations: isArchiveMode ? null : createEditorAnnotationHandler(),
    externalAnnotations: isArchiveMode ? null : createExternalAnnotationHandler("plan"),
  };
}

export async function startPlanReviewServer(options: {
  plan: string;
  htmlContent: string;
  origin?: string;
  permissionMode?: string;
  sharingEnabled?: boolean;
  shareBaseUrl?: string;
  pasteApiUrl?: string;
  mode?: "archive";
  customPlanPath?: string | null;
}): Promise<PlanServerResult> {
  // Side-channel pre-warm so /api/doc/exists POSTs land on warm cache.
  void warmFileListCache(process.cwd(), "code");
  const gitUser = detectGitUser();
  const sharingEnabled = options.sharingEnabled ?? process.env.PLANNOTATOR_SHARE !== "disabled";
  const shareBaseUrl = options.shareBaseUrl ?? process.env.PLANNOTATOR_SHARE_URL ?? undefined;
  const pasteApiUrl = options.pasteApiUrl ?? process.env.PLANNOTATOR_PASTE_URL ?? undefined;
  const setup = createPlanServerSetup({
    plan: options.plan,
    mode: options.mode,
    customPlanPath: options.customPlanPath,
  });

  const reviewId = randomUUID();
  let resolveDecision!: (result: PlanReviewDecision) => void;
  const decisionListeners = new Set<(result: PlanReviewDecision) => void | Promise<void>>();
  let decisionSettled = false;
  const decisionPromise = new Promise<PlanReviewDecision>((r) => {
    resolveDecision = r;
  });
  const publishDecision = (result: PlanReviewDecision): boolean => {
    if (decisionSettled) return false;
    decisionSettled = true;
    resolveDecision(result);
    for (const listener of decisionListeners) {
      Promise.resolve(listener(result)).catch((error) => {
        console.error("[Plan Review] Decision listener failed:", error);
      });
    }
    return true;
  };

  // Lazy cache for in-session archive tab
  let cachedArchivePlans: ArchivedPlan[] | null = null;

  const server = createServer((req, res) => {
    void (async () => {
      const url = requestUrl(req);
      if (
        await handlePlanServerRequest({
          req,
          res,
          url,
          options,
          setup,
          gitUser,
          sharingEnabled,
          shareBaseUrl,
          pasteApiUrl,
          cachedArchivePlans,
          setCachedArchivePlans: (plans) => {
            cachedArchivePlans = plans;
          },
          decisionSettled,
          publishDecision,
        })
      ) {
        return;
      }

      if (url.pathname === "/api/config" && req.method === "POST") {
        try {
          const body = (await parseBody(req)) as {
            displayName?: string;
            diffOptions?: Record<string, unknown>;
            conventionalComments?: boolean;
          };
          const toSave: Record<string, unknown> = {};
          if (body.displayName !== undefined) toSave.displayName = body.displayName;
          if (body.diffOptions !== undefined) toSave.diffOptions = body.diffOptions;
          if (body.conventionalComments !== undefined)
            toSave.conventionalComments = body.conventionalComments;
          if (Object.keys(toSave).length > 0)
            saveConfig(toSave as Parameters<typeof saveConfig>[0]);
          json(res, { ok: true });
        } catch {
          json(res, { error: "Invalid request" }, 400);
        }
      } else {
        html(res, options.htmlContent);
      }
    })();
  });

  const { port, portSource } = await listenOnPort(server);

  const result: PlanServerResult = {
    reviewId,
    port,
    portSource,
    url: `http://localhost:${port}`,
    waitForDecision: () => decisionPromise,
    onDecision: (listener) => {
      decisionListeners.add(listener);
      return () => {
        decisionListeners.delete(listener);
      };
    },
    stop: () => server.close(),
  };
  if (setup.donePromise !== undefined) {
    result.waitForDone = () => Promise.resolve(setup.donePromise);
  }
  return result;
}
