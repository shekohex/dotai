import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { ParsedReviewArgs, ReviewTarget } from "./deps.js";

type RequestedTargetType = ParsedReviewArgs["requestedTargetType"];

type RequestedTargetResolverDeps = {
  showBranchSelector: (ctx: ExtensionCommandContext) => Promise<ReviewTarget | null>;
  showCommitSelector: (ctx: ExtensionCommandContext) => Promise<ReviewTarget | null>;
  showFolderInput: (ctx: ExtensionCommandContext) => Promise<ReviewTarget | null>;
  showPrInput: (ctx: ExtensionCommandContext) => Promise<ReviewTarget | null>;
};

type InitialTargetResolverDeps = {
  resolveRequestedTarget: (
    ctx: ExtensionCommandContext,
    requestedTargetType: RequestedTargetType,
  ) => Promise<ReviewTarget | null>;
  handlePrCheckout: (ctx: ExtensionCommandContext, ref: string) => Promise<ReviewTarget | null>;
};

type ReviewCommandLoopInput = {
  target: ReviewTarget | null;
  fromSelector: boolean;
  parsed: ParsedReviewArgs;
};

type ReviewCommandLoopDeps = {
  showReviewSelector: (ctx: ExtensionCommandContext) => Promise<ReviewTarget | null>;
  startReviewForTarget: (
    ctx: ExtensionCommandContext,
    target: ReviewTarget,
    parsed: ParsedReviewArgs,
  ) => Promise<boolean>;
};

export function resolveRequestedTarget(
  ctx: ExtensionCommandContext,
  requestedTargetType: RequestedTargetType,
  deps: RequestedTargetResolverDeps,
): Promise<ReviewTarget | null> {
  if (requestedTargetType === "uncommitted") {
    return Promise.resolve({ type: "uncommitted" });
  }
  if (requestedTargetType === "branch") {
    return deps.showBranchSelector(ctx);
  }
  if (requestedTargetType === "commit") {
    return deps.showCommitSelector(ctx);
  }
  if (requestedTargetType === "folder") {
    return deps.showFolderInput(ctx);
  }
  if (requestedTargetType === "pr") {
    return deps.showPrInput(ctx);
  }

  return Promise.resolve(null);
}

export async function resolveInitialReviewTarget(
  ctx: ExtensionCommandContext,
  parsed: ParsedReviewArgs,
  deps: InitialTargetResolverDeps,
): Promise<{ target: ReviewTarget | null; fromSelector: boolean; aborted: boolean }> {
  let target: ReviewTarget | null = null;
  let fromSelector = false;

  if (parsed.target) {
    if (parsed.target.type === "pr") {
      target = await deps.handlePrCheckout(ctx, parsed.target.ref);
      if (!target) {
        ctx.ui.notify("PR review failed. Returning to review menu.", "warning");
        return { target: null, fromSelector: false, aborted: true };
      }
    } else {
      target = parsed.target;
    }
  }

  if (!target && parsed.requestedTargetType) {
    target = await deps.resolveRequestedTarget(ctx, parsed.requestedTargetType);
  } else if (!target) {
    fromSelector = true;
  }

  return { target, fromSelector, aborted: false };
}

export async function runReviewCommandLoop(
  ctx: ExtensionCommandContext,
  input: ReviewCommandLoopInput,
  deps: ReviewCommandLoopDeps,
): Promise<void> {
  let target = input.target;
  while (true) {
    if (!target && input.fromSelector) {
      target = await deps.showReviewSelector(ctx);
    }

    if (!target) {
      ctx.ui.notify("Review cancelled", "info");
      return;
    }

    const started = await deps.startReviewForTarget(ctx, target, input.parsed);
    if (started || !input.fromSelector) {
      return;
    }

    target = null;
  }
}
