import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  buildContextTransferPrompt,
  generateContextTransferSummary,
  generateContextTransferSummaryWithLoader,
  getConversationMessages,
  resolveSessionLaunchOptions,
  type SummaryGenerationResult,
} from "../session-launch-utils.js";
import { parseCommandArgs } from "./args.js";
import {
  applyPendingSelection,
  createPendingNewSessionContext,
  getPendingCommandHandoff,
  setPendingCommandHandoff,
  waitForPendingNewSessionContext,
  type HandoffLaunchResult,
  type HandoffOptions,
  type HandoffRuntimeState,
  type ResolvedHandoffOptions,
} from "./shared.js";

function resolveHandoffOptions(
  ctx: ExtensionContext,
  options: HandoffOptions,
): Promise<{ overrides?: ResolvedHandoffOptions; error?: string }> {
  return resolveSessionLaunchOptions(ctx, options);
}

function prepareHandoffGenerationUpdate(onUpdate?: AgentToolUpdateCallback<unknown>): void {
  if (onUpdate === undefined) {
    return;
  }
  onUpdate({
    content: [{ type: "text", text: "Generating handoff prompt..." }],
    details: { status: "loading" },
  });
}

function generateHandoffWithSummary(
  ctx: ExtensionContext,
  goal: string,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  signal: AbortSignal | undefined,
): Promise<SummaryGenerationResult> {
  const messages = getConversationMessages(ctx);
  const shouldUseLoader = ctx.hasUI && onUpdate === undefined;
  return shouldUseLoader
    ? generateContextTransferSummaryWithLoader(ctx, goal, messages)
    : generateContextTransferSummary(ctx, goal, messages, signal);
}

async function maybeReviewPrompt(
  ctx: ExtensionContext,
  prompt: string,
  reviewPrompt: boolean,
): Promise<{ prompt: string; cancelled: boolean }> {
  if (!reviewPrompt) {
    return { prompt, cancelled: false };
  }
  const editedPrompt = await ctx.ui.editor("Edit handoff prompt", prompt);
  if (editedPrompt === undefined) {
    return { prompt, cancelled: true };
  }
  return { prompt: editedPrompt, cancelled: false };
}

async function resolvePreparedPrompt(
  ctx: ExtensionContext,
  summary: string,
  reviewPrompt: boolean,
): Promise<{ prompt: string; parentSession?: string; cancelled: boolean }> {
  const parentSession = ctx.sessionManager.getSessionFile();
  const initialPrompt = buildContextTransferPrompt(summary, parentSession) ?? "";
  const promptResult = await maybeReviewPrompt(ctx, initialPrompt, reviewPrompt);
  return { prompt: promptResult.prompt, parentSession, cancelled: promptResult.cancelled };
}

function validateHandoffPreconditions(ctx: ExtensionContext): string | undefined {
  if (ctx.model === undefined) {
    return "No model selected";
  }
  if (getConversationMessages(ctx).length === 0) {
    return "No conversation to hand off";
  }
  return undefined;
}

async function prepareHandoff(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  goal: string,
  options: HandoffOptions,
  reviewPrompt: boolean,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<unknown>,
): Promise<{
  prompt: string;
  parentSession?: string;
  overrides?: ResolvedHandoffOptions;
  warning?: string;
  error?: string;
}> {
  const preconditionError = validateHandoffPreconditions(ctx);
  if (preconditionError !== undefined) {
    return { prompt: "", error: preconditionError };
  }

  const resolved = await resolveHandoffOptions(ctx, options);
  if (resolved.error !== undefined && resolved.error.length > 0) {
    return { prompt: "", error: resolved.error };
  }

  prepareHandoffGenerationUpdate(onUpdate);
  const generation = await generateHandoffWithSummary(ctx, goal, onUpdate, signal);
  if (generation.error !== undefined && generation.error.length > 0) {
    return { prompt: "", error: generation.error };
  }
  if (
    generation.aborted === true ||
    generation.summary === undefined ||
    generation.summary.length === 0
  ) {
    return { prompt: "", error: "Cancelled" };
  }

  const prepared = await resolvePreparedPrompt(ctx, generation.summary, reviewPrompt);
  if (prepared.cancelled) {
    return { prompt: "", error: "Cancelled" };
  }

  return {
    prompt: prepared.prompt,
    parentSession: prepared.parentSession,
    overrides: resolved.overrides,
    warning: generation.warning,
  };
}

async function completePendingLaunch(
  input: {
    pi: ExtensionAPI;
    ctx: ExtensionContext;
  },
  state: HandoffRuntimeState,
  warning: string | undefined,
): Promise<HandoffLaunchResult> {
  await waitForPendingNewSessionContext(state, input.ctx);
  const pendingCommandHandoff = getPendingCommandHandoff();
  if (!pendingCommandHandoff) {
    return { status: "started", warning };
  }
  const targetCtx = state.ctx ?? input.ctx;
  await applyPendingSelection(input.pi, targetCtx, pendingCommandHandoff.overrides);
  setPendingCommandHandoff(undefined);
  if (pendingCommandHandoff.autoSend) {
    setTimeout(() => {
      input.pi.sendUserMessage(pendingCommandHandoff.prompt);
    }, 0);
  }
  return { status: "started", warning };
}

function clearPendingLaunch(state: HandoffRuntimeState): HandoffLaunchResult {
  state.pendingNewSessionCtx = undefined;
  setPendingCommandHandoff(undefined);
  return { status: "cancelled" };
}

async function launchHandoffSession(input: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  newSession: ExtensionCommandContext["newSession"];
  goal: string;
  options?: HandoffOptions;
  state?: HandoffRuntimeState;
}): Promise<HandoffLaunchResult> {
  const state = input.state ?? { ctx: input.ctx };
  state.ctx = input.ctx;

  const result = await prepareHandoff(input.pi, input.ctx, input.goal, input.options ?? {}, false);
  if (result.error !== undefined && result.error.length > 0) {
    if (result.error === "Cancelled") {
      return { status: "cancelled" };
    }
    return { status: "error", error: result.error };
  }

  setPendingCommandHandoff({
    prompt: result.prompt,
    autoSend: true,
    overrides: result.overrides,
  });
  void createPendingNewSessionContext(state);

  const newSessionResult = await input.newSession({
    parentSession: result.parentSession,
  });

  if (newSessionResult.cancelled) {
    return clearPendingLaunch(state);
  }
  return completePendingLaunch(input, state, result.warning);
}

async function handleHandoffCommand(
  pi: ExtensionAPI,
  state: HandoffRuntimeState,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("handoff requires interactive mode", "error");
    return;
  }

  const parsed = parseCommandArgs(args);
  if (parsed.error !== undefined && parsed.error.length > 0) {
    ctx.ui.notify(parsed.error, "error");
    return;
  }

  if (!parsed.goal) {
    ctx.ui.notify("Usage: /handoff [-mode <name>] [-model <provider/modelId>] <goal>", "error");
    return;
  }

  const result = await launchHandoffSession({
    pi,
    ctx,
    newSession: (options) => ctx.newSession(options),
    goal: parsed.goal,
    options: parsed.options,
    state,
  });
  if (result.status === "error") {
    ctx.ui.notify(result.error, "error");
    return;
  }
  if (result.status === "cancelled") {
    ctx.ui.notify("New session cancelled", "info");
    return;
  }
  if (result.warning !== undefined && result.warning.length > 0) {
    ctx.ui.notify(result.warning, "warning");
  }
}

export { handleHandoffCommand, launchHandoffSession };
