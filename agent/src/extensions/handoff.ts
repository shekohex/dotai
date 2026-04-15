import {
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem } from "@mariozechner/pi-tui";

import type { ModeSpec } from "../mode-utils.js";
import { loadAvailableModes } from "./available-modes.js";
import {
  buildContextTransferPrompt,
  generateContextTransferSummary,
  generateContextTransferSummaryWithLoader,
  getConversationMessages,
  resolveSessionLaunchOptions,
  type ResolvedSessionLaunchOptions,
  type SessionLaunchOptions,
  type SessionModel,
} from "./session-launch-utils.js";
import { MODE_SELECTION_APPLY_EVENT } from "./modes.js";
export type HandoffOptions = SessionLaunchOptions;

type ResolvedHandoffOptions = ResolvedSessionLaunchOptions;

type PendingToolHandoff = {
  prompt: string;
  parentSession?: string;
  overrides?: ResolvedHandoffOptions;
};

type PendingSessionHandoff = {
  prompt: string;
  autoSend: boolean;
  overrides?: ResolvedHandoffOptions;
  deferSessionStartApply?: boolean;
};

declare global {
  var __shekohexPendingSessionHandoff: PendingSessionHandoff | undefined;
}

type HandoffFlagName = "-mode" | "-model";

type HandoffAutocompleteContext = {
  kind: "flag" | "mode" | "model" | "goal" | "none";
  prefixBase: string;
  query: string;
  usedFlags: Set<HandoffFlagName>;
};

export type HandoffRuntimeState = {
  ctx?: ExtensionContext;
  pendingNewSessionCtx?: {
    promise: Promise<ExtensionContext>;
    resolve: (ctx: ExtensionContext) => void;
  };
};

export type HandoffLaunchResult =
  | { status: "started"; warning?: string }
  | { status: "cancelled" }
  | { status: "error"; error: string };

const pendingToolHandoffState: {
  pending: PendingToolHandoff | undefined;
  contextCutoffTimestamp: number | undefined;
} = {
  pending: undefined,
  contextCutoffTimestamp: undefined,
};

const HANDOFF_FLAG_OPTIONS: Array<{ name: HandoffFlagName; description: string }> = [
  { name: "-mode", description: "Apply a saved mode to the new session" },
  { name: "-model", description: "Override the new session model (provider/modelId)" },
];

type MutableSessionManager = Pick<SessionManager, "newSession">;

function getPendingCommandHandoff(): PendingSessionHandoff | undefined {
  return globalThis.__shekohexPendingSessionHandoff;
}

function setPendingCommandHandoff(pending: PendingSessionHandoff | undefined): void {
  globalThis.__shekohexPendingSessionHandoff = pending;
}

function startNewSessionInPlace(ctx: ExtensionContext, parentSession?: string): string | undefined {
  const writablePrototype = SessionManager.prototype as unknown as Partial<MutableSessionManager>;
  if (typeof writablePrototype.newSession !== "function") {
    throw new Error("SessionManager newSession is unavailable");
  }

  return writablePrototype.newSession.call(ctx.sessionManager as unknown as SessionManager, {
    parentSession,
  });
}

async function applyPendingSelection(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  overrides?: ResolvedHandoffOptions,
): Promise<void> {
  if (!overrides) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    pi.events.emit(MODE_SELECTION_APPLY_EVENT, {
      ctx,
      mode: overrides.mode,
      targetModel: overrides.targetModel,
      thinkingLevel: overrides.thinkingLevel,
      reason: "restore",
      source: "session_start",
      done: { resolve, reject },
    });
  });
}

function createPendingNewSessionContext(state: HandoffRuntimeState): Promise<ExtensionContext> {
  if (state.pendingNewSessionCtx) {
    return state.pendingNewSessionCtx.promise;
  }

  let resolvePromise: ((ctx: ExtensionContext) => void) | undefined;
  const promise = new Promise<ExtensionContext>((resolve) => {
    resolvePromise = resolve;
  });

  state.pendingNewSessionCtx = {
    promise,
    resolve: (ctx) => {
      resolvePromise?.(ctx);
      state.pendingNewSessionCtx = undefined;
    },
  };

  return promise;
}

