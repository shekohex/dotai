import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isStaleSessionReplacementContextError } from "../session-replacement.js";
import {
  buildLaunchCommand,
  createDefaultSubagentRuntimeHooks,
  createSubagentSDK,
  SUBAGENT_STATUS_MESSAGE,
  TmuxAdapter,
} from "../../subagent-sdk/index.js";
import type { CreateReviewExtensionOptions, ReviewRuntimeState } from "./deps.js";

type ReviewTerminalStatus = "completed" | "failed" | "cancelled";

export function createReviewSubagentSdk(
  resolvedOptions: CreateReviewExtensionOptions,
  pi: ExtensionAPI,
): ReturnType<typeof createSubagentSDK> {
  const defaultSubagentHooks = createDefaultSubagentRuntimeHooks(pi);
  const reviewSubagentHooks = {
    ...defaultSubagentHooks,
    emitStatusMessage({ content }: { content: string; triggerTurn?: boolean }) {
      try {
        pi.sendMessage(
          {
            customType: SUBAGENT_STATUS_MESSAGE,
            content,
            display: true,
          },
          { deliverAs: "steer", triggerTurn: false },
        );
      } catch (error) {
        if (!isStaleSessionReplacementContextError(error)) {
          throw error;
        }
      }
    },
  };

  const adapter =
    resolvedOptions.adapterFactory?.(pi) ??
    new TmuxAdapter(
      (command, args, execOptions) => pi.exec(command, args, execOptions),
      process.cwd(),
    );
  return createSubagentSDK(pi, {
    adapter,
    buildLaunchCommand,
    hooks: reviewSubagentHooks,
  });
}

type SubscribeReviewSdkEventsInput = {
  runtime: ReviewRuntimeState;
  sdk: ReturnType<typeof createSubagentSDK>;
  syncReviewWidget: (ctx: ExtensionContext) => void;
  isTerminalReviewStatus: (status: string) => status is ReviewTerminalStatus;
  finalizeReview: (
    ctx: ExtensionContext,
    status: ReviewTerminalStatus,
    summary: string | undefined,
  ) => Promise<void>;
};

export function subscribeReviewSdkEvents(input: SubscribeReviewSdkEventsInput): () => void {
  return input.sdk.onEvent((event) => {
    if (
      input.runtime.subagentSessionId === undefined ||
      input.runtime.subagentSessionId.length === 0 ||
      event.state.sessionId !== input.runtime.subagentSessionId
    ) {
      return;
    }

    const ctx = input.runtime.ctx;
    if (!ctx) {
      return;
    }

    try {
      input.syncReviewWidget(ctx);
      if (
        input.isTerminalReviewStatus(event.state.status) &&
        input.runtime.completionNotifiedSessionId !== event.state.sessionId
      ) {
        input.runtime.completionNotifiedSessionId = event.state.sessionId;
        void input.finalizeReview(ctx, event.state.status, event.state.summary).catch((error) => {
          if (isStaleSessionReplacementContextError(error)) {
            input.runtime.ctx = undefined;
            return;
          }
          throw error;
        });
      }
    } catch (error) {
      if (isStaleSessionReplacementContextError(error)) {
        input.runtime.ctx = undefined;
        return;
      }
      throw error;
    }
  });
}

type FinalizeReviewInput = {
  ctx: ExtensionContext;
  status: ReviewTerminalStatus;
  summary?: string;
  runtime: ReviewRuntimeState;
  clearReviewState: (ctx: ExtensionContext) => void;
  restoreCheckoutTarget: (checkoutToRestore: ReviewRuntimeState["checkoutToRestore"]) => Promise<{
    success: boolean;
    error?: string;
  }>;
  offerCompletionActions: (
    ctx: ExtensionContext,
    summary: string,
    branchAnchorId: string | undefined,
  ) => Promise<void>;
};

export async function finalizeReviewRun(input: FinalizeReviewInput): Promise<void> {
  const checkoutToRestore = input.runtime.checkoutToRestore;
  const commandActions = input.runtime.commandActions;
  const branchAnchorId = input.runtime.branchAnchorId;
  input.clearReviewState(input.ctx);
  input.runtime.commandActions = commandActions;

  const restoreResult = await input.restoreCheckoutTarget(checkoutToRestore);
  if (!restoreResult.success) {
    input.ctx.ui.notify(`Failed to restore checkout: ${restoreResult.error}`, "error");
  }

  let completionMessage = "Review failed.";
  if (input.status === "completed") {
    completionMessage = "Review complete.";
  } else if (input.status === "cancelled") {
    completionMessage = "Review cancelled.";
  }
  const completionType = input.status === "completed" ? "info" : "warning";
  input.ctx.ui.notify(completionMessage, completionType);

  if (
    input.status === "completed" &&
    input.summary !== undefined &&
    input.summary.trim().length > 0
  ) {
    await input.offerCompletionActions(input.ctx, input.summary, branchAnchorId);
  }

  input.runtime.commandActions = undefined;
}
