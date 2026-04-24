import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { isStaleSessionReplacementContextError } from "../session-replacement.js";
import {
  buildReviewExecutionOptions,
  ensureReviewCommandCanRun,
  getReviewArgumentCompletions,
  parseArgs,
  resolveInitialReviewTarget,
  resolveRequestedTarget,
  runReviewCommand,
  runReviewCommandLoop,
  type ParsedReviewArgs,
  type ReviewExecutionOptions,
  type ReviewTarget,
} from "./deps.js";
import { showReviewSelector as showReviewPresetSelector } from "./selector-presets.js";
import { getSmartDefault } from "./selector-search.js";
import {
  showBranchSelector,
  showCommitSelector,
  showFolderInput,
  showPrInput,
} from "./selector-targets.js";

type PullRequestResolver = (
  ctx: ExtensionContext,
  ref: string,
  resolveOptions?: { skipInitialPendingChangesCheck?: boolean },
) => Promise<ReviewTarget | null>;

type ExtensionWiringDeps = {
  pi: ExtensionAPI;
  getRuntimeActive: () => boolean;
  getCustomInstructions: () => string | undefined;
  setCustomInstructions: (instructions: string | undefined) => void;
  applyAllReviewState: (ctx: ExtensionContext) => Promise<void>;
  shutdownRuntime: () => void;
  resolvePullRequestTarget: PullRequestResolver;
  executeReview: (
    ctx: ExtensionCommandContext,
    target: ReviewTarget,
    reviewOptions: ReviewExecutionOptions,
  ) => Promise<boolean>;
};

function resolvePresetTargetSelection(
  ctx: ExtensionContext,
  deps: ExtensionWiringDeps,
  selection: string,
): ReviewTarget | Promise<ReviewTarget | null> | null {
  if (selection === "uncommitted") {
    return { type: "uncommitted" };
  }
  if (selection === "baseBranch") {
    return showBranchSelector(ctx, deps.pi);
  }
  if (selection === "commit") {
    return showCommitSelector(ctx, deps.pi);
  }
  if (selection === "folder") {
    return showFolderInput(ctx);
  }
  if (selection === "pullRequest") {
    return showPrInput(ctx, deps.pi, deps.resolvePullRequestTarget);
  }
  return null;
}

async function showReviewSelector(
  ctx: ExtensionContext,
  deps: ExtensionWiringDeps,
): Promise<ReviewTarget | null> {
  const smartDefault = await getSmartDefault(deps.pi);
  return showReviewPresetSelector(ctx, {
    smartDefault,
    getCustomInstructions: deps.getCustomInstructions,
    setCustomInstructions: deps.setCustomInstructions,
    resolvePresetTargetSelection: (selection) => resolvePresetTargetSelection(ctx, deps, selection),
  });
}

function resolveRequestedTargetForCommand(
  ctx: ExtensionCommandContext,
  deps: ExtensionWiringDeps,
  requestedTargetType: ParsedReviewArgs["requestedTargetType"],
): Promise<ReviewTarget | null> {
  return resolveRequestedTarget(ctx, requestedTargetType, {
    showBranchSelector: (targetCtx) => showBranchSelector(targetCtx, deps.pi),
    showCommitSelector: (targetCtx) => showCommitSelector(targetCtx, deps.pi),
    showFolderInput,
    showPrInput: (targetCtx) => showPrInput(targetCtx, deps.pi, deps.resolvePullRequestTarget),
  });
}

function registerReviewSessionEvents(deps: ExtensionWiringDeps): void {
  deps.pi.on("session_start", async (_event, ctx) => {
    try {
      await deps.applyAllReviewState(ctx);
    } catch (error) {
      if (!isStaleSessionReplacementContextError(error)) {
        throw error;
      }
    }
  });

  deps.pi.on("session_tree", async (_event, ctx) => {
    try {
      await deps.applyAllReviewState(ctx);
    } catch (error) {
      if (!isStaleSessionReplacementContextError(error)) {
        throw error;
      }
    }
  });

  deps.pi.on("session_shutdown", () => {
    deps.shutdownRuntime();
  });
}

function registerReviewCommand(deps: ExtensionWiringDeps): void {
  deps.pi.registerCommand("review", {
    description: "Review code changes using the built-in review mode",
    getArgumentCompletions: (prefix) => getReviewArgumentCompletions(deps.pi, prefix),
    handler: (args, ctx) =>
      runReviewCommand(args, ctx, {
        ensureReviewCommandCanRun: (targetCtx) =>
          ensureReviewCommandCanRun(targetCtx, {
            isRuntimeActive: deps.getRuntimeActive,
            execGitCheck: () => deps.pi.exec("git", ["rev-parse", "--git-dir"]),
          }),
        parseArgs,
        resolveInitialReviewTarget: (targetCtx, parsed) =>
          resolveInitialReviewTarget(targetCtx, parsed, {
            resolveRequestedTarget: (commandCtx, requestedType) =>
              resolveRequestedTargetForCommand(commandCtx, deps, requestedType),
            handlePrCheckout: (checkoutCtx, ref) => deps.resolvePullRequestTarget(checkoutCtx, ref),
          }),
        runReviewCommandLoop: (targetCtx, input) =>
          runReviewCommandLoop(targetCtx, input, {
            showReviewSelector: (selectorCtx) => showReviewSelector(selectorCtx, deps),
            startReviewForTarget: (reviewCtx, target, parsedArgs) =>
              deps.executeReview(reviewCtx, target, buildReviewExecutionOptions(parsedArgs)),
          }),
      }),
  });
}

export function registerReviewHandlers(deps: ExtensionWiringDeps): void {
  registerReviewSessionEvents(deps);
  registerReviewCommand(deps);
}
