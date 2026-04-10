import { complete, type Message } from "@mariozechner/pi-ai";
import {
  BorderedLoader,
  convertToLlm,
  defineTool,
  serializeConversation,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { Text, fuzzyFilter, type AutocompleteItem } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { loadModesFile, resolveModeSpec, type ModeSpec, type ThinkingLevel } from "../mode-utils.js";
import { MODE_SELECTION_APPLY_EVENT } from "./modes.js";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

const HANDOFF_PROVIDER = "gemini" as const;
const HANDOFF_MODEL = "gemini-3.1-flash-lite-preview" as const;
const EXPLICIT_HANDOFF_REQUEST = /\b(handoff|hand\s+off|new\s+(session|thread)|another\s+(session|thread)|start\s+a\s+new\s+(session|thread)|continue\s+in\s+(a\s+)?new\s+(session|thread)|switch\s+to\s+(a\s+)?new\s+(session|thread)|transfer\s+(the\s+)?context)\b/i;

type SessionModel = NonNullable<ExtensionContext["model"]>;

type HandoffOptions = {
  mode?: string;
  model?: string;
};

type ResolvedHandoffOptions = {
  mode?: string;
  model?: string;
  targetModel?: SessionModel;
  thinkingLevel?: ThinkingLevel;
};

type PendingToolHandoff = {
  prompt: string;
  parentSession?: string;
  overrides?: ResolvedHandoffOptions;
};

type HandoffGenerationConfig = {
  model: SessionModel;
  apiKey: string;
  headers?: Record<string, string>;
  warning?: string;
};

type PendingSessionHandoff = {
  prompt: string;
  autoSend: boolean;
  overrides?: ResolvedHandoffOptions;
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

type HandoffRuntimeState = {
  ctx?: ExtensionContext;
  toolPromptSignature?: string;
  pendingNewSessionCtx?: {
    promise: Promise<ExtensionContext>;
    resolve: (ctx: ExtensionContext) => void;
  };
};

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

function getPendingCommandHandoff(): PendingSessionHandoff | undefined {
  return globalThis.__shekohexPendingSessionHandoff;
}

function setPendingCommandHandoff(pending: PendingSessionHandoff | undefined): void {
  globalThis.__shekohexPendingSessionHandoff = pending;
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
      }, 0);
    }),
  ]);
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
      targetModel: overrides.targetModel,
      thinkingLevel: overrides.thinkingLevel,
      reason: "restore",
      source: "session_start",
      done: { resolve, reject },
    });
  });
}

function getConversationMessages(ctx: ExtensionContext) {
  return ctx.sessionManager
    .getBranch()
    .filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
    .map((entry) => entry.message);
}

function getLatestUserText(ctx: ExtensionContext): string {
  const latestUserMessage = getConversationMessages(ctx)
    .filter((message) => message.role === "user")
    .at(-1);

  if (!latestUserMessage) {
    return "";
  }

  return extractMessageText(latestUserMessage.content);
}

function didUserExplicitlyRequestHandoff(ctx: ExtensionContext): boolean {
  return EXPLICIT_HANDOFF_REQUEST.test(getLatestUserText(ctx));
}

function extractMessageText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") {
    return content.trim();
  }

  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
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

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&apos;");
}

async function loadAvailableModes(cwd: string): Promise<Array<{ name: string; spec: ModeSpec }>> {
  const loaded = await loadModesFile(cwd);
  return Object.entries(loaded.data.modes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, spec]) => ({ name, spec }));
}

function formatAvailableModesXml(modes: Array<{ name: string; spec: ModeSpec }>): string {
  if (modes.length === 0) {
    return "<available_modes>\n</available_modes>";
  }

  return [
    "<available_modes>",
    ...modes.map(({ name, spec }) => {
      const attrs = [`name=\"${escapeXmlAttribute(name)}\"`];
      if (spec.provider && spec.modelId) {
        const model = `${spec.provider}/${spec.modelId}`;
        attrs.push(`model=\"${escapeXmlAttribute(model)}\"`);
      }
      if (spec.thinkingLevel) {
        attrs.push(`thinkingLevel=\"${escapeXmlAttribute(spec.thinkingLevel)}\"`);
      }
      return `  <mode ${attrs.join(" ")} />`;
    }),
    "</available_modes>",
  ].join("\n");
}

