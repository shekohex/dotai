import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { SummaryGenerationResult } from "../session-launch-utils.js";
import {
  buildReviewAuthorTask,
  buildReviewHandoffPrompt,
  type ReviewCheckoutTarget,
} from "./deps.js";

type ReviewHandoffOptions = {
  handoffRequested?: boolean;
  handoffInstruction?: string;
};

export type ResolveGeneratedReviewHandoffPromptInput<Message = unknown> = {
  ctx: ExtensionCommandContext;
  targetLabel: string;
  reviewOptions: ReviewHandoffOptions;
  parentSessionPath: string | undefined;
  parentMessages: Message[];
  checkoutToRestore: ReviewCheckoutTarget | undefined;
};

type ResolveGeneratedReviewHandoffPromptDeps<Message = unknown> = {
  generateReviewHandoff: (input: {
    ctx: ExtensionCommandContext;
    goal: string;
    messages: Message[];
  }) => Promise<SummaryGenerationResult>;
  restoreCheckoutAfterFailedStart: (
    ctx: ExtensionCommandContext,
    checkoutToRestore: ReviewCheckoutTarget | undefined,
  ) => Promise<void>;
  handoffGenerationFailedMessage: string;
};

function buildGeneratedHandoffGoal(
  targetLabel: string,
  handoffInstruction: string | undefined,
): string {
  return [
    `Prepare a reviewer handoff for reviewing ${targetLabel}.`,
    "Summarize the implementation intent, risky areas, tradeoffs, open questions, and anything the reviewer should challenge or validate.",
    handoffInstruction !== undefined && handoffInstruction.length > 0
      ? `Additional author handoff request: ${handoffInstruction}`
      : undefined,
  ]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join("\n\n");
}

function resolveManualHandoffPrompt<Message>(input: {
  ctx: ExtensionCommandContext;
  targetLabel: string;
  handoffInstruction: string | undefined;
  reviewOptions: ReviewHandoffOptions;
  parentMessages: Message[];
}): string | null | undefined {
  if (input.parentMessages.length > 0) {
    return undefined;
  }
  if (input.handoffInstruction !== undefined && input.handoffInstruction.length > 0) {
    return `## Task\n${buildReviewAuthorTask(input.targetLabel, input.reviewOptions.handoffInstruction)}`;
  }
  input.ctx.ui.notify("No session history available for automatic review handoff.", "warning");
  return null;
}

async function failGeneratedHandoff(
  ctx: ExtensionCommandContext,
  checkoutToRestore: ReviewCheckoutTarget | undefined,
  message: string,
  type: "error" | "info",
  restoreCheckoutAfterFailedStart: (
    ctx: ExtensionCommandContext,
    checkoutToRestore: ReviewCheckoutTarget | undefined,
  ) => Promise<void>,
  details?: string,
): Promise<null> {
  await restoreCheckoutAfterFailedStart(ctx, checkoutToRestore);
  ctx.ui.notify(message, type);
  if (details !== undefined && details.length > 0) {
    ctx.ui.notify(details, "error");
  }
  return null;
}

function resolveGeneratedHandoffOutcome<Message>(input: {
  request: ResolveGeneratedReviewHandoffPromptInput<Message>;
  deps: ResolveGeneratedReviewHandoffPromptDeps<Message>;
  handoffResult: SummaryGenerationResult;
}): Promise<string | null> {
  if (input.handoffResult.error !== undefined && input.handoffResult.error.length > 0) {
    return failGeneratedHandoff(
      input.request.ctx,
      input.request.checkoutToRestore,
      input.deps.handoffGenerationFailedMessage,
      "error",
      input.deps.restoreCheckoutAfterFailedStart,
      input.handoffResult.error,
    );
  }

  if (
    input.handoffResult.aborted === true ||
    input.handoffResult.summary === undefined ||
    input.handoffResult.summary.length === 0
  ) {
    return failGeneratedHandoff(
      input.request.ctx,
      input.request.checkoutToRestore,
      "Review cancelled",
      "info",
      input.deps.restoreCheckoutAfterFailedStart,
    );
  }

  return Promise.resolve(
    buildReviewHandoffPrompt({
      summary: input.handoffResult.summary,
      targetLabel: input.request.targetLabel,
      handoffInstruction: input.request.reviewOptions.handoffInstruction,
      parentSessionPath: input.request.parentSessionPath,
    }),
  );
}

export async function resolveGeneratedReviewHandoffPrompt<Message>(
  input: ResolveGeneratedReviewHandoffPromptInput<Message>,
  deps: ResolveGeneratedReviewHandoffPromptDeps<Message>,
): Promise<string | null | undefined> {
  if (input.reviewOptions.handoffRequested !== true) {
    return undefined;
  }

  const handoffInstruction = input.reviewOptions.handoffInstruction?.trim();
  const manualPrompt = resolveManualHandoffPrompt({
    ctx: input.ctx,
    targetLabel: input.targetLabel,
    handoffInstruction,
    reviewOptions: input.reviewOptions,
    parentMessages: input.parentMessages,
  });
  if (manualPrompt !== undefined) {
    return manualPrompt ?? undefined;
  }

  const handoffResult = await deps.generateReviewHandoff({
    ctx: input.ctx,
    goal: buildGeneratedHandoffGoal(input.targetLabel, handoffInstruction),
    messages: input.parentMessages,
  });

  return resolveGeneratedHandoffOutcome({
    request: input,
    deps,
    handoffResult,
  });
}
