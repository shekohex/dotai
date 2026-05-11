import type { IncomingMessage, ServerResponse } from "node:http";

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { contentHash } from "../generated/draft.js";
import type { PRListItem, PRMetadata, PRStackTree } from "../generated/pr-provider.js";
import {
  getDisplayRepo,
  getMRLabel,
  getMRNumberLabel,
  isSameProject,
  prRefFromMetadata,
} from "../generated/pr-provider.js";
import type { DiffType, GitContext } from "../generated/review-core.js";
import {
  getFileContentsForDiff as getFileContentsForDiffCore,
  resolveBaseBranch,
  validateFilePath,
} from "../generated/review-core.js";
import type { PRDiffScope } from "../generated/pr-stack.js";
import {
  checkoutPRHead,
  getPRDiffScopeOptions,
  getPRStackInfo,
  resolvePRFullStackBaseRef,
  resolveStackInfo,
  runPRFullStackDiff,
} from "../generated/pr-stack.js";
import type { WorktreePool } from "../generated/worktree-pool.js";
import { errorMessage } from "../../../utils/error-message.js";
import { json, parseBody } from "./helpers.js";
import {
  fetchPR,
  fetchPRContext,
  fetchPRFileContent,
  fetchPRList,
  fetchPRStack,
  fetchPRViewedFiles,
  parsePRUrl,
} from "./pr.js";
import {
  getVcsContext,
  getVcsFileContentsForDiff,
  resolveVcsCwd,
  reviewRuntime,
  runVcsDiff,
} from "./vcs.js";

const DiffSwitchSchema = Type.Object({
  diffType: Type.String(),
  hideWhitespace: Type.Optional(Type.Boolean()),
  base: Type.Optional(Type.String()),
});

const PrDiffScopeSchema = Type.Object({
  scope: Type.Union([Type.Literal("layer"), Type.Literal("full-stack")]),
});

const PrSwitchSchema = Type.Object({
  url: Type.String(),
});

type DiffSwitchBody = Static<typeof DiffSwitchSchema>;
type PrDiffScopeBody = Static<typeof PrDiffScopeSchema>;
type PrSwitchBody = Static<typeof PrSwitchSchema>;

function isDiffType(value: string): value is DiffType {
  return (
    value === "uncommitted" ||
    value === "staged" ||
    value === "unstaged" ||
    value === "last-commit" ||
    value === "jj-current" ||
    value === "jj-last" ||
    value === "jj-line" ||
    value === "jj-all" ||
    value === "branch" ||
    value === "merge-base" ||
    value === "all" ||
    value === "p4-default" ||
    value.startsWith("worktree:") ||
    value.startsWith("p4-changelist:")
  );
}

export interface ReviewMutableState {
  currentPatch: string;
  currentGitRef: string;
  currentDiffType: DiffType;
  currentError: string | undefined;
  currentHideWhitespace: boolean;
  currentBase: string;
  baseEverSwitched: boolean;
  originalPRPatch: string;
  originalPRGitRef: string;
  originalPRError: string | undefined;
  currentPRDiffScope: PRDiffScope;
  draftKey: string;
  prMeta: PRMetadata | undefined;
  prRef: ReturnType<typeof prRefFromMetadata> | null;
  prStackInfo: ReturnType<typeof getPRStackInfo> | null;
  prStackTree: PRStackTree | null;
  prDiffScopeOptions: ReturnType<typeof getPRDiffScopeOptions>;
  prListCache: PRListItem[] | null;
  prListCacheTime: number;
  initialViewedFiles: string[];
  repoInfo: { display: string; branch?: string } | null;
}

export interface ReviewRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  state: ReviewMutableState;
  hasLocalAccess: boolean;
  isPRMode: () => boolean;
  detectedCompareTarget: () => string;
  options: {
    gitContext?: GitContext;
    agentCwd?: string;
    worktreePool?: WorktreePool;
  };
  sessionVcsType: GitContext["vcsType"] | undefined;
  prSwitchCache: Map<string, { metadata: PRMetadata; rawPatch: string }>;
  prStackTreeCache: Map<string, PRStackTree | null>;
}

