import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArchivedPlan } from "../generated/storage.js";
import {
  getPlanVersion,
  getPlanVersionPath,
  listArchivedPlans,
  listVersions,
  readArchivedPlan,
  saveAnnotations,
  saveFinalSnapshot,
} from "../generated/storage.js";
import {
  handleDocExistsRequest,
  handleDocRequest,
  handleFileBrowserRequest,
  handleObsidianDocRequest,
  handleObsidianFilesRequest,
  handleObsidianVaultsRequest,
} from "./reference.js";
import { deleteDraft } from "../generated/draft.js";
import {
  handleDraftRequest,
  handleFavicon,
  handleImageRequest,
  handleUploadRequest,
} from "./handlers.js";
import { json, parseBody } from "./helpers.js";
import { openEditorDiff } from "./ide.js";
import {
  saveToBear,
  saveToObsidian,
  saveToOctarine,
  type IntegrationResult,
} from "./integrations.js";
import { getServerConfig, type detectGitUser } from "../generated/config.js";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { errorMessage } from "../../../utils/error-message.js";

const VersionDiffRequestSchema = Type.Object({ baseVersion: Type.Number() });
const PlanSaveSchema = Type.Object({
  enabled: Type.Boolean(),
  customPath: Type.Optional(Type.String()),
});
const SaveNotesRequestSchema = Type.Object({
  obsidian: Type.Optional(Type.Unknown()),
  bear: Type.Optional(Type.Unknown()),
  octarine: Type.Optional(Type.Unknown()),
});
const ObsidianConfigSchema = Type.Object({
  vaultPath: Type.String(),
  folder: Type.String(),
  plan: Type.String(),
  filenameFormat: Type.Optional(Type.String()),
  filenameSeparator: Type.Optional(
    Type.Union([Type.Literal("space"), Type.Literal("dash"), Type.Literal("underscore")]),
  ),
});
const BearConfigSchema = Type.Object({
  plan: Type.String(),
  customTags: Type.Optional(Type.String()),
  tagPosition: Type.Optional(Type.Union([Type.Literal("append"), Type.Literal("prepend")])),
});
const OctarineConfigSchema = Type.Object({
  plan: Type.String(),
  workspace: Type.String(),
  folder: Type.String(),
});
const ApproveRequestSchema = Type.Object({
  feedback: Type.Optional(Type.String()),
  agentSwitch: Type.Optional(Type.String()),
  permissionMode: Type.Optional(Type.String()),
  planSave: Type.Optional(PlanSaveSchema),
  obsidian: Type.Optional(Type.Unknown()),
  bear: Type.Optional(Type.Unknown()),
  octarine: Type.Optional(Type.Unknown()),
});
const DenyRequestSchema = Type.Object({
  feedback: Type.Optional(Type.String()),
  planSave: Type.Optional(PlanSaveSchema),
});

export type PlanServerSetup = {
  archivePlans: ArchivedPlan[];
  initialArchivePlan: string;
  donePromise?: Promise<void>;
  resolveDone?: () => void;
  repoInfo: { display: string; branch?: string } | null;
  slug: string;
  project: string;
  historyResult: { version: number; path: string; isNew: boolean };
  previousPlan: string | null;
  versionInfo: { version: number; totalVersions: number; project: string } | null;
  draftKey: string;
  editorAnnotations: {
    handle: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
  } | null;
  externalAnnotations: {
    handle: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
  } | null;
};

export type PlanReviewDecision = {
  approved: boolean;
  feedback?: string;
  savedPath?: string;
  agentSwitch?: string;
  permissionMode?: string;
};

async function runNoteIntegrations(body: Record<string, unknown>): Promise<{
  obsidian?: IntegrationResult;
  bear?: IntegrationResult;
  octarine?: IntegrationResult;
}> {
  const results: {
    obsidian?: IntegrationResult;
    bear?: IntegrationResult;
    octarine?: IntegrationResult;
  } = {};
  const promises: Promise<void>[] = [];
  const obsConfig = Value.Check(ObsidianConfigSchema, body.obsidian)
    ? Value.Parse(ObsidianConfigSchema, body.obsidian)
    : undefined;
  const bearConfig = Value.Check(BearConfigSchema, body.bear)
    ? Value.Parse(BearConfigSchema, body.bear)
    : undefined;
  const octConfig = Value.Check(OctarineConfigSchema, body.octarine)
    ? Value.Parse(OctarineConfigSchema, body.octarine)
    : undefined;
  if (obsConfig !== undefined && obsConfig.vaultPath.length > 0 && obsConfig.plan.length > 0)
    promises.push(
      saveToObsidian(obsConfig).then((r) => {
        results.obsidian = r;
      }),
    );
  if (bearConfig !== undefined && bearConfig.plan.length > 0)
    promises.push(
      saveToBear(bearConfig).then((r) => {
        results.bear = r;
      }),
    );
  if (octConfig !== undefined && octConfig.plan.length > 0 && octConfig.workspace.length > 0)
    promises.push(
      saveToOctarine(octConfig).then((r) => {
        results.octarine = r;
      }),
    );
  await Promise.allSettled(promises);
  return results;
}

