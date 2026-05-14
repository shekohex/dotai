import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve as resolvePath } from "node:path";

import { contentHash, deleteDraft } from "../generated/draft.js";
import { saveConfig, detectGitUser, getServerConfig } from "../generated/config.js";

import {
  handleDraftRequest,
  handleFavicon,
  handleImageRequest,
  handleUploadRequest,
} from "./handlers.js";
import { html, json, parseBody, requestUrl } from "./helpers.js";

import { listenOnPort } from "./network.js";

import { getRepoInfo } from "./project.js";
import {
  handleDocRequest,
  handleDocExistsRequest,
  handleFileBrowserRequest,
  handleObsidianVaultsRequest,
  handleObsidianFilesRequest,
  handleObsidianDocRequest,
} from "./reference.js";
import { warmFileListCache } from "../generated/resolve-file.js";
import { createExternalAnnotationHandler } from "./external-annotations.js";

export interface AnnotateServerResult {
  port: number;
  portSource: "env" | "remote-default" | "random";
  url: string;
  waitForDecision: () => Promise<{
    feedback: string;
    annotations: unknown[];
    exit?: boolean;
    approved?: boolean;
  }>;
  stop: () => void;
}

type AnnotateDecision = {
  feedback: string;
  annotations: unknown[];
  exit?: boolean;
  approved?: boolean;
};

function getAnnotateDraftSource(options: {
  mode?: string;
  folderPath?: string;
  renderHtml?: boolean;
  rawHtml?: string;
  markdown: string;
}): string {
  if (
    options.mode === "annotate-folder" &&
    options.folderPath !== undefined &&
    options.folderPath.length > 0
  ) {
    return `folder:${resolvePath(options.folderPath)}`;
  }
  if (options.renderHtml === true && options.rawHtml !== undefined) {
    return options.rawHtml;
  }
  return options.markdown;
}

function getAnnotatePlanPayload(options: {
  markdown: string;
  origin?: string;
  mode?: string;
  filePath: string;
  sourceInfo?: string;
  sourceConverted?: boolean;
  gate?: boolean;
  rawHtml?: string;
  renderHtml?: boolean;
  sharingEnabled: boolean;
  shareBaseUrl?: string;
  pasteApiUrl?: string;
  repoInfo: ReturnType<typeof getRepoInfo>;
  folderPath?: string;
  gitUser: ReturnType<typeof detectGitUser>;
}): Record<string, unknown> {
  return {
    plan: options.markdown,
    origin: options.origin ?? "pi",
    mode: options.mode ?? "annotate",
    filePath: options.filePath,
    sourceInfo: options.sourceInfo,
    sourceConverted: options.sourceConverted ?? false,
    gate: options.gate ?? false,
    renderAs: options.renderHtml === true && options.rawHtml !== undefined ? "html" : "markdown",
    ...(options.renderHtml === true && options.rawHtml !== undefined
      ? { rawHtml: options.rawHtml }
      : {}),
    sharingEnabled: options.sharingEnabled,
    shareBaseUrl: options.shareBaseUrl,
    pasteApiUrl: options.pasteApiUrl,
    repoInfo: options.repoInfo,
    projectRoot: options.folderPath ?? process.cwd(),
    serverConfig: getServerConfig(options.gitUser),
  };
}

async function saveAnnotateConfig(req: IncomingMessage): Promise<Record<string, unknown> | null> {
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
    if (Object.keys(toSave).length > 0) saveConfig(toSave as Parameters<typeof saveConfig>[0]);
    return { ok: true };
  } catch {
    return null;
  }
}