export function handleReviewDiff(context: ReviewRouteContext): void {
  json(context.res, {
    rawPatch: context.state.currentPatch,
    gitRef: context.state.currentGitRef,
    origin: "pi",
    diffType: context.hasLocalAccess ? context.state.currentDiffType : undefined,
    base: context.hasLocalAccess ? context.state.currentBase : undefined,
    hideWhitespace: context.state.currentHideWhitespace,
    gitContext: context.hasLocalAccess ? context.options.gitContext : undefined,
    repoInfo: context.state.repoInfo,
    ...(context.options.agentCwd !== undefined && context.options.agentCwd.length > 0
      ? { agentCwd: context.options.agentCwd }
      : {}),
    ...(context.isPRMode()
      ? {
          prMetadata: context.state.prMeta,
          prStackInfo: context.state.prStackInfo,
          prStackTree: context.state.prStackTree,
          prDiffScope: context.state.currentPRDiffScope,
          prDiffScopeOptions: context.state.prDiffScopeOptions,
        }
      : {}),
    ...(context.isPRMode() && context.state.initialViewedFiles.length > 0
      ? { viewedFiles: context.state.initialViewedFiles }
      : {}),
    ...(context.state.currentError !== undefined && context.state.currentError.length > 0
      ? { error: context.state.currentError }
      : {}),
  });
}

export async function handleReviewDiffSwitch(context: ReviewRouteContext): Promise<void> {
  if (!context.hasLocalAccess) {
    json(context.res, { error: "Not available without local file access" }, 400);
    return;
  }
  try {
    const body = await parseBody(context.req);
    if (!Value.Check(DiffSwitchSchema, body)) {
      json(context.res, { error: "Invalid request" }, 400);
      return;
    }
    const payload: DiffSwitchBody = body;
    if (!isDiffType(payload.diffType)) {
      json(context.res, { error: "Invalid diffType" }, 400);
      return;
    }
    const newType = payload.diffType;
    context.state.currentHideWhitespace =
      payload.hideWhitespace ?? context.state.currentHideWhitespace;
    const base = resolveBaseBranch(payload.base, context.detectedCompareTarget());
    const result = await runVcsDiff(newType, base, context.options.gitContext?.cwd, {
      hideWhitespace: context.state.currentHideWhitespace,
    });
    context.state.currentPatch = result.patch;
    context.state.currentGitRef = result.label;
    context.state.currentDiffType = newType;
    context.state.currentBase = base;
    context.state.baseEverSwitched = true;
    context.state.currentError = result.error;

    let updatedContext: GitContext | undefined;
    if (context.options.gitContext !== undefined) {
      try {
        const effectiveCwd = resolveVcsCwd(newType, context.options.gitContext.cwd);
        updatedContext = await getVcsContext(effectiveCwd, context.sessionVcsType);
      } catch {}
    }

    const responsePayload = {
      rawPatch: context.state.currentPatch,
      gitRef: context.state.currentGitRef,
      diffType: context.state.currentDiffType,
      base: context.state.currentBase,
      hideWhitespace: context.state.currentHideWhitespace,
      ...(typeof context.state.currentError === "string" && context.state.currentError.length > 0
        ? { error: context.state.currentError }
        : {}),
    };
    if (updatedContext !== undefined) {
      json(context.res, { ...responsePayload, gitContext: updatedContext });
      return;
    }
    json(context.res, responsePayload);
  } catch (err) {
    json(context.res, { error: errorMessage(err) || "Failed to switch diff" }, 500);
  }
}

export async function handleReviewPrDiffScope(context: ReviewRouteContext): Promise<void> {
  const prMeta = context.state.prMeta;
  if (!context.isPRMode() || prMeta === undefined) {
    json(context.res, { error: "Not in PR mode" }, 400);
    return;
  }
  try {
    const body = await parseBody(context.req);
    if (Value.Check(PrDiffScopeSchema, body)) {
      const payload: PrDiffScopeBody = body;
      if (payload.scope === "layer") {
        context.state.currentPatch = context.state.originalPRPatch;
        context.state.currentGitRef = context.state.originalPRGitRef;
        context.state.currentError = context.state.originalPRError;
        context.state.currentPRDiffScope = "layer";
        json(context.res, {
          rawPatch: context.state.currentPatch,
          gitRef: context.state.currentGitRef,
          prDiffScope: context.state.currentPRDiffScope,
          ...(typeof context.state.currentError === "string" &&
          context.state.currentError.length > 0
            ? { error: context.state.currentError }
            : {}),
        });
        return;
      }
      const fullStackOption = context.state.prDiffScopeOptions.find(
        (option) => option.id === "full-stack",
      );
      const hasLocalCheckout =
        context.options.worktreePool !== undefined || context.options.agentCwd !== undefined;
      if (fullStackOption?.enabled === true && hasLocalCheckout) {
        const fullStackCwd =
          (context.options.worktreePool
            ? context.options.worktreePool.resolve(prMeta.url)
            : undefined) ?? context.options.agentCwd;
        const result = await runPRFullStackDiff(reviewRuntime, prMeta, fullStackCwd);
        if (result.error !== undefined && result.error.length > 0) {
          json(context.res, { error: result.error }, 400);
          return;
        }
        context.state.currentPatch = result.patch;
        context.state.currentGitRef = result.label;
        context.state.currentError = undefined;
        context.state.currentPRDiffScope = "full-stack";
        json(context.res, {
          rawPatch: context.state.currentPatch,
          gitRef: context.state.currentGitRef,
          prDiffScope: context.state.currentPRDiffScope,
        });
        return;
      }

      json(
        context.res,
        { error: "Full stack diff requires a stacked PR and a local checkout" },
        400,
      );
      return;
    }

    json(context.res, { error: "Invalid PR diff scope" }, 400);
  } catch (err) {
    json(context.res, { error: errorMessage(err) || "Failed to switch PR diff scope" }, 500);
  }
}

