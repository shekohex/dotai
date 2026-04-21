import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { ReviewCheckoutTarget, ReviewTarget } from "./deps.js";

export type ReviewExecutionOptions = {
  extraInstruction?: string;
  handoffRequested?: boolean;
  handoffInstruction?: string;
};

export type PreparedReviewRunInput = {
  targetLabel: string;
  fullPrompt: string;
  branchAnchorId: string | undefined;
  checkoutToRestore: ReviewCheckoutTarget | undefined;
};

type PrepareReviewRunInputDeps<Message = unknown> = {
  buildReviewPrompt: (target: ReviewTarget) => Promise<string>;
  getUserFacingHint: (target: ReviewTarget) => string;
  resolveGeneratedReviewHandoffPrompt: (input: {
    ctx: ExtensionCommandContext;
    targetLabel: string;
    reviewOptions: ReviewExecutionOptions;
    parentSessionPath: string | undefined;
    parentMessages: Message[];
    checkoutToRestore: ReviewCheckoutTarget | undefined;
  }) => Promise<string | null | undefined>;
  getConversationMessages: (ctx: ExtensionCommandContext) => Message[];
  loadProjectReviewGuidelines: (cwd: string) => Promise<string | null | undefined>;
  buildReviewTaskPrompt: (input: {
    targetLabel: string;
    prompt: string;
    generatedHandoffPrompt: string | undefined;
    projectGuidelines: string | null | undefined;
    customInstructions: string | undefined;
    extraInstruction: string | undefined;
  }) => string;
  getCustomInstructions: () => string | undefined;
  appendReviewAnchor: (targetLabel: string) => void;
};

type ExecuteReviewDeps = {
  isRuntimeActive: () => boolean;
  prepareReviewRunInput: (
    ctx: ExtensionCommandContext,
    target: ReviewTarget,
    reviewOptions: ReviewExecutionOptions,
  ) => Promise<PreparedReviewRunInput | null>;
  startReviewRun: (
    input: PreparedReviewRunInput & { ctx: ExtensionCommandContext },
  ) => Promise<boolean>;
};

export async function prepareReviewRunInput<Message>(
  ctx: ExtensionCommandContext,
  target: ReviewTarget,
  reviewOptions: ReviewExecutionOptions,
  deps: PrepareReviewRunInputDeps<Message>,
): Promise<PreparedReviewRunInput | null> {
  const checkoutToRestore = target.type === "pullRequest" ? target.checkoutToRestore : undefined;
  const prompt = await deps.buildReviewPrompt(target);
  const targetLabel = deps.getUserFacingHint(target);
  const generatedHandoffPrompt = await deps.resolveGeneratedReviewHandoffPrompt({
    ctx,
    targetLabel,
    reviewOptions,
    parentSessionPath: ctx.sessionManager.getSessionFile(),
    parentMessages: deps.getConversationMessages(ctx),
    checkoutToRestore,
  });
  if (generatedHandoffPrompt === null) {
    return null;
  }

  const fullPrompt = deps.buildReviewTaskPrompt({
    targetLabel,
    prompt,
    generatedHandoffPrompt,
    projectGuidelines: await deps.loadProjectReviewGuidelines(ctx.cwd),
    customInstructions: deps.getCustomInstructions(),
    extraInstruction: reviewOptions.extraInstruction?.trim(),
  });
  deps.appendReviewAnchor(targetLabel);
  return {
    targetLabel,
    fullPrompt,
    branchAnchorId: ctx.sessionManager.getLeafId() ?? undefined,
    checkoutToRestore,
  };
}

export async function executeReview(
  ctx: ExtensionCommandContext,
  target: ReviewTarget,
  reviewOptions: ReviewExecutionOptions = {},
  deps: ExecuteReviewDeps,
): Promise<boolean> {
  if (deps.isRuntimeActive()) {
    ctx.ui.notify("A review is already running. Wait for it to finish first.", "warning");
    return false;
  }

  const runInput = await deps.prepareReviewRunInput(ctx, target, reviewOptions);
  if (runInput === null) {
    return false;
  }

  ctx.ui.notify(`Starting review: ${runInput.targetLabel}`, "info");

  return deps.startReviewRun({
    ctx,
    targetLabel: runInput.targetLabel,
    fullPrompt: runInput.fullPrompt,
    branchAnchorId: runInput.branchAnchorId,
    checkoutToRestore: runInput.checkoutToRestore,
  });
}
