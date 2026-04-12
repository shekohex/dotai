import { defineTool, type ExtensionAPI, type ExtensionContext, type Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { buildAvailableModesPromptGuideline } from "./available-modes.js";

import {
  countTextLines,
  createTextComponent,
  formatDurationHuman,
  getTextContent,
  renderStreamingPreview,
  renderToolError,
  styleToolOutput,
  summarizeLineCount,
} from "./coreui/tools.js";
import { toModeFlagName } from "./modes.js";
import type { TmuxTarget } from "../mode-utils.js";
import type { MuxAdapter } from "./subagent/mux.js";
import {
  activateAutoExitTimeoutMode,
  consumeParentInjectedInputMarker,
  isAutoExitTimeoutModeActive,
} from "./subagent/session.js";
import { SubagentManager } from "./subagent/state.js";
import { TmuxAdapter } from "./subagent/tmux.js";
import {
  SubagentToolParamsSchema,
  type ChildBootstrapState,
  type RuntimeSubagent,
  type SubagentToolProgressDetails,
  type SubagentToolParams,
  type SubagentToolRenderDetails,
  type SubagentToolResultDetails,
} from "./subagent/types.js";

type CreateSubagentExtensionOptions = {
  adapterFactory?: (pi: ExtensionAPI) => MuxAdapter;
};

type SubagentRuntimeState = {
  ctx?: ExtensionContext;
  toolPromptSignature?: string;
};

type LaunchTarget =
  | { kind: "session"; sessionPath: string }
  | { kind: "continue" };

type SubagentRenderState = {
  startedAt?: number;
  endedAt?: number;
  interval?: ReturnType<typeof setInterval>;
  callComponent?: Text;
  callText?: string;
};

const CHILD_STATE_ENV = "PI_SUBAGENT_CHILD_STATE";
const PI_COMMAND_ENV = "PI_SUBAGENT_PI_COMMAND";
const SUBAGENT_STREAM_PREVIEW_LINE_LIMIT = 5;
const SUBAGENT_STREAM_PREVIEW_WIDTH = 96;

function normalizeSingleLine(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
}

function formatChildSessionDisplayName(name: string, prompt: string): string {
  const normalizedPrompt = normalizeSingleLine(prompt);
  return normalizedPrompt ? `[${name}] ${normalizedPrompt}` : `[${name}]`;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getPiCommandPrefix(): string[] {
  const override = process.env[PI_COMMAND_ENV]?.trim();
  if (override) {
    return [override];
  }

  const script = process.argv[1];
  if (!script) {
    return ["pi"];
  }

  const parts = [process.execPath, ...process.execArgv, script];
  return [parts.map((part) => shellEscape(part)).join(" ")];
}

function buildLaunchCommand(
  state: RuntimeSubagent,
  childState: ChildBootstrapState,
  prompt: string,
  options: {
    launchTarget?: LaunchTarget;
    tmuxTarget: TmuxTarget;
    mode?: string;
    model?: string;
    thinkingLevel?: string;
    systemPrompt?: string;
    systemPromptMode: "append" | "replace";
  },
): string {
  const commandParts = [...getPiCommandPrefix()];
  const launchTarget: LaunchTarget = options.launchTarget ?? { kind: "session", sessionPath: state.sessionPath };

  if (launchTarget.kind === "continue") {
    commandParts.push("--continue");
  } else {
    commandParts.push("--session", shellEscape(launchTarget.sessionPath));
  }

  if (options.model) {
    commandParts.push("--model", shellEscape(options.model));
  }
  if (options.thinkingLevel) {
    commandParts.push("--thinking", shellEscape(options.thinkingLevel));
  }
  if (options.systemPrompt) {
    commandParts.push(
      options.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
      shellEscape(options.systemPrompt),
    );
  }
  if (prompt.trim()) {
    commandParts.push(shellEscape(prompt));
  }
  if (options.mode) {
    const modeFlag = toModeFlagName(options.mode);
    if (modeFlag) {
      commandParts.push(`--${modeFlag}`);
    }
  }

  const envPayload = shellEscape(JSON.stringify(childState));
  return `env ${CHILD_STATE_ENV}=${envPayload} ${commandParts.join(" ")}`;
}

function readChildState(): ChildBootstrapState | undefined {
  const raw = process.env[CHILD_STATE_ENV];
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as ChildBootstrapState;
  } catch {
    return undefined;
  }
}

function applyChildToolState(pi: ExtensionAPI, childState: ChildBootstrapState | undefined): void {
  if (!childState) {
    return;
  }

  const activeTools = new Set(childState.tools);
  activeTools.delete("subagent");
  pi.setActiveTools(Array.from(activeTools).sort((left, right) => left.localeCompare(right)));
}

function isChildSession(childState: ChildBootstrapState | undefined, ctx: ExtensionContext): childState is ChildBootstrapState {
  if (!childState) {
    return false;
  }

  return ctx.sessionManager.getSessionId() === childState.sessionId
    || ctx.sessionManager.getSessionFile() === childState.sessionPath;
}

function installChildBootstrap(pi: ExtensionAPI): void {
  const childState = readChildState();
  const autoExitEnabled = Boolean(childState?.autoExit);
  let pendingIdleShutdown: ReturnType<typeof setTimeout> | undefined;
  let timeoutModeActive = childState ? isAutoExitTimeoutModeActive(childState.sessionId) : false;

  const cancelIdleShutdown = () => {
    if (!pendingIdleShutdown) {
      return;
    }

    clearTimeout(pendingIdleShutdown);
    pendingIdleShutdown = undefined;
  };

  const scheduleIdleShutdown = (ctx: ExtensionContext, currentChildState: ChildBootstrapState) => {
    cancelIdleShutdown();

    if (!timeoutModeActive) {
      ctx.shutdown();
      return;
    }

    pendingIdleShutdown = setTimeout(() => {
      pendingIdleShutdown = undefined;
      if (!autoExitEnabled || !isChildSession(currentChildState, ctx)) {
        return;
      }

      ctx.shutdown();
    }, currentChildState.autoExitTimeoutMs ?? 30_000);
    pendingIdleShutdown.unref?.();
  };

  pi.on("session_start", async (_event, ctx) => {
    const currentChildState = childState;
    if (!isChildSession(currentChildState, ctx)) {
      return;
    }

    timeoutModeActive = isAutoExitTimeoutModeActive(currentChildState.sessionId);

    applyChildToolState(pi, currentChildState);
    pi.setSessionName(formatChildSessionDisplayName(currentChildState.name, currentChildState.prompt));

    if (!ctx.hasUI) {
      return;
    }

    ctx.ui.onTerminalInput((data) => {
      if (!autoExitEnabled || !data.trim()) {
        return undefined;
      }

      if (consumeParentInjectedInputMarker(currentChildState.sessionId)) {
        return undefined;
      }

      timeoutModeActive = true;
      activateAutoExitTimeoutMode(currentChildState.sessionId);
      cancelIdleShutdown();
      return undefined;
    });
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const currentChildState = childState;
    if (!isChildSession(currentChildState, ctx)) {
      return undefined;
    }

    cancelIdleShutdown();
    applyChildToolState(pi, currentChildState);
    return undefined;
  });

  pi.on("agent_end", async (_event, ctx) => {
    const currentChildState = childState;
    if (!isChildSession(currentChildState, ctx) || !autoExitEnabled) {
      return;
    }

    scheduleIdleShutdown(ctx, currentChildState);
  });

  pi.on("session_shutdown", async () => {
    cancelIdleShutdown();
  });
}

function ensureParentSubagentToolActive(pi: ExtensionAPI): void {
  const activeTools = new Set(pi.getActiveTools());
  activeTools.add("subagent");
  pi.setActiveTools(Array.from(activeTools).sort((left, right) => left.localeCompare(right)));
}

function scheduleParentSubagentToolActivation(pi: ExtensionAPI): void {
  const activate = () => {
    try {
      ensureParentSubagentToolActive(pi);
    } catch {
      return;
    }
  };

  queueMicrotask(activate);
  const timer = setTimeout(activate, 0);
  timer.unref?.();
}

function validateToolParams(params: SubagentToolParams): void {
  if (params.action === "start") {
    if (!params.name?.trim()) {
      throw new Error("Invalid subagent start params: `name` is required. It becomes the tmux pane/window title shown when the child launches.");
    }
    if (!params.task?.trim()) {
      throw new Error("Invalid subagent start params: `task` is required. There is no subagent read action later, so provide the delegated work up front and inspect tmux output from the parent session only when needed.");
    }
  }

  if (params.action === "message") {
    if (!params.sessionId?.trim()) {
      throw new Error("Invalid subagent message params: `sessionId` is required. Use `subagent` `list` or a prior subagent result to choose the child session.");
    }
    if (!params.message?.trim()) {
      throw new Error("Invalid subagent message params: `message` is required. This text is sent into the child tmux pane/window.");
    }
  }

  if (params.action === "cancel" && !params.sessionId?.trim()) {
    throw new Error("Invalid subagent cancel params: `sessionId` is required. Use `subagent` `list` or a prior subagent result to choose the child session.");
  }
}

function normalizeSubagentExecutionError(action: SubagentToolParams["action"], error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);

  if (message.startsWith("Invalid subagent ") || message.startsWith(`subagent ${action} failed:`)) {
    return error instanceof Error ? error : new Error(message);
  }

  return new Error(`subagent ${action} failed: ${message}`);
}

