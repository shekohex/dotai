import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import type { HandoffLaunchResult } from "../handoff.js";
import { REVIEW_ADDRESS_FINDINGS_PROMPT, type CreateReviewExtensionOptions } from "./deps.js";

type CompletionAction = "address" | "copy" | "fork" | "handoff" | undefined;

type ReviewCommandActions = {
  navigateTree: ExtensionCommandContext["navigateTree"];
  newSession: ExtensionCommandContext["newSession"];
};

type OfferCompletionActionsDeps = {
  options: Pick<
    CreateReviewExtensionOptions,
    | "completionActionPicker"
    | "clipboardWriter"
    | "handoffAddressRunner"
    | "reviewFixBranchNavigator"
  >;
  getCommandActions: () => ReviewCommandActions | undefined;
  launchHandoffSession: (input: {
    ctx: ExtensionContext;
    newSession: ExtensionCommandContext["newSession"];
    goal: string;
  }) => Promise<HandoffLaunchResult>;
  copyTextToClipboard: (text: string) => Promise<void>;
  sendAddressPrompt: (prompt: string) => void;
};

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveForkBranchTargetId(
  ctx: ExtensionContext,
  branchAnchorId: string | undefined,
): string | null {
  const branchTargetId = branchAnchorId ?? null;
  if (branchTargetId !== null && branchTargetId.length > 0) {
    return branchTargetId;
  }

  ctx.ui.notify("Failed to create a review fix branch from the current session state.", "error");
  return null;
}

async function selectDefaultCompletionAction(input: {
  ctx: ExtensionContext;
  supportsHandoff: boolean;
  supportsFork: boolean;
}): Promise<CompletionAction> {
  const actions = ["Copy review summary", "Address the review"];
  if (input.supportsHandoff) {
    actions.push("Handoff and address the review");
  }
  if (input.supportsFork) {
    actions.push("Fork and address the review");
  }

  const choice = await input.ctx.ui.select("Review subagent finished:", actions);
  if (choice === undefined) {
    return undefined;
  }

  if (choice === "Copy review summary") {
    return "copy";
  }

  if (choice === "Address the review") {
    return "address";
  }

  if (choice === "Handoff and address the review") {
    return "handoff";
  }

  return "fork";
}

function buildAddressReviewPrompt(summary: string): string {
  return `${REVIEW_ADDRESS_FINDINGS_PROMPT}\n\n## Review Summary\n${summary.trim()}`;
}

function resolveCompletionAction(
  ctx: ExtensionContext,
  summary: string,
  deps: OfferCompletionActionsDeps,
): Promise<CompletionAction> {
  const commandActions = deps.getCommandActions();
  const supportsFork = Boolean(
    commandActions?.navigateTree ?? deps.options.reviewFixBranchNavigator,
  );
  const supportsHandoff = Boolean(commandActions?.newSession);
  return deps.options.completionActionPicker
    ? deps.options.completionActionPicker({ ctx, summary })
    : selectDefaultCompletionAction({
        ctx,
        supportsHandoff,
        supportsFork,
      });
}