function handlePlanArchiveRoutes(args: Parameters<typeof handlePlanServerRequest>[0]): boolean {
  const { req, res, url, cachedArchivePlans, setCachedArchivePlans } = args;
  if (url.pathname === "/api/archive/plans" && req.method === "GET") {
    const customPath = url.searchParams.get("customPath") ?? undefined;
    const plans = cachedArchivePlans ?? listArchivedPlans(customPath);
    setCachedArchivePlans(plans);
    json(res, { plans });
    return true;
  }
  if (url.pathname === "/api/archive/plan" && req.method === "GET") {
    const filename = url.searchParams.get("filename");
    const customPath = url.searchParams.get("customPath") ?? undefined;
    if (filename === null || filename.length === 0) {
      json(res, { error: "Missing filename" }, 400);
      return true;
    }
    const markdown = readArchivedPlan(filename, customPath);
    if (markdown === null) {
      json(res, { error: "Not found" }, 404);
      return true;
    }
    json(res, { markdown, filepath: filename });
    return true;
  }
  return false;
}

function handlePlanVersionRoutes(args: Parameters<typeof handlePlanServerRequest>[0]): boolean {
  const { res, url, setup } = args;
  if (url.pathname === "/api/plan/version") {
    const vParam = url.searchParams.get("v");
    if (vParam === null || vParam.length === 0) {
      json(res, { error: "Missing v parameter" }, 400);
      return true;
    }
    const v = parseInt(vParam, 10);
    if (Number.isNaN(v) || v < 1) {
      json(res, { error: "Invalid version number" }, 400);
      return true;
    }
    const content = getPlanVersion(setup.project, setup.slug, v);
    if (content === null) {
      json(res, { error: "Version not found" }, 404);
      return true;
    }
    json(res, { plan: content, version: v });
    return true;
  }
  if (url.pathname === "/api/plan/versions") {
    json(res, {
      project: setup.project,
      slug: setup.slug,
      versions: listVersions(setup.project, setup.slug),
    });
    return true;
  }
  return false;
}

function handlePlanPayloadRoute(args: Parameters<typeof handlePlanServerRequest>[0]): boolean {
  const { res, url, options, setup, gitUser, sharingEnabled, shareBaseUrl, pasteApiUrl } = args;
  if (url.pathname !== "/api/plan") return false;
  if (options.mode === "archive") {
    json(res, {
      plan: setup.initialArchivePlan,
      origin: options.origin ?? "pi",
      mode: "archive",
      archivePlans: setup.archivePlans,
      sharingEnabled,
      shareBaseUrl,
      serverConfig: getServerConfig(gitUser),
    });
    return true;
  }
  json(res, {
    plan: options.plan,
    origin: options.origin ?? "pi",
    permissionMode: options.permissionMode,
    previousPlan: setup.previousPlan,
    versionInfo: setup.versionInfo,
    sharingEnabled,
    shareBaseUrl,
    pasteApiUrl,
    repoInfo: setup.repoInfo,
    projectRoot: process.cwd(),
    serverConfig: getServerConfig(gitUser),
  });
  return true;
}

async function handlePlanUtilityRoutes(
  args: Parameters<typeof handlePlanServerRequest>[0],
): Promise<boolean> {
  const { req, res, url, setup } = args;
  if (url.pathname === "/api/config" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const toSave: Record<string, unknown> = {};
      if (typeof body.displayName === "string") toSave.displayName = body.displayName;
      if (typeof body.diffOptions === "object" && body.diffOptions !== null)
        toSave.diffOptions = body.diffOptions;
      if (typeof body.conventionalComments === "boolean")
        toSave.conventionalComments = body.conventionalComments;
      void toSave;
      json(res, { ok: true });
    } catch {
      json(res, { error: "Invalid request" }, 400);
    }
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
  if (url.pathname === "/api/draft") {
    await handleDraftRequest(req, res, setup.draftKey);
    return true;
  }
  if (setup.editorAnnotations !== null && (await setup.editorAnnotations.handle(req, res, url)))
    return true;
  if (setup.externalAnnotations !== null && (await setup.externalAnnotations.handle(req, res, url)))
    return true;
  if (url.pathname === "/api/doc" && req.method === "GET") {
    await handleDocRequest(res, url);
    return true;
  }
  if (url.pathname === "/api/doc/exists" && req.method === "POST") {
    await handleDocExistsRequest(res, req);
    return true;
  }
  if (url.pathname === "/api/obsidian/vaults") {
    handleObsidianVaultsRequest(res);
    return true;
  }
  if (url.pathname === "/api/reference/obsidian/files" && req.method === "GET") {
    handleObsidianFilesRequest(res, url);
    return true;
  }
  if (url.pathname === "/api/reference/obsidian/doc" && req.method === "GET") {
    handleObsidianDocRequest(res, url);
    return true;
  }
  if (url.pathname === "/api/reference/files" && req.method === "GET") {
    handleFileBrowserRequest(res, url);
    return true;
  }
  if (url.pathname === "/api/agents" && req.method === "GET") {
    json(res, { agents: [] });
    return true;
  }
  if (url.pathname === "/favicon.svg") {
    handleFavicon(res);
    return true;
  }
  return false;
}