async function waitForPendingNewSessionContext(
  state: HandoffRuntimeState,
  fallbackCtx: ExtensionContext,
): Promise<ExtensionContext> {
  const pending = state.pendingNewSessionCtx;
  if (!pending) {
    return state.ctx ?? fallbackCtx;
  }

  return await Promise.race([
    pending.promise,
    new Promise<ExtensionContext>((resolve) => {
      setTimeout(() => {
        resolve(state.ctx ?? fallbackCtx);
      }, 500);
    }),
  ]);
}

function describeModeSpec(spec: ModeSpec | undefined): string | undefined {
  if (!spec) {
    return undefined;
  }

  const parts: string[] = [];
  if (spec.provider && spec.modelId) {
    parts.push(`${spec.provider}/${spec.modelId}`);
  }
  if (spec.thinkingLevel) {
    parts.push(`thinking:${spec.thinkingLevel}`);
  }

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function getAvailableModelsForAutocomplete(ctx: ExtensionContext | undefined): SessionModel[] {
  return (ctx?.modelRegistry.getAvailable() ?? []) as SessionModel[];
}

function filterAutocompleteItems(
  items: AutocompleteItem[],
  query: string,
): AutocompleteItem[] | null {
  if (items.length === 0) {
    return null;
  }

  if (!query) {
    return items;
  }

  const filtered = fuzzyFilter(
    items,
    query,
    (item) => `${item.label} ${item.value} ${item.description ?? ""}`,
  );
  return filtered.length > 0 ? filtered : null;
}

function parseHandoffAutocompleteContext(argumentPrefix: string): HandoffAutocompleteContext {
  const usedFlags = new Set<HandoffFlagName>();
  let index = 0;

  while (index < argumentPrefix.length) {
    while (index < argumentPrefix.length && /\s/.test(argumentPrefix[index]!)) {
      index += 1;
    }

    if (index >= argumentPrefix.length) {
      return { kind: "flag", prefixBase: argumentPrefix, query: "", usedFlags };
    }

    if (argumentPrefix[index] !== "-") {
      return { kind: "goal", prefixBase: argumentPrefix.slice(0, index), query: "", usedFlags };
    }

    const flagStart = index;
    while (index < argumentPrefix.length && !/\s/.test(argumentPrefix[index]!)) {
      index += 1;
    }

    const flagToken = argumentPrefix.slice(flagStart, index);
    const flag = flagToken === "-mode" || flagToken === "-model" ? flagToken : undefined;
    if (!flag) {
      if (index >= argumentPrefix.length) {
        return {
          kind: "flag",
          prefixBase: argumentPrefix.slice(0, flagStart),
          query: flagToken,
          usedFlags,
        };
      }
      return {
        kind: "none",
        prefixBase: argumentPrefix.slice(0, flagStart),
        query: flagToken,
        usedFlags,
      };
    }

    if (index >= argumentPrefix.length) {
      return {
        kind: "flag",
        prefixBase: argumentPrefix.slice(0, flagStart),
        query: flagToken,
        usedFlags,
      };
    }

    while (index < argumentPrefix.length && /\s/.test(argumentPrefix[index]!)) {
      index += 1;
    }

    const valuePrefixBase = argumentPrefix.slice(0, index);
    if (index >= argumentPrefix.length) {
      return {
        kind: flag === "-mode" ? "mode" : "model",
        prefixBase: valuePrefixBase,
        query: "",
        usedFlags,
      };
    }

    const valueStart = index;
    while (index < argumentPrefix.length && !/\s/.test(argumentPrefix[index]!)) {
      index += 1;
    }

    const value = argumentPrefix.slice(valueStart, index);
    if (index >= argumentPrefix.length) {
      return {
        kind: flag === "-mode" ? "mode" : "model",
        prefixBase: argumentPrefix.slice(0, valueStart),
        query: value,
        usedFlags,
      };
    }

    usedFlags.add(flag);

    while (index < argumentPrefix.length && /\s/.test(argumentPrefix[index]!)) {
      index += 1;
    }

    if (index >= argumentPrefix.length) {
      return { kind: "flag", prefixBase: argumentPrefix, query: "", usedFlags };
    }

    if (argumentPrefix[index] !== "-") {
      return { kind: "goal", prefixBase: argumentPrefix.slice(0, index), query: "", usedFlags };
    }
  }

  return { kind: "flag", prefixBase: argumentPrefix, query: "", usedFlags };
}

function getHandoffFlagCompletions(
  prefixBase: string,
  query: string,
  usedFlags: Set<HandoffFlagName>,
): AutocompleteItem[] | null {
  const items = HANDOFF_FLAG_OPTIONS.filter((flag) => !usedFlags.has(flag.name)).map((flag) => ({
    value: `${prefixBase}${flag.name} `,
    label: flag.name,
    description: flag.description,
  }));

  return filterAutocompleteItems(items, query);
}

async function getHandoffModeCompletions(
  prefixBase: string,
  query: string,
  ctx: ExtensionContext | undefined,
): Promise<AutocompleteItem[] | null> {
  if (!ctx) {
    return null;
  }

  const items = (await loadAvailableModes(ctx.cwd)).map(({ name, spec }) => ({
    value: `${prefixBase}${name}`,
    label: name,
    description: describeModeSpec(spec),
  }));

  return filterAutocompleteItems(items, query);
}

function getHandoffModelCompletions(
  prefixBase: string,
  query: string,
  ctx: ExtensionContext | undefined,
): AutocompleteItem[] | null {
  const models = getAvailableModelsForAutocomplete(ctx);
  if (models.length === 0) {
    return null;
  }

  const items = models.map((model) => ({
    value: `${prefixBase}${model.provider}/${model.id}`,
    label: model.id,
    description: model.provider,
  }));

  return filterAutocompleteItems(items, query);
}

async function getHandoffArgumentCompletions(
  argumentPrefix: string,
  state: HandoffRuntimeState,
): Promise<AutocompleteItem[] | null> {
  const parsed = parseHandoffAutocompleteContext(argumentPrefix);
  if (parsed.kind === "goal" || parsed.kind === "none") {
    return null;
  }

  if (parsed.kind === "flag") {
    return getHandoffFlagCompletions(parsed.prefixBase, parsed.query, parsed.usedFlags);
  }

  if (parsed.kind === "mode") {
    return getHandoffModeCompletions(parsed.prefixBase, parsed.query, state.ctx);
  }

  return getHandoffModelCompletions(parsed.prefixBase, parsed.query, state.ctx);
}

function parseCommandArgs(args: string): { goal: string; options: HandoffOptions; error?: string } {
  let remaining = args.trim();
  const options: HandoffOptions = {};

  while (remaining.startsWith("-")) {
    const modeMatch = remaining.match(/^-mode\s+(\S+)(?:\s+|$)/);
    if (modeMatch) {
      options.mode = modeMatch[1];
      remaining = remaining.slice(modeMatch[0].length).trimStart();
      continue;
    }

    const modelMatch = remaining.match(/^-model\s+(\S+)(?:\s+|$)/);
    if (modelMatch) {
      options.model = modelMatch[1];
      remaining = remaining.slice(modelMatch[0].length).trimStart();
      continue;
    }

    return {
      goal: "",
      options,
      error: "Usage: /handoff [-mode <name>] [-model <provider/modelId>] <goal>",
    };
  }

  return {
    goal: remaining.trim(),
    options,
  };
}

async function resolveHandoffOptions(
  ctx: ExtensionContext,
  options: HandoffOptions,
): Promise<{ overrides?: ResolvedHandoffOptions; error?: string }> {
  return resolveSessionLaunchOptions(ctx, options);
}

async function prepareHandoff(
  pi: ExtensionAPI,
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
  if (!ctx.model) {
    return { prompt: "", error: "No model selected" };
  }

  const messages = getConversationMessages(ctx);
  if (messages.length === 0) {
    return { prompt: "", error: "No conversation to hand off" };
  }

  const resolved = await resolveHandoffOptions(ctx, options);
  if (resolved.error) {
    return { prompt: "", error: resolved.error };
  }

  if (onUpdate) {
    onUpdate({
      content: [{ type: "text", text: "Generating handoff prompt..." }],
      details: { status: "loading" },
    });
  }

  const shouldUseLoader = ctx.hasUI && !onUpdate;
  const generation = shouldUseLoader
    ? await generateContextTransferSummaryWithLoader(ctx, goal, messages)
    : await generateContextTransferSummary(ctx, goal, messages, signal);
  if (generation.error) {
    return { prompt: "", error: generation.error };
  }

  if (generation.aborted || !generation.summary) {
    return { prompt: "", error: "Cancelled" };
  }

  const parentSession = ctx.sessionManager.getSessionFile();
  let prompt = buildContextTransferPrompt(generation.summary, parentSession);

  if (reviewPrompt) {
    const editedPrompt = await ctx.ui.editor("Edit handoff prompt", prompt);
    if (editedPrompt === undefined) {
      return { prompt: "", error: "Cancelled" };
    }
    prompt = editedPrompt;
  }

  return {
    prompt,
    parentSession,
    overrides: resolved.overrides,
    warning: generation.warning,
  };
}

export async function launchHandoffSession(input: {
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
  if (result.error) {
    if (result.error === "Cancelled") {
      return { status: "cancelled" };
    }
    return { status: "error", error: result.error };
  }

  setPendingCommandHandoff({
    prompt: result.prompt,
    autoSend: true,
    overrides: result.overrides,
    deferSessionStartApply: Boolean(input.state),
  });
  createPendingNewSessionContext(state);

  const newSessionResult = await input.newSession({
    parentSession: result.parentSession,
  });

  if (newSessionResult.cancelled) {
    state.pendingNewSessionCtx = undefined;
    setPendingCommandHandoff(undefined);
    return { status: "cancelled" };
  }

  await new Promise((resolve) => setTimeout(resolve, 0));

  const pendingCommandHandoff = getPendingCommandHandoff();
  if (!pendingCommandHandoff) {
    return { status: "started", warning: result.warning };
  }

  const targetCtx = await waitForPendingNewSessionContext(state, input.ctx);
  await applyPendingSelection(input.pi, targetCtx, pendingCommandHandoff.overrides);
  setPendingCommandHandoff(undefined);

  if (pendingCommandHandoff.autoSend) {
    setTimeout(() => {
      void input.pi.sendUserMessage(pendingCommandHandoff.prompt);
    }, 0);
  }

  return { status: "started", warning: result.warning };
}

export default function handoffExtension(pi: ExtensionAPI) {
  const state: HandoffRuntimeState = {};

  pi.registerCommand("handoff", {
    description:
      "Transfer context to a new focused session (-mode <name>, -model <provider/modelId>)",
    getArgumentCompletions: (prefix) => getHandoffArgumentCompletions(prefix, state),
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("handoff requires interactive mode", "error");
        return;
      }

      const parsed = parseCommandArgs(args);
      if (parsed.error) {
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

      if (result.warning) {
        ctx.ui.notify(result.warning, "warning");
      }
    },
  });

  pi.on("agent_end", async (_event, ctx) => {
    const pending = pendingToolHandoffState.pending;
    if (!pending) {
      return;
    }

    pendingToolHandoffState.pending = undefined;
    pendingToolHandoffState.contextCutoffTimestamp = Date.now();
    startNewSessionInPlace(ctx, pending.parentSession);

    await applyPendingSelection(pi, ctx, pending.overrides);

    setTimeout(() => {
      void pi.sendUserMessage(pending.prompt);
    }, 0);
  });

  pi.on("context", (event) => {
    const cutoff = pendingToolHandoffState.contextCutoffTimestamp;
    if (cutoff === undefined) {
      return undefined;
    }

    const messages = event.messages.filter((message) => message.timestamp >= cutoff);
    if (messages.length === 0) {
      return undefined;
    }

    return { messages };
  });

  pi.on("session_start", async (event, ctx) => {
    state.ctx = ctx;
    state.pendingNewSessionCtx?.resolve(ctx);
    pendingToolHandoffState.contextCutoffTimestamp = undefined;
    pendingToolHandoffState.pending = undefined;

    if (event.reason !== "new") {
      return;
    }

    const pendingCommandHandoff = getPendingCommandHandoff();
    if (!pendingCommandHandoff) {
      return;
    }

    if (pendingCommandHandoff.deferSessionStartApply) {
      return;
    }

    await applyPendingSelection(pi, ctx, pendingCommandHandoff.overrides);
    setPendingCommandHandoff(undefined);

    if (pendingCommandHandoff.autoSend) {
      setTimeout(() => {
        void pi.sendUserMessage(pendingCommandHandoff.prompt);
      }, 0);
      return;
    }

    if (!ctx.hasUI) {
      return;
    }

    ctx.ui.setEditorText(pendingCommandHandoff.prompt);
    ctx.ui.notify("Handoff ready. Submit when ready.", "info");
  });

  pi.on("model_select", async (_event, ctx) => {
    state.ctx = ctx;
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    state.ctx = ctx;
  });
}