export async function handleReviewPrSwitch(context: ReviewRouteContext): Promise<void> {
  const currentPrRef = context.state.prRef;
  if (context.isPRMode() && currentPrRef !== null) {
    try {
      const body = await parseBody(context.req);
      if (!Value.Check(PrSwitchSchema, body)) {
        json(context.res, { error: "Missing PR URL" }, 400);
        return;
      }
      const payload: PrSwitchBody = body;
      if (payload.url.length === 0) {
        json(context.res, { error: "Missing PR URL" }, 400);
        return;
      }
      const newRef = parsePRUrl(payload.url);
      if (newRef === null) {
        json(context.res, { error: "Invalid PR URL" }, 400);
        return;
      }
      if (!isSameProject(newRef, currentPrRef)) {
        json(context.res, { error: "Cannot switch to a PR in a different repository" }, 400);
        return;
      }
      const cached = context.prSwitchCache.get(payload.url);
      const pr = cached ?? (await fetchPR(newRef));
      if (cached === undefined) {
        context.prSwitchCache.set(payload.url, pr);
      }
      context.state.prMeta = pr.metadata;
      context.state.prRef = prRefFromMetadata(pr.metadata);
      context.state.currentPatch = pr.rawPatch;
      context.state.currentGitRef = `${getMRLabel(pr.metadata)} ${getMRNumberLabel(pr.metadata)}`;
      context.state.currentError = undefined;
      context.state.originalPRPatch = pr.rawPatch;
      context.state.originalPRGitRef = context.state.currentGitRef;
      context.state.originalPRError = undefined;
      context.state.currentPRDiffScope = "layer";
      context.state.draftKey = contentHash(pr.rawPatch);
      context.state.prListCache = null;
      context.state.prStackInfo = getPRStackInfo(pr.metadata);

      if (context.prStackTreeCache.has(payload.url)) {
        context.state.prStackTree = context.prStackTreeCache.get(payload.url) ?? null;
      } else {
        try {
          context.state.prStackTree = await fetchPRStack(context.state.prRef, pr.metadata);
        } catch {
          context.state.prStackTree = null;
        }
        context.prStackTreeCache.set(payload.url, context.state.prStackTree);
      }

      let hasLocalForNewPR = false;
      if (context.options.worktreePool !== undefined) {
        try {
          await context.options.worktreePool.ensure(reviewRuntime, pr.metadata);
          hasLocalForNewPR = true;
        } catch {}
      } else if (context.options.agentCwd !== undefined && context.options.agentCwd.length > 0) {
        hasLocalForNewPR = await checkoutPRHead(
          reviewRuntime,
          pr.metadata,
          context.options.agentCwd,
        );
      }

      context.state.prStackInfo = resolveStackInfo(
        pr.metadata,
        context.state.prStackTree,
        context.state.prStackInfo,
      );
      context.state.prDiffScopeOptions = context.state.prStackInfo
        ? getPRDiffScopeOptions(pr.metadata, hasLocalForNewPR)
        : [];

      let switchedViewedFiles: string[] = [];
      try {
        const viewedMap = await fetchPRViewedFiles(context.state.prRef);
        switchedViewedFiles = Object.entries(viewedMap)
          .filter(([, value]) => value)
          .map(([path]) => path);
      } catch {}
      context.state.initialViewedFiles = switchedViewedFiles;
      context.state.repoInfo = {
        display: getDisplayRepo(pr.metadata),
        branch: `${getMRLabel(pr.metadata)} ${getMRNumberLabel(pr.metadata)}`,
      };

      json(context.res, {
        rawPatch: context.state.currentPatch,
        gitRef: context.state.currentGitRef,
        prMetadata: pr.metadata,
        prStackInfo: context.state.prStackInfo,
        prStackTree: context.state.prStackTree,
        prDiffScope: context.state.currentPRDiffScope,
        prDiffScopeOptions: context.state.prDiffScopeOptions,
        repoInfo: context.state.repoInfo,
        ...(switchedViewedFiles.length > 0 ? { viewedFiles: switchedViewedFiles } : {}),
      });
      return;
    } catch (err) {
      json(context.res, { error: errorMessage(err) || "Failed to switch PR" }, 500);
    }
  }

  json(context.res, { error: "Not in PR mode" }, 400);
}