function getStartGuidanceText(): string {
  return "This is the prompt sent to the child session. The subagent will return with a summary automatically when it finishes, so usually continue doing your work that needs to be done or wait for completion instead of polling with list or checking repeatedly for the final result. Use message only to steer the work, cancel to stop it, and inspect the tmux pane/window directly from the parent session only when you need live output.";
}

function formatStartResultText(state: RuntimeSubagent): string {
  return `Subagent ${state.name} (${shortSessionId(state.sessionId)}) started. The subagent will return with a summary automatically when it finishes, so usually wait for completion instead of polling with list or checking for the final result. Use subagent message only to steer the work, subagent cancel to stop it, and inspect the tmux pane/window directly only when you need live output.`;
}

function formatAutoResumedMessageResultText(state: RuntimeSubagent, delivery: string): string {
  return `Subagent ${state.name} (${shortSessionId(state.sessionId)}) resumed using its previous task and ${delivery} message delivered.`;
}

function summarizeTask(task?: string, maxLength = 56): string {
  const normalized = (task ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "...";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function shortSessionId(sessionId?: string): string {
  const value = sessionId?.trim();
  if (!value) {
    return "...";
  }
  return value.slice(0, 8);
}

function summarizeWhitespace(value?: string, maxLength = 56): string {
  return summarizeTask(value, maxLength);
}

function syncRenderState(context: { state: unknown }): SubagentRenderState {
  return context.state as SubagentRenderState;
}

function syncStreamingRenderState(
  context: { state: unknown; executionStarted: boolean; invalidate: () => void },
  isPartial: boolean,
): SubagentRenderState {
  const state = context.state as SubagentRenderState;

  if (context.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }

  if (isPartial && state.startedAt !== undefined && !state.interval) {
    state.interval = setInterval(() => context.invalidate(), 1000);
    state.interval.unref?.();
  }

  if (!isPartial && state.startedAt !== undefined) {
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }

  return state;
}

function getElapsedMs(state: SubagentRenderState): number | undefined {
  return state.startedAt === undefined ? undefined : (state.endedAt ?? Date.now()) - state.startedAt;
}

function setCallComponent(state: SubagentRenderState, lastComponent: unknown, text: string): Text {
  const component = createTextComponent(state.callComponent ?? lastComponent, text);
  state.callComponent = component;
  state.callText = text;
  return component;
}

function applyCollapsedSummaryToCall(state: SubagentRenderState, summary: string): void {
  if (!(state.callComponent instanceof Text) || !state.callText || !summary) {
    return;
  }

  const lines = state.callText.split("\n");
  lines[0] = `${lines[0] ?? ""}${summary}`;
  state.callComponent.setText(lines.join("\n"));
}

function isProgressDetails(details: SubagentToolRenderDetails | undefined): details is SubagentToolProgressDetails {
  if (!details || typeof details !== "object") {
    return false;
  }

  return "phase" in details && "statusText" in details;
}

function formatProgressPhase(details: SubagentToolProgressDetails): string {
  if (details.phase === "handoff") {
    return "handoff";
  }
  if (details.phase === "launch") {
    return "launching";
  }
  if (details.delivery) {
    return `${details.phase} ${details.delivery}`;
  }
  return details.phase;
}

function formatProgressInlineSummary(details: SubagentToolProgressDetails, theme: Theme): string {
  return theme.fg("muted", formatProgressPhase(details));
}

function formatProgressFooter(
  details: SubagentToolProgressDetails | undefined,
  previewText: string,
  expanded: boolean,
  elapsedMs?: number,
): string {
  const phase = details ? formatProgressPhase(details) : "working";
  const duration = formatDurationHuman(elapsedMs ?? 0);

  if (expanded) {
    return `${phase} · ${duration}`;
  }

  return `${summarizeLineCount(countTextLines(previewText))} so far (${duration}) · ${phase}`;
}

function renderPartialSubagentResult(
  args: SubagentToolParams,
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  expanded: boolean,
  theme: Theme,
  context: { lastComponent: unknown },
  state: SubagentRenderState,
): Text {
  const details = result.details as SubagentToolRenderDetails | undefined;
  const progress = isProgressDetails(details) ? details : undefined;
  const previewText = (progress?.preview ?? getTextContent(result) ?? "").trim();
  const elapsedMs = progress?.durationMs ?? getElapsedMs(state);

  applyCollapsedSummaryToCall(
    state,
    `${theme.fg("dim", " · ")}${progress ? formatProgressInlineSummary(progress, theme) : theme.fg("muted", "...")}`,
  );

  if (!previewText) {
    const label = progress?.statusText ?? `${args.action} in progress`;
    const duration = formatDurationHuman(elapsedMs ?? 0);
    return createTextComponent(context.lastComponent, `${theme.fg("dim", "↳ ")}${theme.fg("muted", `${label} (${duration})`)}`);
  }

  return renderStreamingPreview(
    styleToolOutput(previewText, theme, SUBAGENT_STREAM_PREVIEW_WIDTH, { truncateFrom: "tail" }),
    theme,
    context.lastComponent,
    {
      expanded,
      footer: formatProgressFooter(progress, previewText, expanded, elapsedMs),
      tailLines: SUBAGENT_STREAM_PREVIEW_LINE_LIMIT,
    },
  );
}

function formatCollapsedCallText(args: SubagentToolParams, theme: Theme): string {
  const prefix = theme.fg("toolTitle", theme.bold("π"));
  const separator = theme.fg("dim", " · ");
  const action = theme.fg("accent", args.action);

  if (args.action === "start") {
    return `${prefix} ${action}${separator}${theme.fg("muted", `${args.name ?? "..."} · ${args.mode ?? "worker"} · ${summarizeTask(args.task)}`)}`;
  }
  if (args.action === "message") {
    return `${prefix} ${action}${separator}${theme.fg("muted", `${shortSessionId(args.sessionId)} · ${args.delivery ?? "steer"} · ${summarizeTask(args.message, 40)}`)}`;
  }
  if (args.action === "cancel") {
    return `${prefix} ${action}${separator}${theme.fg("muted", shortSessionId(args.sessionId))}`;
  }

  return `${prefix} ${action}`;
}

function formatScalarValue(value: string | number | boolean | undefined): string {
  if (value === undefined) {
    return "-";
  }

  const text = String(value).trim();
  return text.length > 0 ? text : "-";
}

function formatTimestamp(value: number | undefined): string {
  return typeof value === "number" ? new Date(value).toISOString() : "-";
}

function formatField(label: string, value: string | number | boolean | undefined, multiline = false): string[] {
  const text = formatScalarValue(value);
  if (!multiline && !text.includes("\n")) {
    return [`${label}: ${text}`];
  }

  return [
    `${label}:`,
    ...text.split("\n").map((line) => `  ${line}`),
  ];
}

function formatExpandedCallText(args: SubagentToolParams, theme: Theme): string {
  const lines = [`${theme.fg("toolTitle", theme.bold("π"))} ${theme.fg("accent", args.action)}`];

  if (args.action === "start") {
    lines.push(...formatField("name", args.name));
    lines.push(...formatField("mode", args.mode ?? "worker"));
    lines.push(...formatField("cwd", args.cwd));
    lines.push(...formatField("handoff", Boolean(args.handoff)));
    lines.push(...formatField("autoExit", args.autoExit));
    lines.push(...formatField("task", args.task, true));
    return lines.join("\n");
  }

  if (args.action === "message") {
    lines.push(...formatField("sessionId", args.sessionId));
    lines.push(...formatField("delivery", args.delivery ?? "steer"));
    lines.push(...formatField("message", args.message, true));
    return lines.join("\n");
  }

  if (args.action === "cancel") {
    lines.push(...formatField("sessionId", args.sessionId));
    return lines.join("\n");
  }

  return lines.join("\n");
}

function formatSubagentStateDetails(state: RuntimeSubagent): string {
  return [
    ...formatField("event", state.event),
    ...formatField("name", state.name),
    ...formatField("status", state.status),
    ...formatField("sessionId", state.sessionId),
    ...formatField("paneId", state.paneId || "-"),
    ...formatField("parentSessionId", state.parentSessionId),
    ...formatField("parentSessionPath", state.parentSessionPath),
    ...formatField("mode", state.modeLabel),
    ...formatField("cwd", state.cwd),
    ...formatField("sessionPath", state.sessionPath),
    ...formatField("handoff", state.handoff),
    ...formatField("autoExit", state.autoExit),
    ...formatField("autoExitTimeoutMs", state.autoExitTimeoutMs),
    ...formatField("autoExitTimeoutActive", state.autoExitTimeoutActive),
    ...formatField("autoExitDeadlineAt", formatTimestamp(state.autoExitDeadlineAt)),
    ...formatField("task", state.task, true),
    ...formatField("summary", state.summary, true),
    ...formatField("exitCode", state.exitCode),
    ...formatField("startedAt", formatTimestamp(state.startedAt)),
    ...formatField("updatedAt", formatTimestamp(state.updatedAt)),
    ...formatField("completedAt", formatTimestamp(state.completedAt)),
  ].join("\n");
}

function formatListDetails(subagents: RuntimeSubagent[]): string {
  if (subagents.length === 0) {
    return "count: 0\nsubagents: -";
  }

  return [
    `count: ${subagents.length}`,
    ...subagents.flatMap((subagent, index) => [
      "",
      `subagent ${index + 1}:`,
      ...formatSubagentStateDetails(subagent).split("\n").map((line) => `  ${line}`),
    ]),
  ].join("\n");
}

function formatExpandedResult(details: SubagentToolResultDetails | undefined): string {
  if (!details) {
    return "status: ok";
  }

  if (details.action === "list") {
    return formatListDetails(details.subagents);
  }

  const resultLines = [formatSubagentStateDetails(details.state)];

  if (details.action === "start") {
    resultLines.push(...formatField("prompt", details.prompt, true));
    resultLines.push(...formatField("promptGuidance", getStartGuidanceText(), true));
    return resultLines.join("\n");
  }

  if (details.action === "message") {
    if (details.autoResumed) {
      resultLines.push(...formatField("autoResumed", details.autoResumed));
      resultLines.push(...formatField("resumePrompt", details.resumePrompt, true));
    }
    resultLines.push(...formatField("delivery", details.delivery));
    resultLines.push(...formatField("message", details.message, true));
  }

  return resultLines.join("\n");
}

function countSubagentsByStatus(subagents: RuntimeSubagent[]): Map<RuntimeSubagent["status"], number> {
  const counts = new Map<RuntimeSubagent["status"], number>();

  for (const subagent of subagents) {
    counts.set(subagent.status, (counts.get(subagent.status) ?? 0) + 1);
  }

  return counts;
}

function formatListCollapsedSummary(subagents: RuntimeSubagent[], theme: Theme): string {
  const counts = countSubagentsByStatus(subagents);
  const segments = [theme.fg("success", `${subagents.length} agent${subagents.length === 1 ? "" : "s"}`)];
  const orderedStatuses: Array<RuntimeSubagent["status"]> = ["running", "idle", "completed", "cancelled", "failed"];

  for (const status of orderedStatuses) {
    const count = counts.get(status) ?? 0;
    if (count === 0) {
      continue;
    }

    segments.push(theme.fg("muted", `${count} ${status}`));
  }

  return segments.join(theme.fg("dim", " · "));
}

function formatStateCollapsedSummary(state: RuntimeSubagent, theme: Theme): string {
  return [
    theme.fg("success", state.name),
    theme.fg("muted", state.status),
  ].join(theme.fg("dim", " · "));
}

function formatMessageCollapsedSummary(details: Extract<SubagentToolResultDetails, { action: "message" }>, theme: Theme): string {
  return [
    theme.fg("success", details.state.name),
    theme.fg("muted", details.state.status),
    ...(details.autoResumed ? [theme.fg("muted", "resumed")] : []),
    theme.fg("muted", details.delivery),
    theme.fg("muted", summarizeWhitespace(details.message, 36)),
  ].join(theme.fg("dim", " · "));
}

function formatCollapsedResultSummary(details: SubagentToolResultDetails | undefined, theme: Theme): string {
  if (!details) {
    return theme.fg("success", "ok");
  }

  if (details.action === "list") {
    return formatListCollapsedSummary(details.subagents, theme);
  }

  if (details.action === "message") {
    return formatMessageCollapsedSummary(details, theme);
  }

  return formatStateCollapsedSummary(details.state, theme);
}

const SUBAGENT_BASE_PROMPT_GUIDELINES = [
  "Use `subagent` when the user wants parallel or delegated work in another tmux-backed pi session.",
  "Use `start` to launch a child session, `message` for follow-up or to auto-resume a dead child session before delivery, `cancel` to stop it, and `list` to inspect child status.",
  "There is no subagent read tool. To inspect a child session, look at its tmux pane/window output directly from the parent session.",
  "Do not poll with `list` just to get the final result. By default, wait for the automatic completion summary and only use `message` or `cancel` when you need to steer or stop the child.",
] as const;

const SUBAGENT_AVAILABLE_MODES_HEADING = "Available subagent modes. When the user asks for a mode, use one of these exact names:";

async function buildSubagentPromptGuidelines(ctx: ExtensionContext): Promise<string[]> {
  return [
    ...SUBAGENT_BASE_PROMPT_GUIDELINES,
    await buildAvailableModesPromptGuideline(ctx.cwd, SUBAGENT_AVAILABLE_MODES_HEADING),
  ];
}

export function createSubagentExtension(options: CreateSubagentExtensionOptions = {}) {
  return function subagentExtension(pi: ExtensionAPI): void {
    installChildBootstrap(pi);
    const adapter = options.adapterFactory?.(pi) ?? new TmuxAdapter((command, args, execOptions) => pi.exec(command, args, execOptions), process.cwd());
    const manager = new SubagentManager(pi, adapter, buildLaunchCommand);
    const state: SubagentRuntimeState = {};

    const syncSubagentToolRegistration = async (ctx: ExtensionContext): Promise<void> => {
      state.ctx = ctx;
      const promptGuidelines = await buildSubagentPromptGuidelines(ctx);
      const signature = promptGuidelines.join("\n\n");
      if (state.toolPromptSignature === signature) {
        return;
      }

      subagentTool.promptGuidelines = promptGuidelines;
      state.toolPromptSignature = signature;
      pi.registerTool(subagentTool);
    };

    const subagentTool = defineTool<typeof SubagentToolParamsSchema, SubagentToolResultDetails>({
      name: "subagent",
      label: "π",
      description: "Manage tmux-backed child pi sessions. Actions: start, message, cancel, list. `message` auto-resumes a dead child session before delivery when needed. There is no subagent read action; inspect the child tmux pane/window output directly from the parent session. For final results, usually wait for the automatic completion summary instead of polling.",
      promptSnippet: "use `subagent` to start, message, cancel, or list tmux-backed child pi sessions; `message` auto-resumes a dead child session before delivery when needed; there is no subagent read action, and the default flow is to wait for the automatic completion summary",
      promptGuidelines: [
        ...SUBAGENT_BASE_PROMPT_GUIDELINES,
        SUBAGENT_AVAILABLE_MODES_HEADING,
      ],
      parameters: SubagentToolParamsSchema,
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        try {
          manager.setContext(ctx);
          validateToolParams(params);

          if (params.action === "start") {
            const started = await manager.start({
              name: params.name!,
              task: params.task!,
              mode: params.mode,
              handoff: params.handoff,
              cwd: params.cwd,
              autoExit: params.autoExit,
            }, ctx, onUpdate, signal);

            return {
              content: [{ type: "text", text: formatStartResultText(started.state) }],
              details: { action: "start", args: params, prompt: started.prompt, state: started.state },
            };
          }

          if (params.action === "message") {
            const result = await manager.message({
              sessionId: params.sessionId!,
              message: params.message!,
              delivery: params.delivery ?? "steer",
            }, ctx, onUpdate);

            return {
              content: [{
                type: "text",
                text: result.autoResumed
                  ? formatAutoResumedMessageResultText(result.state, params.delivery ?? "steer")
                  : "ok",
              }],
              details: {
                action: "message",
                args: params,
                message: params.message!,
                delivery: params.delivery ?? "steer",
                state: result.state,
                autoResumed: result.autoResumed,
                resumePrompt: result.resumePrompt,
              },
            };
          }

          if (params.action === "cancel") {
            const result = await manager.cancel({ sessionId: params.sessionId! });
            return {
              content: [{ type: "text", text: "ok" }],
              details: { action: "cancel", args: params, state: result },
            };
          }

          const subagents = manager.list();
          return {
            content: [{ type: "text", text: "ok" }],
            details: { action: "list", args: params, subagents },
          };
        } catch (error) {
          throw normalizeSubagentExecutionError(params.action, error);
        }
      },
      renderCall(args, theme, context) {
        const state = syncRenderState(context);
        return setCallComponent(
          state,
          context.lastComponent,
          context.expanded ? formatExpandedCallText(args, theme) : formatCollapsedCallText(args, theme),
        );
      },
      renderResult(result, { expanded, isPartial }, theme, context) {
        const state = syncStreamingRenderState(context, isPartial);
        const separator = theme.fg("dim", " · ");
        const details = result.details as SubagentToolRenderDetails | undefined;

        if (context.isError) {
          applyCollapsedSummaryToCall(state, `${separator}${theme.fg("error", "error")}`);
          return renderToolError(getTextContent(result) || "subagent failed", theme, context.lastComponent);
        }

        if (isPartial) {
          return renderPartialSubagentResult(context.args as SubagentToolParams, result, expanded, theme, context, state);
        }

        applyCollapsedSummaryToCall(state, `${separator}${formatCollapsedResultSummary(details as SubagentToolResultDetails | undefined, theme)}`);
        if (!expanded) {
          return createTextComponent(context.lastComponent, "");
        }

        return createTextComponent(
          context.lastComponent,
          formatExpandedResult(details as SubagentToolResultDetails | undefined),
        );
      },
    });

    pi.registerTool(subagentTool);

    const modesChangedEvents = (pi as ExtensionAPI & { events?: { on?: (eventName: string, handler: (...args: any[]) => any) => unknown } }).events;
    modesChangedEvents?.on?.("modes:changed", async () => {
      if (!state.ctx) {
        return;
      }

      await syncSubagentToolRegistration(state.ctx);
    });

    scheduleParentSubagentToolActivation(pi);

    pi.on("session_start", async (_event, ctx) => {
      await syncSubagentToolRegistration(ctx);
      manager.setContext(ctx);
      if (isChildSession(readChildState(), ctx)) {
        return;
      }

      ensureParentSubagentToolActive(pi);
      await manager.restore(ctx);
    });

    pi.on("before_agent_start", async (_event, ctx) => {
      await syncSubagentToolRegistration(ctx);
      if (!isChildSession(readChildState(), ctx)) {
        ensureParentSubagentToolActive(pi);
      }

      return undefined;
    });

    pi.on("session_shutdown", async () => {
      manager.dispose();
    });
  };
}

export default createSubagentExtension();
