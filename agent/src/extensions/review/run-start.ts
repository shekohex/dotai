import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ReviewCheckoutTarget } from "./deps.js";

type ReviewCommandActions = {
  navigateTree: ExtensionCommandContext["navigateTree"];
  newSession: ExtensionCommandContext["newSession"];
};

type ReviewRuntimeState = {
  active: boolean;
  subagentSessionId: string | undefined;
  targetLabel: string | undefined;
  branchAnchorId: string | undefined;
  checkoutToRestore: ReviewCheckoutTarget | undefined;
  completionNotifiedSessionId: string | undefined;
  commandActions: ReviewCommandActions | undefined;
};

type SpawnReviewResult =
  | { ok: true; value: { handle: { sessionId: string } } }
  | { ok: false; error: { message: string } };

type StartReviewRunInput = {
  ctx: ExtensionCommandContext;
  targetLabel: string;
  fullPrompt: string;
  branchAnchorId: string | undefined;
  checkoutToRestore: ReviewCheckoutTarget | undefined;
};

type StartReviewRunDeps = {
  runtime: ReviewRuntimeState;
  spawn: (
    input: { name: string; task: string; mode: string; cwd: string },
    ctx: ExtensionCommandContext,
  ) => Promise<SpawnReviewResult>;
  restoreCheckoutTarget: (
    checkoutToRestore: ReviewCheckoutTarget | undefined,
  ) => Promise<{ success: boolean; error?: string }>;
  clearReviewState: (ctx: ExtensionContext) => void;
  persistReviewState: (state: {
    active: boolean;
    subagentSessionId: string;
    targetLabel: string;
    branchAnchorId: string | undefined;
    checkoutToRestore: ReviewCheckoutTarget | undefined;
  }) => void;
  syncReviewWidget: (ctx: ExtensionCommandContext) => void;
  formatErrorMessage: (error: unknown) => string;
};

function applyStartedReviewState(
  input: StartReviewRunInput,
  sessionId: string,
  deps: StartReviewRunDeps,
): void {
  deps.runtime.active = true;
  deps.runtime.subagentSessionId = sessionId;
  deps.runtime.targetLabel = input.targetLabel;
  deps.runtime.branchAnchorId = input.branchAnchorId;
  deps.runtime.checkoutToRestore = input.checkoutToRestore;
  deps.runtime.completionNotifiedSessionId = undefined;
  deps.runtime.commandActions = {
    navigateTree: (targetId, navigationOptions) =>
      input.ctx.navigateTree(targetId, navigationOptions),
    newSession: (sessionOptions) => input.ctx.newSession(sessionOptions),
  };
}

function persistStartedReviewState(
  input: StartReviewRunInput,
  sessionId: string,
  deps: StartReviewRunDeps,
): void {
  deps.persistReviewState({
    active: true,
    subagentSessionId: sessionId,
    targetLabel: input.targetLabel,
    branchAnchorId: input.branchAnchorId,
    checkoutToRestore: input.checkoutToRestore,
  });
  deps.syncReviewWidget(input.ctx);
}

async function handleReviewRunStartFailure(
  input: StartReviewRunInput,
  deps: StartReviewRunDeps,
  error: unknown,
): Promise<boolean> {
  const restoreResult = await deps.restoreCheckoutTarget(input.checkoutToRestore);
  if (!restoreResult.success) {
    input.ctx.ui.notify(`Failed to restore checkout: ${restoreResult.error}`, "error");
  }
  deps.clearReviewState(input.ctx);
  input.ctx.ui.notify(`Failed to start review: ${deps.formatErrorMessage(error)}`, "error");
  return false;
}

export async function startReviewRun(
  input: StartReviewRunInput,
  deps: StartReviewRunDeps,
): Promise<boolean> {
  try {
    const started = await deps.spawn(
      {
        name: "review",
        task: input.fullPrompt,
        mode: "review",
        cwd: input.ctx.cwd,
      },
      input.ctx,
    );

    if (!started.ok) {
      throw new Error(started.error.message);
    }

    applyStartedReviewState(input, started.value.handle.sessionId, deps);
    persistStartedReviewState(input, started.value.handle.sessionId, deps);
    return true;
  } catch (error) {
    return handleReviewRunStartFailure(input, deps, error);
  }
}