async function handleCopyCompletionAction(
  ctx: ExtensionContext,
  summary: string,
  deps: OfferCompletionActionsDeps,
): Promise<void> {
  try {
    await (deps.options.clipboardWriter ?? deps.copyTextToClipboard)(summary);
    ctx.ui.notify("Copied review summary to clipboard.", "info");
  } catch (error) {
    ctx.ui.notify(
      `Failed to copy review summary: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

async function handleHandoffCompletionAction(
  ctx: ExtensionContext,
  summary: string,
  deps: OfferCompletionActionsDeps,
): Promise<void> {
  const newSession = deps.getCommandActions()?.newSession;
  if (!newSession) {
    ctx.ui.notify(
      "Review handoff is unavailable after session reload. Start a new handoff manually.",
      "error",
    );
    return;
  }

  const handoffGoal = `Please Address and fix the following findings:\n${summary.trim()}`;
  let handoffResult: HandoffLaunchResult;
  try {
    handoffResult = deps.options.handoffAddressRunner
      ? await deps.options.handoffAddressRunner({
          ctx,
          newSession,
          goal: handoffGoal,
        })
      : await deps.launchHandoffSession({
          ctx,
          newSession,
          goal: handoffGoal,
        });
  } catch (error) {
    ctx.ui.notify(
      `Failed to start review handoff: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }

  if (handoffResult.status === "cancelled") {
    ctx.ui.notify("New session cancelled", "info");
    return;
  }

  if (handoffResult.status === "error") {
    ctx.ui.notify(handoffResult.error, "error");
    return;
  }

  if (handoffResult.warning !== undefined && handoffResult.warning.length > 0) {
    ctx.ui.notify(handoffResult.warning, "warning");
  }
}

function createReviewFixBranchNavigator(deps: OfferCompletionActionsDeps) {
  return (
    deps.options.reviewFixBranchNavigator ??
    (({
      targetId,
      summarize,
      label,
    }: {
      ctx: ExtensionContext;
      targetId: string;
      summarize: boolean;
      label: string;
    }) => {
      const navigateTree = deps.getCommandActions()?.navigateTree;
      if (!navigateTree) {
        throw new Error(
          "Forking review fixes is unavailable after session reload. Start a new session manually.",
        );
      }

      return navigateTree(targetId, {
        summarize,
        label,
      });
    })
  );
}

async function runForkNavigationWithLoader(
  ctx: ExtensionContext,
  navigationResultPromise: Promise<{ cancelled: boolean; error?: string }>,
): Promise<{ cancelled: boolean; error?: string }> {
  const loaderResult = await ctx.ui.custom<{ cancelled: boolean; error?: string } | undefined>(
    (tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, "Forking review fixes with summary...");
      void navigationResultPromise.then(done).catch((error) => {
        done({
          cancelled: false,
          error: formatErrorMessage(error),
        });
      });
      return loader;
    },
  );

  return loaderResult ?? navigationResultPromise;
}

async function handleForkCompletionAction(
  ctx: ExtensionContext,
  branchAnchorId: string | undefined,
  deps: OfferCompletionActionsDeps,
): Promise<boolean> {
  const branchTargetId = resolveForkBranchTargetId(ctx, branchAnchorId);
  if (branchTargetId === null) {
    return false;
  }

  try {
    const result = await runForkNavigationWithLoader(
      ctx,
      createReviewFixBranchNavigator(deps)({
        ctx,
        targetId: branchTargetId,
        summarize: true,
        label: "review-fixes",
      }),
    );
    if (result.cancelled) {
      return false;
    }
    ctx.ui.notify("Forked review fixes into a new branch.", "info");
    return true;
  } catch (error) {
    ctx.ui.notify(`Failed to create review fix branch: ${formatErrorMessage(error)}`, "error");
    return false;
  }
}

export async function offerCompletionActions(
  ctx: ExtensionContext,
  summary: string,
  branchAnchorId: string | undefined,
  deps: OfferCompletionActionsDeps,
): Promise<void> {
  if (!ctx.hasUI || summary.trim().length === 0) {
    return;
  }

  const prompt = buildAddressReviewPrompt(summary);
  const selectedAction = await resolveCompletionAction(ctx, summary, deps);
  if (selectedAction === undefined) {
    return;
  }

  if (selectedAction === "copy") {
    await handleCopyCompletionAction(ctx, summary, deps);
    return;
  }

  if (selectedAction === "address") {
    deps.sendAddressPrompt(prompt);
    return;
  }

  if (selectedAction === "handoff") {
    await handleHandoffCompletionAction(ctx, summary, deps);
    return;
  }

  if (!(await handleForkCompletionAction(ctx, branchAnchorId, deps))) {
    return;
  }

  deps.sendAddressPrompt(prompt);
}
