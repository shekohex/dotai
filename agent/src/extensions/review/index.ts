import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isChildSession, readChildState } from "../../subagent-sdk/index.js";
import { copyTextToClipboard } from "../../utils/clipboard.js";
import { errorMessage } from "../../utils/error-message.js";
import {
  generateContextTransferSummary,
  generateContextTransferSummaryWithLoader,
  getConversationMessages,
  type SummaryGenerationResult,
} from "../session-launch-utils.js";
import { launchHandoffSession } from "../handoff.js";
import {
  buildReviewHandoffPrompt,
  buildReviewTaskPrompt,
  getReviewSettings,
  getReviewState,
  isReviewStateActiveOnBranch,
  isTerminalReviewStatus,
  loadProjectReviewGuidelines,
  offerCompletionActions,
  parsePrReference,
  parseReviewPaths,
  REVIEW_SETTINGS_TYPE,
  REVIEW_STATE_TYPE,
  restoreCheckoutTarget,
  applyAllReviewState as applyAllReviewStateWithDeps,
  clearReviewState as clearReviewStateWithDeps,
  createPullRequestTargetResolver,
  createReviewExecutor,
  createReviewSubagentSdk,
  finalizeReviewRun,
  persistReviewSettings as persistReviewSettingsWithRuntime,
  registerReviewHandlers,
  setReviewCustomInstructions as setReviewCustomInstructionsWithRuntime,
  subscribeReviewSdkEvents,
  type CreateReviewExtensionOptions,
  type ReviewCheckoutTarget,
  type ReviewRuntimeState,
  type ReviewSessionState,
} from "./deps.js";

export {
  buildReviewHandoffPrompt,
  isReviewStateActiveOnBranch,
  loadProjectReviewGuidelines,
  parsePrReference,
  parseReviewPaths,
};

function formatErrorMessage(error: unknown): string {
  return errorMessage(error);
}

export function createReviewExtension(extensionOptions?: CreateReviewExtensionOptions) {
  const resolvedOptions = extensionOptions ?? { enabled: true };

  return (pi: ExtensionAPI) => {
    if (resolvedOptions.enabled !== false) {
      new ReviewExtensionRuntime(resolvedOptions, pi).register();
    }
  };
}

class ReviewExtensionRuntime {
  private readonly runtime: ReviewRuntimeState = {
    ctx: undefined,
    active: false,
    subagentSessionId: undefined,
    targetLabel: undefined,
    branchAnchorId: undefined,
    checkoutToRestore: undefined,
    customInstructions: undefined,
    completionNotifiedSessionId: undefined,
    commandActions: undefined,
  };
  private sdk: ReturnType<typeof createReviewSubagentSdk>;
  private stopSdkEvents: (() => void) | undefined;

  constructor(
    private readonly options: CreateReviewExtensionOptions,
    private readonly pi: ExtensionAPI,
  ) {
    this.sdk = createReviewSubagentSdk(options, pi);
  }

  register(): void {
    this.attachSdkEvents();
    const executeReview = createReviewExecutor({
      pi: this.pi,
      runtime: this.runtime,
      getSdk: () => this.sdk,
      generateReviewHandoff: (input) => this.generateReviewHandoff(input),
      restoreCheckoutAfterFailedStart: (ctx, checkout) =>
        this.restoreCheckoutAfterFailedStart(ctx, checkout),
      buildReviewTaskPrompt,
      clearReviewState: (ctx) => {
        this.clearReviewState(ctx);
      },
      persistReviewState: (state) => {
        this.persistReviewState(state);
      },
      formatErrorMessage,
    });
    registerReviewHandlers({
      pi: this.pi,
      getRuntimeActive: () => this.runtime.active,
      getCustomInstructions: () => this.runtime.customInstructions,
      setCustomInstructions: (instructions) => {
        this.setReviewCustomInstructions(instructions);
      },
      applyAllReviewState: (ctx) => this.applyAllReviewState(ctx),
      shutdownRuntime: () => {
        this.shutdown();
      },
      resolvePullRequestTarget: createPullRequestTargetResolver(this.pi),
      executeReview,
    });
  }

