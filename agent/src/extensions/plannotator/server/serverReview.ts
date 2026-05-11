import { readFileSync, existsSync } from "node:fs";
import os from "node:os";

import { Type } from "typebox";

import {
  detectGitUser,
  type DiffType,
  type GitContext,
  type PRMetadata,
  type WorktreePool,
} from "./review-generated-deps.js";

export type { DiffOption, DiffType, GitContext } from "../generated/review-core.js";

import {
  createEditorAnnotationHandler,
  createExternalAnnotationHandler,
  isRemoteSession,
  detectRemoteDefaultCompareTarget,
} from "./review-local-deps.js";
import { createReviewBootstrap } from "./review-bootstrap.js";
import { type ReviewMutableState } from "./review-diff-routes.js";
import { startReviewRuntime } from "./review-server-runtime.js";
import { createReviewDispatchContext } from "./review-server-context.js";

const TourChecklistSchema = Type.Object({
  checked: Type.Array(Type.Boolean()),
});

/**
 * Detect if running inside WSL (Windows Subsystem for Linux).
 *
 * @returns {boolean} `true` when current Linux runtime is WSL.
 */
function detectWSL(): boolean {
  if (process.platform !== "linux") return false;
  if (os.release().toLowerCase().includes("microsoft")) return true;
  try {
    if (existsSync("/proc/version")) {
      const content = readFileSync("/proc/version", "utf-8").toLowerCase();
      return content.includes("wsl") || content.includes("microsoft");
    }
  } catch {
    /* ignore */
  }
  return false;
}

export interface ReviewServerResult {
  port: number;
  portSource: "env" | "remote-default" | "random";
  url: string;
  isRemote: boolean;
  waitForDecision: () => Promise<{
    approved: boolean;
    feedback: string;
    annotations: unknown[];
    agentSwitch?: string;
    exit?: boolean;
  }>;
  stop: () => void;
}

/**
 * @param {object} options Server bootstrap inputs and session state.
 * @returns {Promise<ReviewServerResult>} Running review server handle and decision waiters.
 */
export async function startReviewServer(options: {
  rawPatch: string;
  gitRef: string;
  htmlContent: string;
  origin?: string;
  diffType?: DiffType;
  gitContext?: GitContext;
  /**
   * Initial base branch the caller used to compute `rawPatch`. When a caller overrides the detected
   * default (e.g. `openCodeReview({ defaultBranch })`), this must be forwarded so the server's
   * internal `currentBase` state, the `/api/diff` response, and downstream agent prompts stay
   * consistent with the patch that's already on screen.
   */
  initialBase?: string;
  error?: string;
  sharingEnabled?: boolean;
  shareBaseUrl?: string;
  pasteApiUrl?: string;
  prMetadata?: PRMetadata;
  /** Working directory for agent processes (e.g., --local worktree). Independent of diff pipeline. */
  agentCwd?: string;
  /** Per-PR worktree pool. When set, pr-switch creates worktrees instead of checking out. */
  worktreePool?: WorktreePool;
  /** Cleanup callback invoked when server stops (e.g., remove temp worktree) */
  onCleanup?: () => void | Promise<void>;
  /** Called when server starts with the URL, remote status, and port */
  onReady?: (url: string, isRemote: boolean, port: number) => void;
}): Promise<ReviewServerResult> {
  const gitUser = detectGitUser();
  const hasLocalAccess = options.gitContext !== undefined;
  const sessionVcsType = options.gitContext?.vcsType;
  const isRemote = isRemoteSession();
  const wslFlag = detectWSL();
  const bootstrap = await createReviewBootstrap({
    rawPatch: options.rawPatch,
    gitRef: options.gitRef,
    diffType: options.diffType,
    gitContext: options.gitContext,
    initialBase: options.initialBase,
    error: options.error,
    prMetadata: options.prMetadata,
    worktreeEnabled: options.worktreePool !== undefined || options.agentCwd !== undefined,
    detectedCompareTarget: () =>
      options.gitContext?.defaultBranch ?? options.gitContext?.compareTarget?.fallback ?? "main",
  });
  const isPRMode = bootstrap.isPRMode;
  const platformUser = bootstrap.platformUser;
  const prSwitchCache = bootstrap.prSwitchCache;
  const prStackTreeCache = bootstrap.prStackTreeCache;
  const editorAnnotations = createEditorAnnotationHandler();
  const externalAnnotations = createExternalAnnotationHandler("review");
  // Tracks the base branch the user picked from the UI. Agent review prompts
  // read this (not gitContext.defaultBranch) so they analyze the same diff
  // the reviewer is currently looking at. Honors an explicit initialBase from
  // the caller — e.g. programmatic Pi callers can request a non-detected base.
  const detectedCompareTarget = (): string =>
    options.gitContext?.defaultBranch ?? options.gitContext?.compareTarget?.fallback ?? "main";
  const reviewState: ReviewMutableState = bootstrap.reviewState;
  const localState: ReviewMutableState = { ...bootstrap.reviewState };

  // Fire-and-forget: query the remote for its actual default branch.
  if (options.gitContext !== undefined && options.initialBase === undefined && !isPRMode) {
    void detectRemoteDefaultCompareTarget(options.gitContext.cwd, sessionVcsType).then((remote) => {
      if (remote !== null && remote.length > 0 && !localState.baseEverSwitched)
        localState.currentBase = remote;
    });
  }

  const sharingEnabled = options.sharingEnabled ?? process.env.PLANNOTATOR_SHARE !== "disabled";
  const shareBaseUrl = options.shareBaseUrl ?? process.env.PLANNOTATOR_SHARE_URL ?? undefined;
  const pasteApiUrl = options.pasteApiUrl ?? process.env.PLANNOTATOR_PASTE_URL ?? undefined;
  let serverUrl = "";

  return startReviewRuntime({
    reviewState,
    getLocals: () => ({ ...localState }),
    setLocals: (state) => {
      Object.assign(localState, state);
    },
    gitContext: options.gitContext,
    agentCwd: options.agentCwd,
    worktreePool: options.worktreePool,
    getPrMeta: () => localState.prMeta,
    getCurrentDiffType: () => localState.currentDiffType,
    getCurrentPatch: () => localState.currentPatch,
    getCurrentBase: () => localState.currentBase,
    getCurrentPrDiffScope: () => localState.currentPRDiffScope,
    getServerUrl: () => serverUrl,
    addAnnotations: (annotations) => {
      const result = editorAnnotations.addAnnotations({ annotations });
      if ("error" in result) {
        console.error(`[review-agent-jobs] addAnnotations error:`, result.error);
      }
    },
    getCachedPrMetadata: (url) => prSwitchCache.get(url)?.metadata,
    createDispatchContext: ({ req, res, url, session, aiEndpoints }) =>
      createReviewDispatchContext({
        req,
        res,
        url,
        session,
        aiEndpoints,
        reviewState,
        localState,
        hasLocalAccess,
        isPRMode,
        detectedCompareTarget,
        gitContext: options.gitContext,
        agentCwd: options.agentCwd,
        worktreePool: options.worktreePool,
        sessionVcsType,
        prSwitchCache,
        prStackTreeCache,
        sharingEnabled,
        shareBaseUrl,
        pasteApiUrl,
        origin: options.origin,
        wslFlag,
        platformUser,
        gitUser,
        htmlContent: options.htmlContent,
        editorAnnotations,
        externalAnnotations,
        tourChecklistSchema: TourChecklistSchema,
      }),
    isRemote,
    onReady: options.onReady,
    onCleanup: options.onCleanup,
  });
}
