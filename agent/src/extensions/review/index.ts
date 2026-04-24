import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { isChildSession, readChildState, type RuntimeSubagent } from "../../subagent-sdk/index.js";
import { copyTextToClipboard } from "../../utils/clipboard.js";
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
  readTrackedReviewState,
  registerReviewHandlers,
  setReviewCustomInstructions as setReviewCustomInstructionsWithRuntime,
  setReviewWidget,
  subscribeReviewSdkEvents,
  syncReviewWidget as syncReviewWidgetWithRuntime,
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
  return error instanceof Error ? error.message : String(error);
}

export function createReviewExtension(extensionOptions?: CreateReviewExtensionOptions) {
  const resolvedOptions = extensionOptions ?? { enabled: true };

  return (pi: ExtensionAPI) => {
    reviewExtension(resolvedOptions, pi);
  };
}

let resolvedOptions: CreateReviewExtensionOptions = { enabled: true };
let pi: ExtensionAPI;
let sdk: ReturnType<typeof createReviewSubagentSdk>;
let stopSdkEvents: (() => void) | undefined;

const runtime: ReviewRuntimeState = {
  ctx: undefined,
  active: false,
  subagentSessionId: undefined,
  targetLabel: undefined,
  branchAnchorId: undefined,
  checkoutToRestore: undefined,
  customInstructions: undefined,
  completionNotifiedSessionId: undefined,
  commandActions: undefined,
  lastWidgetMessage: undefined,
};

function initializeReviewRuntime(
  nextResolvedOptions: CreateReviewExtensionOptions,
  nextPi: ExtensionAPI,
): void {
  resolvedOptions = nextResolvedOptions;
  pi = nextPi;
  sdk = createReviewSubagentSdk(nextResolvedOptions, nextPi);
  stopSdkEvents = undefined;
}

function generateReviewHandoff(input: {
  ctx: ExtensionCommandContext;
  goal: string;
  messages: ReturnType<typeof getConversationMessages>;
}): Promise<SummaryGenerationResult> {
  if (resolvedOptions.handoffGenerator) {
    return resolvedOptions.handoffGenerator(input);
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

async function restoreCheckoutAfterFailedStart(
  ctx: ExtensionContext,
  checkoutToRestore: ReviewCheckoutTarget | undefined,
): Promise<void> {
  const restoreResult = await restoreCheckoutTarget(pi, checkoutToRestore);
  if (!restoreResult.success) {
    ctx.ui.notify(`Failed to restore checkout: ${restoreResult.error}`, "error");
  }
}

async function finalizeReview(
  ctx: ExtensionContext,
  status: "completed" | "failed" | "cancelled",
  summary?: string,
): Promise<void> {
  await finalizeReviewRun({
    ctx,
    status,
    summary,
    runtime,
    clearReviewState,
    restoreCheckoutTarget: (checkoutToRestore) => restoreCheckoutTarget(pi, checkoutToRestore),
    offerCompletionActions: (completionCtx, completionSummary, branchAnchorId) =>
      offerCompletionActions(completionCtx, completionSummary, branchAnchorId, {
        options: resolvedOptions,
        getCommandActions: () => runtime.commandActions,
        launchHandoffSession: ({ ctx: handoffCtx, newSession, goal }) =>
          launchHandoffSession({
            pi,
            ctx: handoffCtx,
            newSession,
            goal,
          }),
        copyTextToClipboard,
        sendAddressPrompt: (prompt) => {
          pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        },
      }),
  });
}

function attachSdkEvents(): void {
  stopSdkEvents?.();
  stopSdkEvents = subscribeReviewSdkEvents({
    runtime,
    sdk,
    syncReviewWidget,
    isTerminalReviewStatus,
    finalizeReview: (eventCtx, eventStatus, eventSummary) =>
      finalizeReview(eventCtx, eventStatus, eventSummary),
  });
}

function resetSdk(): void {
  stopSdkEvents?.();
  stopSdkEvents = undefined;
  sdk.dispose();
  initializeReviewRuntime(resolvedOptions, pi);
  attachSdkEvents();
}

function persistReviewSettings(): void {
  persistReviewSettingsWithRuntime(runtime, (state) => {
    pi.appendEntry(REVIEW_SETTINGS_TYPE, state);
  });
}

function setReviewCustomInstructions(instructions: string | undefined): void {
  setReviewCustomInstructionsWithRuntime(runtime, instructions, persistReviewSettings);
}

function trackedReviewState(): RuntimeSubagent | undefined {
  return readTrackedReviewState(runtime, sdk);
}

function syncReviewWidget(ctx: ExtensionContext): void {
  syncReviewWidgetWithRuntime(ctx, runtime, trackedReviewState(), setReviewWidget);
}

async function applyAllReviewState(ctx: ExtensionContext): Promise<void> {
  await applyAllReviewStateWithDeps(ctx, {
    runtime,
    sdk,
    getReviewSettings,
    getReviewState,
    isReviewStateActiveOnBranch,
    resetSdk,
    setReviewWidget,
    readChildState,
    isChildSession,
    isTerminalReviewStatus,
    onTerminalState: (terminalCtx, state) => {
      if (!isTerminalReviewStatus(state.status)) {
        return;
      }
      void finalizeReview(terminalCtx, state.status, state.summary);
    },
    persistReviewState,
  });
}

function persistReviewState(state: ReviewSessionState): void {
  pi.appendEntry(REVIEW_STATE_TYPE, state);
}

function clearReviewState(ctx: ExtensionContext): void {
  clearReviewStateWithDeps(ctx, {
    runtime,
    sdk,
    getReviewSettings,
    getReviewState,
    isReviewStateActiveOnBranch,
    resetSdk,
    setReviewWidget,
    readChildState,
    isChildSession,
    isTerminalReviewStatus,
    onTerminalState: () => {},
    persistReviewState,
  });
}

function reviewExtension(
  nextResolvedOptions: CreateReviewExtensionOptions,
  nextPi: ExtensionAPI,
): void {
  if (nextResolvedOptions.enabled === false) {
    return;
  }

  initializeReviewRuntime(nextResolvedOptions, nextPi);
  attachSdkEvents();
  const resolvePullRequestTarget = createPullRequestTargetResolver(pi);
  const executeReview = createReviewExecutor({
    pi,
    runtime,
    getSdk: () => sdk,
    generateReviewHandoff,
    restoreCheckoutAfterFailedStart,
    buildReviewTaskPrompt,
    clearReviewState,
    persistReviewState,
    syncReviewWidget,
    formatErrorMessage,
  });
  registerReviewHandlers({
    pi,
    getRuntimeActive: () => runtime.active,
    getCustomInstructions: () => runtime.customInstructions,
    setCustomInstructions: setReviewCustomInstructions,
    applyAllReviewState,
    shutdownRuntime: () => {
      runtime.ctx = undefined;
      runtime.commandActions = undefined;
      stopSdkEvents?.();
      sdk.dispose();
    },
    resolvePullRequestTarget,
    executeReview,
  });
}

export default createReviewExtension();