  private generateReviewHandoff(input: {
    ctx: ExtensionCommandContext;
    goal: string;
    messages: ReturnType<typeof getConversationMessages>;
  }): Promise<SummaryGenerationResult> {
    if (this.options.handoffGenerator) {
      return this.options.handoffGenerator(input);
    }
    if (input.ctx.hasUI) {
      return generateContextTransferSummaryWithLoader(
        input.ctx,
        input.goal,
        input.messages,
        "Generating review handoff...",
      );
    }
    return generateContextTransferSummary(input.ctx, input.goal, input.messages);
  }

  private async restoreCheckoutAfterFailedStart(
    ctx: ExtensionContext,
    checkoutToRestore: ReviewCheckoutTarget | undefined,
  ): Promise<void> {
    const result = await restoreCheckoutTarget(this.pi, checkoutToRestore);
    if (!result.success) {
      ctx.ui.notify(`Failed to restore checkout: ${result.error}`, "error");
    }
  }

  private async finalizeReview(
    ctx: ExtensionContext,
    status: "completed" | "failed" | "cancelled",
    summary?: string,
  ): Promise<void> {
    await finalizeReviewRun({
      ctx,
      status,
      summary,
      runtime: this.runtime,
      clearReviewState: (clearContext) => {
        this.clearReviewState(clearContext);
      },
      restoreCheckoutTarget: (checkout) => restoreCheckoutTarget(this.pi, checkout),
      offerCompletionActions: (completionCtx, completionSummary, branchAnchorId) =>
        offerCompletionActions(completionCtx, completionSummary, branchAnchorId, {
          options: this.options,
          getCommandActions: () => this.runtime.commandActions,
          launchHandoffSession: ({ ctx: handoffCtx, newSession, goal }) =>
            launchHandoffSession({ pi: this.pi, ctx: handoffCtx, newSession, goal }),
          copyTextToClipboard,
          sendAddressPrompt: (prompt) => {
            this.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
          },
        }),
    });
  }

  private attachSdkEvents(): void {
    this.stopSdkEvents?.();
    this.stopSdkEvents = subscribeReviewSdkEvents({
      runtime: this.runtime,
      sdk: this.sdk,
      isTerminalReviewStatus,
      finalizeReview: (ctx, status, summary) => this.finalizeReview(ctx, status, summary),
    });
  }

  private resetSdk(): void {
    this.stopSdkEvents?.();
    this.sdk.dispose();
    this.sdk = createReviewSubagentSdk(this.options, this.pi);
    this.attachSdkEvents();
  }

  private persistReviewSettings(): void {
    persistReviewSettingsWithRuntime(this.runtime, (state) => {
      this.pi.appendEntry(REVIEW_SETTINGS_TYPE, state);
    });
  }

  private setReviewCustomInstructions(instructions: string | undefined): void {
    setReviewCustomInstructionsWithRuntime(this.runtime, instructions, () => {
      this.persistReviewSettings();
    });
  }

  private async applyAllReviewState(ctx: ExtensionContext): Promise<void> {
    await applyAllReviewStateWithDeps(ctx, {
      runtime: this.runtime,
      sdk: this.sdk,
      getReviewSettings,
      getReviewState,
      isReviewStateActiveOnBranch,
      resetSdk: () => {
        this.resetSdk();
      },
      readChildState,
      isChildSession,
      isTerminalReviewStatus,
      onTerminalState: (terminalCtx, state) => {
        if (isTerminalReviewStatus(state.status)) {
          void this.finalizeReview(terminalCtx, state.status, state.summary);
        }
      },
      persistReviewState: (state) => {
        this.persistReviewState(state);
      },
    });
  }

  private persistReviewState(state: ReviewSessionState): void {
    this.pi.appendEntry(REVIEW_STATE_TYPE, state);
  }

  private clearReviewState(ctx: ExtensionContext): void {
    clearReviewStateWithDeps(ctx, {
      runtime: this.runtime,
      sdk: this.sdk,
      getReviewSettings,
      getReviewState,
      isReviewStateActiveOnBranch,
      resetSdk: () => {
        this.resetSdk();
      },
      readChildState,
      isChildSession,
      isTerminalReviewStatus,
      onTerminalState: () => {},
      persistReviewState: (state) => {
        this.persistReviewState(state);
      },
    });
  }

  private shutdown(): void {
    this.runtime.ctx = undefined;
    this.runtime.commandActions = undefined;
    this.stopSdkEvents?.();
    this.stopSdkEvents = undefined;
    this.sdk.dispose();
  }
}

export default createReviewExtension();
