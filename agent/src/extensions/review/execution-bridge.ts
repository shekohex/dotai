import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { SummaryGenerationResult } from "../session-launch-utils.js";
import { getConversationMessages } from "../session-launch-utils.js";
import { resolveGeneratedReviewHandoffPrompt } from "./handoff-generation.js";
import {
  buildReviewPrompt,
  checkoutPr,
  executeReview as executeReviewWithDeps,
  GH_SETUP_INSTRUCTIONS,
  getCurrentCheckoutTarget,
  getPrInfo,
  getUserFacingHint,
  hasPendingChanges,
  loadProjectReviewGuidelines,
  parsePrReference,
  prepareReviewRunInput as prepareReviewRunInputWithDeps,
  PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE,
  resolvePullRequestTarget as resolvePullRequestTargetWithDeps,
  REVIEW_ANCHOR_TYPE,
  REVIEW_HANDOFF_GENERATION_FAILED_MESSAGE,
  restoreCheckoutTarget,
  startReviewRun,
  type ReviewExecutionOptions,
  type ReviewRuntimeState,
  type ReviewTarget,
} from "./deps.js";
import type { createReviewSubagentSdk } from "./deps.js";

type PullRequestResolver = (
  ctx: ExtensionContext,
  ref: string,
  resolveOptions?: { skipInitialPendingChangesCheck?: boolean },
) => Promise<ReviewTarget | null>;

type CreateReviewExecutorInput = {
  pi: ExtensionAPI;
  runtime: ReviewRuntimeState;
  getSdk: () => Pick<ReturnType<typeof createReviewSubagentSdk>, "spawn">;
  generateReviewHandoff: (input: {
    ctx: ExtensionCommandContext;
    goal: string;
    messages: ReturnType<typeof getConversationMessages>;
  }) => Promise<SummaryGenerationResult>;
  restoreCheckoutAfterFailedStart: (
    ctx: ExtensionContext,
    checkoutToRestore: ReviewRuntimeState["checkoutToRestore"],
  ) => Promise<void>;
  buildReviewTaskPrompt: (input: {
    targetLabel: string;
    prompt: string;
    generatedHandoffPrompt: string | undefined;
    projectGuidelines: string | null | undefined;
    customInstructions: string | undefined;
    extraInstruction: string | undefined;
  }) => string;
  clearReviewState: (ctx: ExtensionContext) => void;
  persistReviewState: (state: { active: boolean }) => void;
  syncReviewWidget: (ctx: ExtensionContext) => void;
  formatErrorMessage: (error: unknown) => string;
};

export function createPullRequestTargetResolver(pi: ExtensionAPI): PullRequestResolver {
  return (ctx, ref, resolveOptions = {}) =>
    resolvePullRequestTargetWithDeps(
      ctx,
      ref,
      {
        pi,
        ghSetupInstructions: GH_SETUP_INSTRUCTIONS,
        pendingChangesBlockedMessage: PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE,
        hasPendingChanges: () => hasPendingChanges(pi),
        parsePrReference,
        getPrInfo: (prNumber, repo) => getPrInfo(pi, prNumber, repo),
        getCurrentCheckoutTarget: () => getCurrentCheckoutTarget(pi),
        checkoutPr: (prNumber, repo) => checkoutPr(pi, prNumber, repo),
      },
      resolveOptions,
    );
}

export function createReviewExecutor(input: CreateReviewExecutorInput) {
  return (
    ctx: ExtensionCommandContext,
    target: ReviewTarget,
    reviewOptions: ReviewExecutionOptions = {},
  ) =>
    executeReviewWithDeps(ctx, target, reviewOptions, {
      isRuntimeActive: () => input.runtime.active,
      prepareReviewRunInput: (prepareCtx, prepareTarget, prepareOptions) =>
        prepareReviewRunInputWithDeps(prepareCtx, prepareTarget, prepareOptions, {
          buildReviewPrompt: (reviewTarget) => buildReviewPrompt(input.pi, reviewTarget),
          getUserFacingHint,
          resolveGeneratedReviewHandoffPrompt: (handoffInput) =>
            resolveGeneratedReviewHandoffPrompt(handoffInput, {
              generateReviewHandoff: input.generateReviewHandoff,
              restoreCheckoutAfterFailedStart: input.restoreCheckoutAfterFailedStart,
              handoffGenerationFailedMessage: REVIEW_HANDOFF_GENERATION_FAILED_MESSAGE,
            }),
          getConversationMessages,
          loadProjectReviewGuidelines,
          buildReviewTaskPrompt: input.buildReviewTaskPrompt,
          getCustomInstructions: () => input.runtime.customInstructions?.trim(),
          appendReviewAnchor: (targetLabel) => {
            input.pi.appendEntry(REVIEW_ANCHOR_TYPE, {
              targetLabel,
              createdAt: new Date().toISOString(),
            });
          },
        }),
      startReviewRun: (runInput) =>
        startReviewRun(runInput, {
          runtime: input.runtime,
          spawn: (startInput, startCtx) => input.getSdk().spawn(startInput, startCtx),
          restoreCheckoutTarget: (checkoutToRestore) =>
            restoreCheckoutTarget(input.pi, checkoutToRestore),
          clearReviewState: input.clearReviewState,
          persistReviewState: input.persistReviewState,
          syncReviewWidget: input.syncReviewWidget,
          formatErrorMessage: input.formatErrorMessage,
        }),
    });
}