async function buildHandoffPromptGuidelines(ctx: ExtensionContext): Promise<string[]> {
  const modesXml = formatAvailableModesXml(await loadAvailableModes(ctx.cwd));
  return [
    "Only use this tool when the user explicitly asks to hand off the current work into a new session or thread.",
    "Provide a concrete goal for the new session. Use mode/model overrides only when the user asks for them.",
    `Available handoff modes. When the user asks for a mode, use one of these exact names:\n${modesXml}`,
  ];
}

async function syncHandoffToolRegistration(
  pi: ExtensionAPI,
  handoffTool: ReturnType<typeof createHandoffTool>,
  state: HandoffRuntimeState,
  ctx: ExtensionContext,
): Promise<void> {
  state.ctx = ctx;
  const promptGuidelines = await buildHandoffPromptGuidelines(ctx);
  const signature = promptGuidelines.join("\n\n");
  if (state.toolPromptSignature === signature) {
    return;
  }

  handoffTool.promptGuidelines = promptGuidelines;
  state.toolPromptSignature = signature;
  pi.registerTool(handoffTool);
}

function getAvailableModelsForAutocomplete(ctx: ExtensionContext | undefined): SessionModel[] {
  return (ctx?.modelRegistry.getAvailable() ?? []) as SessionModel[];
}

