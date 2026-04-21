import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { ParsedReviewArgs, ReviewTarget } from "./deps.js";

type ResolvedInitialReviewTarget = {
  target: ReviewTarget | null;
  fromSelector: boolean;
  aborted: boolean;
};

type ReviewCommandLoopInput = {
  target: ReviewTarget | null;
  fromSelector: boolean;
  parsed: ParsedReviewArgs;
};

type EnsureReviewCommandCanRunDeps = {
  isRuntimeActive: () => boolean;
  execGitCheck: () => Promise<{ code: number }>;
};

type RunReviewCommandDeps = {
  ensureReviewCommandCanRun: (ctx: ExtensionCommandContext) => Promise<boolean>;
  parseArgs: (args: string | undefined) => ParsedReviewArgs;
  resolveInitialReviewTarget: (
    ctx: ExtensionCommandContext,
    parsed: ParsedReviewArgs,
  ) => Promise<ResolvedInitialReviewTarget>;
  runReviewCommandLoop: (
    ctx: ExtensionCommandContext,
    input: ReviewCommandLoopInput,
  ) => Promise<void>;
};

export async function ensureReviewCommandCanRun(
  ctx: ExtensionCommandContext,
  deps: EnsureReviewCommandCanRunDeps,
): Promise<boolean> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Review requires interactive mode", "error");
    return false;
  }

  if (deps.isRuntimeActive()) {
    ctx.ui.notify("A review is already running. Wait for it to finish first.", "warning");
    return false;
  }

  const gitCheck = await deps.execGitCheck();
  if (gitCheck.code !== 0) {
    ctx.ui.notify("Not a git repository", "error");
    return false;
  }

  return true;
}

export async function runReviewCommand(
  args: string | undefined,
  ctx: ExtensionCommandContext,
  deps: RunReviewCommandDeps,
): Promise<void> {
  if (!(await deps.ensureReviewCommandCanRun(ctx))) {
    return;
  }

  const parsed = deps.parseArgs(args);
  if (parsed.error !== undefined && parsed.error.length > 0) {
    ctx.ui.notify(parsed.error, "error");
    return;
  }

  const resolvedTarget = await deps.resolveInitialReviewTarget(ctx, parsed);
  if (resolvedTarget.aborted) {
    return;
  }

  await deps.runReviewCommandLoop(ctx, {
    target: resolvedTarget.target,
    fromSelector: resolvedTarget.fromSelector,
    parsed,
  });
}