export async function handleReviewPrList(context: ReviewRouteContext): Promise<void> {
  const currentPrRef = context.state.prRef;
  if (!context.isPRMode() || currentPrRef === null) {
    json(context.res, { error: "Not in PR mode" }, 400);
    return;
  }
  try {
    const now = Date.now();
    if (context.state.prListCache !== null && now - context.state.prListCacheTime < 30_000) {
      json(context.res, { prs: context.state.prListCache });
      return;
    }
    const prs = await fetchPRList(currentPrRef);
    context.state.prListCache = prs;
    context.state.prListCacheTime = now;
    json(context.res, { prs });
  } catch {
    json(context.res, { error: "Failed to fetch PR list" }, 500);
  }
}

export async function handleReviewPrContext(context: ReviewRouteContext): Promise<void> {
  const currentPrRef = context.state.prRef;
  if (!context.isPRMode() || currentPrRef === null) {
    json(context.res, { error: "Not in PR mode" }, 400);
    return;
  }
  try {
    const prContext = await fetchPRContext(currentPrRef);
    json(context.res, prContext);
  } catch (err) {
    json(context.res, { error: errorMessage(err) || "Failed to fetch PR context" }, 500);
  }
}

export async function handleReviewFileContent(context: ReviewRouteContext): Promise<void> {
  const filePath = new URL(context.req.url ?? "", "http://localhost").searchParams.get("path");
  if (filePath === null || filePath.length === 0) {
    json(context.res, { error: "Missing path" }, 400);
    return;
  }
  try {
    validateFilePath(filePath);
  } catch {
    json(context.res, { error: "Invalid path" }, 400);
    return;
  }
  const url = new URL(context.req.url ?? "", "http://localhost");
  const oldPath = url.searchParams.get("oldPath") ?? undefined;
  if (oldPath !== undefined && oldPath.length > 0) {
    try {
      validateFilePath(oldPath);
    } catch {
      json(context.res, { error: "Invalid path" }, 400);
      return;
    }
  }
  const prMeta = context.state.prMeta;
  const currentPrRef = context.state.prRef;
  const fileContentCwd =
    context.options.worktreePool && prMeta
      ? context.options.worktreePool.resolve(prMeta.url)
      : context.options.agentCwd;
  if (
    context.isPRMode() &&
    context.state.currentPRDiffScope === "full-stack" &&
    fileContentCwd !== undefined &&
    fileContentCwd.length > 0 &&
    prMeta?.defaultBranch !== undefined
  ) {
    const baseRef = await resolvePRFullStackBaseRef(
      reviewRuntime,
      prMeta.defaultBranch,
      fileContentCwd,
    );
    if (baseRef === null) {
      json(context.res, { oldContent: null, newContent: null });
      return;
    }
    const result = await getFileContentsForDiffCore(
      reviewRuntime,
      "merge-base",
      baseRef,
      filePath,
      oldPath,
      fileContentCwd,
    );
    json(context.res, result);
    return;
  }
  if (context.hasLocalAccess && !context.isPRMode()) {
    const base = resolveBaseBranch(
      url.searchParams.get("base") ?? undefined,
      context.detectedCompareTarget(),
    );
    const result = await getVcsFileContentsForDiff(
      context.state.currentDiffType,
      base,
      filePath,
      oldPath,
      context.options.gitContext?.cwd,
    );
    json(context.res, result);
    return;
  }
  if (context.isPRMode() && currentPrRef !== null && prMeta !== undefined) {
    try {
      const oldSha = prMeta.mergeBaseSha ?? prMeta.baseSha;
      const [oldContent, newContent] = await Promise.all([
        fetchPRFileContent(currentPrRef, oldSha, oldPath ?? filePath),
        fetchPRFileContent(currentPrRef, prMeta.headSha, filePath),
      ]);
      json(context.res, { oldContent, newContent });
      return;
    } catch (err) {
      json(context.res, { error: errorMessage(err) || "Failed to fetch file content" }, 500);
      return;
    }
  }
  json(context.res, { error: "No file access available" }, 400);
}
