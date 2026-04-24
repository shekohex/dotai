import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isStaleSessionReplacementContextError } from "../session-replacement.js";
import type { RuntimeSubagent } from "../../subagent-sdk/index.js";
import type { ReviewCheckoutTarget, ReviewSessionState, ReviewSettingsState } from "./deps.js";

type ReviewCommandActions = {
  navigateTree: ExtensionCommandContext["navigateTree"];
  newSession: ExtensionCommandContext["newSession"];
};

export type ReviewRuntimeState = {
  ctx: ExtensionContext | undefined;
  active: boolean;
  subagentSessionId: string | undefined;
  targetLabel: string | undefined;
  branchAnchorId: string | undefined;
  checkoutToRestore: ReviewCheckoutTarget | undefined;
  customInstructions: string | undefined;
  completionNotifiedSessionId: string | undefined;
  commandActions: ReviewCommandActions | undefined;
};

type RuntimeStateDeps<TChildState> = {
  runtime: ReviewRuntimeState;
  sdk: {
    get: (sessionId: string) => { getState: () => RuntimeSubagent } | undefined;
    restore: (ctx: ExtensionContext) => Promise<unknown>;
  };
  getReviewSettings: (ctx: ExtensionContext) => ReviewSettingsState;
  getReviewState: (ctx: ExtensionContext) => ReviewSessionState | undefined;
  isReviewStateActiveOnBranch: (
    state: ReviewSessionState | undefined,
    branchEntries: Array<{ id?: string }>,
  ) => state is ReviewSessionState;
  resetSdk: () => void;
  setReviewWidget: (
    ctx: ExtensionContext,
    options:
      | undefined
      | {
          targetLabel?: string;
          statusText?: string;
        },
  ) => void;
  readChildState: () => TChildState;
  isChildSession: (state: TChildState, ctx: ExtensionContext) => boolean;
  isTerminalReviewStatus: (status: string) => status is "completed" | "failed" | "cancelled";
  onTerminalState: (ctx: ExtensionContext, state: RuntimeSubagent) => void;
  persistReviewState: (state: ReviewSessionState) => void;
};

export function persistReviewSettings(
  runtime: ReviewRuntimeState,
  persistSettingsState: (state: ReviewSettingsState) => void,
): void {
  persistSettingsState({
    customInstructions: runtime.customInstructions,
  });
}

export function setReviewCustomInstructions(
  runtime: ReviewRuntimeState,
  instructions: string | undefined,
  persistSettings: () => void,
): void {
  const trimmedInstructions = instructions?.trim();
  runtime.customInstructions =
    trimmedInstructions !== undefined && trimmedInstructions.length > 0
      ? trimmedInstructions
      : undefined;
  persistSettings();
}

export function readTrackedReviewState(
  runtime: ReviewRuntimeState,
  sdk: RuntimeStateDeps<unknown>["sdk"],
): RuntimeSubagent | undefined {
  const sessionId = runtime.subagentSessionId;
  const session = sessionId !== undefined && sessionId.length > 0 ? sdk.get(sessionId) : undefined;
  return session?.getState();
}

export function reviewStatusText(state: RuntimeSubagent | undefined): string | undefined {
  if (!state) {
    return undefined;
  }

  if (state.status === "running") {
    return "running";
  }
  if (state.status === "idle") {
    return "waiting for completion summary";
  }
  if (state.status === "completed") {
    return "completing";
  }
  if (state.status === "failed") {
    return "failed, review output captured";
  }
  if (state.status === "cancelled") {
    return "cancelled";
  }

  return state.status;
}

export function syncReviewWidget(
  ctx: ExtensionContext,
  runtime: ReviewRuntimeState,
  trackedState: RuntimeSubagent | undefined,
  setReviewWidget: RuntimeStateDeps<unknown>["setReviewWidget"],
): void {
  try {
    if (!runtime.active) {
      setReviewWidget(ctx, undefined);
      return;
    }

    setReviewWidget(ctx, {
      targetLabel: runtime.targetLabel,
      statusText: reviewStatusText(trackedState),
    });
  } catch (error) {
    if (!isStaleSessionReplacementContextError(error)) {
      throw error;
    }
  }
}