function filterAutocompleteItems(items: AutocompleteItem[], query: string): AutocompleteItem[] | null {
  if (items.length === 0) {
    return null;
  }

  if (!query) {
    return items;
  }

  const filtered = fuzzyFilter(items, query, (item) => `${item.label} ${item.value} ${item.description ?? ""}`);
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
        return { kind: "flag", prefixBase: argumentPrefix.slice(0, flagStart), query: flagToken, usedFlags };
      }
      return { kind: "none", prefixBase: argumentPrefix.slice(0, flagStart), query: flagToken, usedFlags };
    }

    if (index >= argumentPrefix.length) {
      return { kind: "flag", prefixBase: argumentPrefix.slice(0, flagStart), query: flagToken, usedFlags };
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

function getHandoffFlagCompletions(prefixBase: string, query: string, usedFlags: Set<HandoffFlagName>): AutocompleteItem[] | null {
  const items = HANDOFF_FLAG_OPTIONS
    .filter((flag) => !usedFlags.has(flag.name))
    .map((flag) => ({
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

function createHandoffTool(pi: ExtensionAPI) {
  return defineTool({
    name: "handoff",
    label: "handoff",
    description:
      "Transfer context into a new focused session. Only use this when the user explicitly asks for a handoff, new session, or new thread.",
    promptSnippet:
      "use `handoff` to transfer context into a new focused session, but only when the user explicitly asks for a handoff/new session",
    promptGuidelines: [
      "Only use this tool when the user explicitly asks to hand off the current work into a new session or thread.",
      "Provide a concrete goal for the new session. Use mode/model overrides only when the user asks for them.",
    ],
    parameters: Type.Object({
      goal: Type.String({ description: "Goal or task for the new session" }),
      mode: Type.Optional(Type.String({ description: "Optional mode name to apply to the new session" })),
      model: Type.Optional(Type.String({ description: "Optional model override in provider/modelId form" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const goal = params.goal.trim();
      if (!goal) {
        return { content: [{ type: "text", text: "Error: handoff goal cannot be empty." }], details: {} };
      }

      if (!didUserExplicitlyRequestHandoff(ctx)) {
        return {
          content: [
            {
              type: "text",
              text: "Error: the handoff tool may only be used when the user explicitly asks for a handoff or new session.",
            },
          ],
          details: {},
        };
      }

      const result = await prepareHandoff(pi, ctx, goal, { mode: params.mode, model: params.model }, false, undefined, onUpdate);
      if (result.error) {
        return { content: [{ type: "text", text: `Error: ${result.error}` }], details: {} };
      }

      pendingToolHandoffState.pending = {
        prompt: result.prompt,
        parentSession: result.parentSession,
        overrides: result.overrides,
      };

      const content = result.warning
        ? `Handoff prepared. ${result.warning} A new session will be created after this turn, and the generated prompt will be sent automatically.`
        : "Handoff prepared. A new session will be created after this turn, and the generated prompt will be sent automatically.";

      return {
        content: [{ type: "text", text: content }],
        details: {
          parentSession: result.parentSession,
          mode: params.mode,
          model: params.model,
        },
      };
    },
    renderCall(args, theme) {
      const segments = [theme.fg("toolTitle", theme.bold("handoff "))];

      if (args.mode) {
        segments.push(theme.fg("accent", `-mode ${args.mode} `));
      }

      if (args.model) {
        segments.push(theme.fg("accent", `-model ${args.model} `));
      }

      segments.push(theme.fg("muted", args.goal));
      return new Text(segments.join(""), 0, 0);
    },
  });
}

function parseModelOverride(value: string): { provider: string; modelId: string } | undefined {
  const separatorIndex = value.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return undefined;
  }

  return {
    provider: value.slice(0, separatorIndex),
    modelId: value.slice(separatorIndex + 1),
  };
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
  let targetModel: SessionModel | undefined;
  let thinkingLevel: ThinkingLevel | undefined;

  if (options.mode) {
    const modeSpec = await resolveModeSpec(ctx.cwd, options.mode);
    if (!modeSpec) {
      return { error: `Unknown mode \"${options.mode}\"` };
    }

    if (modeSpec.provider && modeSpec.modelId) {
      const modeModel = ctx.modelRegistry.find(modeSpec.provider, modeSpec.modelId);
      if (!modeModel) {
        return { error: `Mode \"${options.mode}\" references unknown model ${modeSpec.provider}/${modeSpec.modelId}` };
      }
      targetModel = modeModel;
    }

    thinkingLevel = modeSpec.thinkingLevel;
  }

  if (options.model) {
    const parsedModel = parseModelOverride(options.model);
    if (!parsedModel) {
      return { error: `Invalid model override \"${options.model}\". Expected provider/modelId.` };
    }

    const model = ctx.modelRegistry.find(parsedModel.provider, parsedModel.modelId);
    if (!model) {
      return { error: `Unknown model ${options.model}` };
    }

    targetModel = model;
  }

  if (!targetModel && !thinkingLevel) {
    return {};
  }

  return {
    overrides: {
      mode: options.mode,
      model: options.model,
      targetModel,
      thinkingLevel,
    },
  };
}

async function getGenerationConfig(ctx: ExtensionContext): Promise<{ config?: HandoffGenerationConfig; error?: string }> {
  if (!ctx.model) {
    return { error: "No model selected" };
  }

  const preferredModel = ctx.modelRegistry.find(HANDOFF_PROVIDER, HANDOFF_MODEL);
  const generationModel = preferredModel ?? ctx.model;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(generationModel);
  if (!auth.ok) {
    return { error: `Handoff auth failed: ${auth.error}` };
  }

  if (!auth.apiKey) {
    return { error: `No API key for ${generationModel.provider}/${generationModel.id}` };
  }

  return {
    config: {
      model: generationModel,
      apiKey: auth.apiKey,
      headers: auth.headers,
      warning: preferredModel ? undefined : `Could not find ${HANDOFF_PROVIDER}/${HANDOFF_MODEL}; using current session model.`,
    },
  };
}

async function generateSummary(
  ctx: ExtensionContext,
  goal: string,
  messages: ReturnType<typeof getConversationMessages>,
  signal?: AbortSignal,
): Promise<{ summary?: string; warning?: string; error?: string; aborted?: boolean }> {
  const generation = await getGenerationConfig(ctx);
  if (!generation.config) {
    return { error: generation.error };
  }

  const conversationText = serializeConversation(convertToLlm(messages));
  const userMessage: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
      },
    ],
    timestamp: Date.now(),
  };

  try {
    const response = await complete(
      generation.config.model,
      { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
      { apiKey: generation.config.apiKey, headers: generation.config.headers, signal },
    );

    if (response.stopReason === "aborted") {
      return { aborted: true };
    }

    return {
      summary: response.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim(),
      warning: generation.config.warning,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function generateSummaryWithLoader(
  ctx: ExtensionContext,
  goal: string,
  messages: ReturnType<typeof getConversationMessages>,
): Promise<{ summary?: string; warning?: string; error?: string; aborted?: boolean }> {
  if (!ctx.hasUI) {
    return generateSummary(ctx, goal, messages);
  }

  return ctx.ui.custom<{ summary?: string; warning?: string; error?: string; aborted?: boolean }>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, "Generating handoff prompt...");
    loader.onAbort = () => done({ aborted: true });

    generateSummary(ctx, goal, messages, loader.signal)
      .then(done)
      .catch((error) => {
        done({ error: error instanceof Error ? error.message : String(error) });
      });

    return loader;
  });
}

function buildHandoffPrompt(summary: string, parentSession?: string): string {
  if (!parentSession) {
    return summary.trim();
  }

  return `${summary.trim()}\n\n## Parent Session\nParent session: ${parentSession}\nIf you need additional detail from the parent session, use \`session_query\` with \`sessionPath\` set to the path above and a focused \`question\`.`;
}

async function prepareHandoff(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  goal: string,
  options: HandoffOptions,
  reviewPrompt: boolean,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<unknown>,
): Promise<{ prompt: string; parentSession?: string; overrides?: ResolvedHandoffOptions; warning?: string; error?: string }> {
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
    ? await generateSummaryWithLoader(ctx, goal, messages)
    : await generateSummary(ctx, goal, messages, signal);
  if (generation.error) {
    return { prompt: "", error: generation.error };
  }

  if (generation.aborted || !generation.summary) {
    return { prompt: "", error: "Cancelled" };
  }

  const parentSession = ctx.sessionManager.getSessionFile();
  let prompt = buildHandoffPrompt(generation.summary, parentSession);

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

export default function handoffExtension(pi: ExtensionAPI) {
  const handoffTool = createHandoffTool(pi);
  const state: HandoffRuntimeState = {};

  pi.registerCommand("handoff", {
    description: "Transfer context to a new focused session (-mode <name>, -model <provider/modelId>)",
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

      const result = await prepareHandoff(pi, ctx, parsed.goal, parsed.options, false);
      if (result.error) {
        ctx.ui.notify(result.error, result.error === "Cancelled" ? "info" : "error");
        return;
      }

      if (result.warning) {
        ctx.ui.notify(result.warning, "warning");
      }

      setPendingCommandHandoff({
        prompt: result.prompt,
        autoSend: true,
        overrides: result.overrides,
      });
      createPendingNewSessionContext(state);

      const newSessionResult = await (ctx as ExtensionCommandContext).newSession({
        parentSession: result.parentSession,
      });

      if (newSessionResult.cancelled) {
        state.pendingNewSessionCtx = undefined;
        setPendingCommandHandoff(undefined);
        ctx.ui.notify("New session cancelled", "info");
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 0));

      const pendingCommandHandoff = getPendingCommandHandoff();
      if (!pendingCommandHandoff) {
        return;
      }

      const targetCtx = await waitForPendingNewSessionContext(state, ctx);
      await applyPendingSelection(pi, targetCtx, pendingCommandHandoff.overrides);
      setPendingCommandHandoff(undefined);

      if (pendingCommandHandoff.autoSend) {
        setTimeout(() => {
          void pi.sendUserMessage(pendingCommandHandoff.prompt);
        }, 0);
      }
    },
  });

  pi.registerTool(handoffTool);

  pi.events.on("modes:changed", async () => {
    if (!state.ctx) {
      return;
    }

    await syncHandoffToolRegistration(pi, handoffTool, state, state.ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const pending = pendingToolHandoffState.pending;
    if (!pending) {
      return;
    }

    pendingToolHandoffState.pending = undefined;
    pendingToolHandoffState.contextCutoffTimestamp = Date.now();
    (ctx.sessionManager as unknown as { newSession: (options?: { parentSession?: string }) => string | undefined }).newSession({
      parentSession: pending.parentSession,
    });

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
    await syncHandoffToolRegistration(pi, handoffTool, state, ctx);

    if (event.reason !== "new") {
      return;
    }

    const pendingCommandHandoff = getPendingCommandHandoff();
    if (!pendingCommandHandoff) {
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
    await syncHandoffToolRegistration(pi, handoffTool, state, ctx);
  });
}