function createAnnotateRequestHandler(options: {
  markdown: string;
  filePath: string;
  htmlContent: string;
  origin?: string;
  mode?: string;
  folderPath?: string;
  sourceInfo?: string;
  sourceConverted?: boolean;
  gate?: boolean;
  rawHtml?: string;
  renderHtml?: boolean;
  sharingEnabled: boolean;
  shareBaseUrl?: string;
  pasteApiUrl?: string;
  gitUser: ReturnType<typeof detectGitUser>;
  repoInfo: ReturnType<typeof getRepoInfo>;
  draftKey: string;
  externalAnnotations: ReturnType<typeof createExternalAnnotationHandler>;
  resolveDecision: (result: AnnotateDecision) => void;
}) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const url = requestUrl(req);
      if (await options.externalAnnotations.handle(req, res, url)) return;

      if (url.pathname === "/api/plan" && req.method === "GET") {
        json(res, getAnnotatePlanPayload(options));
        return;
      }

      if (url.pathname === "/api/config" && req.method === "POST") {
        const result = await saveAnnotateConfig(req);
        if (result === null) {
          json(res, { error: "Invalid request" }, 400);
        } else {
          json(res, { ok: true });
        }
        return;
      }

      if (url.pathname === "/api/image") {
        handleImageRequest(res, url);
        return;
      }
      if (url.pathname === "/api/upload" && req.method === "POST") {
        await handleUploadRequest(req, res);
        return;
      }
      if (url.pathname === "/api/draft") {
        await handleDraftRequest(req, res, options.draftKey);
        return;
      }
      if (url.pathname === "/api/doc" && req.method === "GET") {
        if (
          !url.searchParams.has("base") &&
          options.filePath.length > 0 &&
          !/^https?:\/\//i.test(options.filePath)
        ) {
          url.searchParams.set("base", dirname(resolvePath(options.filePath)));
        }
        await handleDocRequest(res, url);
        return;
      }
      if (url.pathname === "/api/doc/exists" && req.method === "POST") {
        await handleDocExistsRequest(res, req);
        return;
      }
      if (url.pathname === "/api/obsidian/vaults") {
        handleObsidianVaultsRequest(res);
        return;
      }
      if (url.pathname === "/api/reference/obsidian/files" && req.method === "GET") {
        handleObsidianFilesRequest(res, url);
        return;
      }
      if (url.pathname === "/api/reference/obsidian/doc" && req.method === "GET") {
        handleObsidianDocRequest(res, url);
        return;
      }
      if (url.pathname === "/api/reference/files" && req.method === "GET") {
        handleFileBrowserRequest(res, url);
        return;
      }
      if (url.pathname === "/favicon.svg") {
        handleFavicon(res);
        return;
      }
      if (url.pathname === "/api/exit" && req.method === "POST") {
        deleteDraft(options.draftKey);
        options.resolveDecision({ feedback: "", annotations: [], exit: true });
        json(res, { ok: true });
        return;
      }
      if (url.pathname === "/api/approve" && req.method === "POST") {
        deleteDraft(options.draftKey);
        options.resolveDecision({ feedback: "", annotations: [], approved: true });
        json(res, { ok: true });
        return;
      }
      if (url.pathname === "/api/feedback" && req.method === "POST") {
        try {
          const body = await parseBody(req);
          deleteDraft(options.draftKey);
          const feedback = typeof body.feedback === "string" ? body.feedback : "";
          const annotations = Array.isArray(body.annotations) ? body.annotations : [];
          options.resolveDecision({ feedback, annotations });
          json(res, { ok: true });
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : "Failed to process feedback";
          json(res, { error: message }, 500);
          return;
        }
      }

      html(res, options.htmlContent, req);
    })();
  };
}

export async function startAnnotateServer(options: {
  markdown: string;
  filePath: string;
  htmlContent: string;
  origin?: string;
  mode?: string;
  folderPath?: string;
  sharingEnabled?: boolean;
  shareBaseUrl?: string;
  pasteApiUrl?: string;
  sourceInfo?: string;
  sourceConverted?: boolean;
  gate?: boolean;
  rawHtml?: string;
  renderHtml?: boolean;
}): Promise<AnnotateServerResult> {
  // Side-channel pre-warm so /api/doc/exists POSTs land on warm cache.
  void warmFileListCache(process.cwd(), "code");
  const gitUser = detectGitUser();
  const sharingEnabled = options.sharingEnabled ?? process.env.PLANNOTATOR_SHARE !== "disabled";
  const shareBaseUrl = options.shareBaseUrl ?? process.env.PLANNOTATOR_SHARE_URL ?? undefined;
  const pasteApiUrl = options.pasteApiUrl ?? process.env.PLANNOTATOR_PASTE_URL ?? undefined;

  let resolveDecision!: (result: AnnotateDecision) => void;
  const decisionPromise = new Promise<AnnotateDecision>((r) => {
    resolveDecision = r;
  });

  // Folder annotation has no stable markdown body, so key drafts by folder path instead.
  const draftSource = getAnnotateDraftSource(options);
  const draftKey = contentHash(draftSource);

  // Detect repo info (cached for this session)
  const repoInfo = getRepoInfo();

  const externalAnnotations = createExternalAnnotationHandler("plan");

  const server = createServer(
    createAnnotateRequestHandler({
      ...options,
      sharingEnabled,
      shareBaseUrl,
      pasteApiUrl,
      gitUser,
      repoInfo,
      draftKey,
      externalAnnotations,
      resolveDecision,
    }),
  );

  const { port, portSource } = await listenOnPort(server);

  return {
    port,
    portSource,
    url: `http://localhost:${port}`,
    waitForDecision: () => decisionPromise,
    stop: () => server.close(),
  };
}