function applyReviewState<TChildState>(
  ctx: ExtensionContext,
  deps: RuntimeStateDeps<TChildState>,
): void {
  const previousSessionId = deps.runtime.subagentSessionId;
  const state = deps.getReviewState(ctx);
  const activeState = deps.isReviewStateActiveOnBranch(state, ctx.sessionManager.getBranch())
    ? state
    : undefined;
  deps.runtime.active = Boolean(activeState?.active);
  deps.runtime.subagentSessionId = activeState?.subagentSessionId;
  deps.runtime.targetLabel = activeState?.targetLabel;
  deps.runtime.branchAnchorId = activeState?.branchAnchorId;
  deps.runtime.checkoutToRestore = activeState?.checkoutToRestore;
  if (
    previousSessionId !== undefined &&
    previousSessionId.length > 0 &&
    previousSessionId !== deps.runtime.subagentSessionId
  ) {
    deps.resetSdk();
  }
  if (activeState?.active !== true) {
    deps.runtime.completionNotifiedSessionId = undefined;
  }
  syncReviewWidget(
    ctx,
    deps.runtime,
    readTrackedReviewState(deps.runtime, deps.sdk),
    deps.setReviewWidget,
  );
}

async function restoreTrackedReviewSubagent<TChildState>(
  ctx: ExtensionContext,
  deps: RuntimeStateDeps<TChildState>,
): Promise<void> {
  if (
    deps.runtime.subagentSessionId === undefined ||
    deps.runtime.subagentSessionId.length === 0 ||
    deps.sdk.get(deps.runtime.subagentSessionId)
  ) {
    return;
  }

  if (deps.isChildSession(deps.readChildState(), ctx)) {
    return;
  }

  await deps.sdk.restore(ctx);
}

export function isTrackedReviewTerminal(state: RuntimeSubagent | undefined): boolean {
  return Boolean(state && ["completed", "failed", "cancelled"].includes(state.status));
}

export async function applyAllReviewState<TChildState>(
  ctx: ExtensionContext,
  deps: RuntimeStateDeps<TChildState>,
): Promise<void> {
  try {
    deps.runtime.ctx = ctx;
    deps.runtime.customInstructions = deps.getReviewSettings(ctx).customInstructions;
    applyReviewState(ctx, deps);
    await restoreTrackedReviewSubagent(ctx, deps);
    const trackedState = readTrackedReviewState(deps.runtime, deps.sdk);
    syncReviewWidget(ctx, deps.runtime, trackedState, deps.setReviewWidget);
    if (!deps.runtime.active || !isTrackedReviewTerminal(trackedState) || !trackedState) {
      return;
    }

    if (
      deps.isTerminalReviewStatus(trackedState.status) &&
      deps.runtime.completionNotifiedSessionId !== trackedState.sessionId
    ) {
      deps.runtime.completionNotifiedSessionId = trackedState.sessionId;
      deps.onTerminalState(ctx, trackedState);
    }
  } catch (error) {
    if (!isStaleSessionReplacementContextError(error)) {
      throw error;
    }
    deps.runtime.ctx = undefined;
  }
}

export function clearReviewState<TChildState>(
  ctx: ExtensionContext,
  deps: RuntimeStateDeps<TChildState>,
): void {
  deps.resetSdk();
  deps.runtime.active = false;
  deps.runtime.subagentSessionId = undefined;
  deps.runtime.targetLabel = undefined;
  deps.runtime.branchAnchorId = undefined;
  deps.runtime.checkoutToRestore = undefined;
  deps.runtime.completionNotifiedSessionId = undefined;
  deps.runtime.commandActions = undefined;
  deps.persistReviewState({ active: false });
  syncReviewWidget(ctx, deps.runtime, undefined, deps.setReviewWidget);
}
