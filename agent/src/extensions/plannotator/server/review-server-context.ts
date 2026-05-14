import {
  deleteDraft,
  getServerConfig,
  type GitContext,
  type PRMetadata,
  type PRStackTree,
  type WorktreePool,
} from "./review-generated-deps.js";
import type { ReviewMutableState } from "./review-diff-routes.js";
import type { ReviewSession } from "./review-session.js";
import type { ReviewDispatchContext } from "./review-server-dispatch.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TSchema } from "typebox";

export function createReviewDispatchContext(args: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  session: ReviewSession;
  aiEndpoints: Record<string, (req: Request) => Promise<Response>> | null;
  reviewState: ReviewMutableState;
  localState: ReviewMutableState;
  hasLocalAccess: boolean;
  isPRMode: boolean;
  detectedCompareTarget: () => string;
  gitContext?: GitContext;
  agentCwd?: string;
  worktreePool?: WorktreePool;
  sessionVcsType?: GitContext["vcsType"];
  prSwitchCache: Map<string, { metadata: PRMetadata; rawPatch: string }>;
  prStackTreeCache: Map<string, PRStackTree | null>;
  sharingEnabled: boolean;
  shareBaseUrl?: string;
  pasteApiUrl?: string;
  origin?: string;
  wslFlag: boolean;
  platformUser: string | null;
  gitUser: string | null;
  htmlContent: string;
  editorAnnotations: {
    handle: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
  };
  externalAnnotations: {
    handle: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
  };
  tourChecklistSchema: TSchema;
}): ReviewDispatchContext {
  return {
    req: args.req,
    res: args.res,
    url: args.url,
    state: args.reviewState,
    hasLocalAccess: args.hasLocalAccess,
    isPRMode: () => args.isPRMode,
    isPRModeValue: args.isPRMode,
    prMetaPresent: args.localState.prMeta !== undefined,
    prRefPresent: args.localState.prRef !== null,
    detectedCompareTarget: args.detectedCompareTarget,
    options: {
      gitContext: args.gitContext,
      agentCwd: args.agentCwd,
      worktreePool: args.worktreePool,
    },
    sessionVcsType: args.sessionVcsType,
    prSwitchCache: args.prSwitchCache,
    prStackTreeCache: args.prStackTreeCache,
    sharingPayload: {
      sharingEnabled: args.sharingEnabled,
      shareBaseUrl: args.shareBaseUrl,
      pasteApiUrl: args.pasteApiUrl,
    },
    diffPayload: {
      rawPatch: args.localState.currentPatch,
      gitRef: args.localState.currentGitRef,
      origin: args.origin ?? "pi",
      diffType: args.hasLocalAccess ? args.localState.currentDiffType : undefined,
      base: args.hasLocalAccess ? args.localState.currentBase : undefined,
      hideWhitespace: args.localState.currentHideWhitespace,
      gitContext: args.hasLocalAccess ? args.gitContext : undefined,
      repoInfo: args.localState.repoInfo,
      isWSL: args.wslFlag,
      ...(args.agentCwd !== undefined && args.agentCwd.length > 0
        ? { agentCwd: args.agentCwd }
        : {}),
      ...(args.isPRMode
        ? {
            prMetadata: args.localState.prMeta,
            platformUser: args.platformUser,
            prStackInfo: args.localState.prStackInfo,
            prStackTree: args.localState.prStackTree,
            prDiffScope: args.localState.currentPRDiffScope,
            prDiffScopeOptions: args.localState.prDiffScopeOptions,
          }
        : {}),
      ...(args.isPRMode && args.localState.initialViewedFiles.length > 0
        ? { viewedFiles: args.localState.initialViewedFiles }
        : {}),
      ...(args.localState.currentError !== undefined && args.localState.currentError.length > 0
        ? { error: args.localState.currentError }
        : {}),
      serverConfig: getServerConfig(args.gitUser),
      htmlContent: args.htmlContent,
    },
    tour: args.session.tour,
    tourChecklistSchema: args.tourChecklistSchema,
    syncStateFromLocals: args.session.syncStateFromLocals,
    syncLocalsFromState: args.session.syncLocalsFromState,
    agentJobs: args.session.agentJobs,
    editorAnnotations: args.editorAnnotations,
    externalAnnotations: args.externalAnnotations,
    aiEndpoints: args.aiEndpoints,
    resolveAgentCwd: args.session.resolveAgentCwd,
    getCurrentPatch: () => args.localState.currentPatch,
    currentDiffType: args.localState.currentDiffType,
    draftKey: args.localState.draftKey,
    deleteDraft: () => {
      deleteDraft(args.localState.draftKey);
    },
    resolveDecision: args.session.resolveDecision,
  };
}