async function handlePlanMutationRoutes(
  args: Parameters<typeof handlePlanServerRequest>[0],
): Promise<boolean> {
  const { req, res, url, setup, options, decisionSettled, publishDecision } = args;
  if (url.pathname === "/api/plan/vscode-diff" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      if (!Value.Check(VersionDiffRequestSchema, body)) {
        json(res, { error: "Missing baseVersion" }, 400);
        return true;
      }
      const basePath = getPlanVersionPath(setup.project, setup.slug, body.baseVersion);
      if (basePath === null) {
        json(res, { error: `Version ${body.baseVersion} not found` }, 404);
        return true;
      }
      const diffResult = await openEditorDiff(basePath, setup.historyResult.path);
      if ("error" in diffResult) {
        json(res, { error: diffResult.error }, 500);
        return true;
      }
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: errorMessage(err) }, 500);
    }
    return true;
  }
  if (url.pathname === "/api/save-notes" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      if (!Value.Check(SaveNotesRequestSchema, body)) {
        json(res, { error: "Save failed" }, 400);
        return true;
      }
      const results = await runNoteIntegrations(body);
      json(res, { ok: true, results });
    } catch {
      json(res, { error: "Save failed" }, 500);
    }
    return true;
  }
  if (url.pathname === "/api/approve" && req.method === "POST") {
    if (decisionSettled) {
      json(res, { ok: true, duplicate: true });
      return true;
    }
    let feedback: string | undefined;
    let agentSwitch: string | undefined;
    let requestedPermissionMode: string | undefined;
    let planSaveEnabled = true;
    let planSaveCustomPath: string | undefined;
    try {
      const body = await parseBody(req);
      if (Value.Check(ApproveRequestSchema, body)) {
        feedback = body.feedback;
        agentSwitch = body.agentSwitch;
        requestedPermissionMode = body.permissionMode;
        if (body.planSave !== undefined) {
          planSaveEnabled = body.planSave.enabled;
          planSaveCustomPath = body.planSave.customPath;
        }
        await runNoteIntegrations(body);
      }
    } catch {}
    let savedPath: string | undefined;
    if (planSaveEnabled) {
      const annotations = feedback ?? "";
      if (annotations.length > 0) saveAnnotations(setup.slug, annotations, planSaveCustomPath);
      savedPath = saveFinalSnapshot(
        setup.slug,
        "approved",
        options.plan,
        annotations,
        planSaveCustomPath,
      );
    }
    deleteDraft(setup.draftKey);
    publishDecision({
      approved: true,
      feedback,
      savedPath,
      agentSwitch,
      permissionMode: requestedPermissionMode ?? options.permissionMode,
    });
    json(res, { ok: true, savedPath });
    return true;
  }
  if (url.pathname === "/api/deny" && req.method === "POST") {
    if (decisionSettled) {
      json(res, { ok: true, duplicate: true });
      return true;
    }
    let feedback = "Plan rejected by user";
    let planSaveEnabled = true;
    let planSaveCustomPath: string | undefined;
    try {
      const body = await parseBody(req);
      if (Value.Check(DenyRequestSchema, body)) {
        feedback = body.feedback ?? feedback;
        if (body.planSave !== undefined) {
          planSaveEnabled = body.planSave.enabled;
          planSaveCustomPath = body.planSave.customPath;
        }
      }
    } catch {}
    let savedPath: string | undefined;
    if (planSaveEnabled) {
      saveAnnotations(setup.slug, feedback, planSaveCustomPath);
      savedPath = saveFinalSnapshot(
        setup.slug,
        "denied",
        options.plan,
        feedback,
        planSaveCustomPath,
      );
    }
    deleteDraft(setup.draftKey);
    publishDecision({ approved: false, feedback, savedPath });
    json(res, { ok: true, savedPath });
    return true;
  }
  return false;
}

export async function handlePlanServerRequest(args: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  options: {
    plan: string;
    origin?: string;
    permissionMode?: string;
    mode?: "archive";
    htmlContent: string;
  };
  setup: PlanServerSetup;
  gitUser: ReturnType<typeof detectGitUser>;
  sharingEnabled: boolean;
  shareBaseUrl: string | undefined;
  pasteApiUrl: string | undefined;
  cachedArchivePlans: ArchivedPlan[] | null;
  setCachedArchivePlans: (plans: ArchivedPlan[] | null) => void;
  decisionSettled: boolean;
  publishDecision: (result: PlanReviewDecision) => boolean;
}): Promise<boolean> {
  const { req, res, url, setup } = args;
  if (url.pathname === "/api/done" && req.method === "POST") {
    setup.resolveDone?.();
    json(res, { ok: true });
    return true;
  }
  if (handlePlanArchiveRoutes(args)) return true;
  if (handlePlanVersionRoutes(args)) return true;
  if (handlePlanPayloadRoute(args)) return true;
  if (await handlePlanUtilityRoutes(args)) return true;
  if (await handlePlanMutationRoutes(args)) return true;
  return false;
}
