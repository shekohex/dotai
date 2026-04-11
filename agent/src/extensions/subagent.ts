import fsSync from "node:fs";

import { defineTool, type ExtensionAPI, type ExtensionContext, type Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

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
import { getParentInjectedInputMarkerPath } from "./subagent/session.js";
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

function hasActiveParentInjectedInput(childState: ChildBootstrapState | undefined): boolean {
  if (!childState) {
    return false;
  }

  try {
    const markerPath = getParentInjectedInputMarkerPath(childState.sessionId);
    const raw = fsSync.readFileSync(markerPath, "utf8");
    const parsed = JSON.parse(raw) as { expiresAt?: unknown };
    if (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= Date.now()) {
      fsSync.rmSync(markerPath, { force: true });
      return false;
    }

    return true;
  } catch {
    return false;
  }
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
  let autoExitEnabled = Boolean(childState?.autoExit);
  let lastInputTimestamp = 0;

  pi.on("session_start", async (_event, ctx) => {
    const currentChildState = childState;
    if (!isChildSession(currentChildState, ctx)) {
      return;
    }

    applyChildToolState(pi, currentChildState);
    pi.setSessionName(currentChildState.name);

    if (!ctx.hasUI) {
      return;
    }

    ctx.ui.onTerminalInput((data) => {
      if (!autoExitEnabled || !data.trim()) {
        return undefined;
      }
      if (hasActiveParentInjectedInput(currentChildState)) {
        return undefined;
      }

      lastInputTimestamp = Date.now();
      autoExitEnabled = false;
      ctx.ui.notify(`Subagent ${currentChildState.name} auto-exit disabled`, "info");
      return undefined;
    });
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const currentChildState = childState;
    if (!isChildSession(currentChildState, ctx)) {
      return undefined;
    }

    applyChildToolState(pi, currentChildState);
    return undefined;
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!isChildSession(childState, ctx) || !autoExitEnabled) {
      return;
    }
    if (Date.now() - lastInputTimestamp < 250) {
      return;
    }

    ctx.shutdown();
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
      throw new Error("subagent start requires name");
    }
    if (!params.task?.trim()) {
      throw new Error("subagent start requires task");
    }
  }

  if (params.action === "resume") {
    if (!params.sessionId?.trim()) {
      throw new Error("subagent resume requires sessionId");
    }
    if (!params.task?.trim()) {
      throw new Error("subagent resume requires task");
    }
  }

  if (params.action === "message") {
    if (!params.sessionId?.trim()) {
      throw new Error("subagent message requires sessionId");
    }
    if (!params.message?.trim()) {
      throw new Error("subagent message requires message");
    }
  }

  if (params.action === "cancel" && !params.sessionId?.trim()) {
    throw new Error("subagent cancel requires sessionId");
  }
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
  if (args.action === "resume") {
    return `${prefix} ${action}${separator}${theme.fg("muted", `${shortSessionId(args.sessionId)} · ${summarizeTask(args.task)}`)}`;
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

  if (args.action === "resume") {
    lines.push(...formatField("sessionId", args.sessionId));
    lines.push(...formatField("mode", args.mode));
    lines.push(...formatField("cwd", args.cwd));
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

  if (details.action === "start" || details.action === "resume") {
    resultLines.push(...formatField("prompt", details.prompt, true));
    return resultLines.join("\n");
  }

  if (details.action === "message") {
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

export function createSubagentExtension(options: CreateSubagentExtensionOptions = {}) {
  return function subagentExtension(pi: ExtensionAPI): void {
    installChildBootstrap(pi);
    const adapter = options.adapterFactory?.(pi) ?? new TmuxAdapter((command, args, execOptions) => pi.exec(command, args, execOptions), process.cwd());
    const manager = new SubagentManager(pi, adapter, buildLaunchCommand);

    pi.registerTool(defineTool<typeof SubagentToolParamsSchema, SubagentToolResultDetails>({
      name: "subagent",
      label: "π",
      description: "Manage tmux-backed child pi sessions. Actions: start, resume, message, cancel, list.",
      promptSnippet: "use `subagent` to start, resume, message, cancel, or list tmux-backed child pi sessions",
      promptGuidelines: [
        "Use `subagent` when the user wants parallel or delegated work in another tmux-backed pi session.",
        "Use `start` to launch a child session, `resume` to reattach a finished child session, `message` for follow-up, `cancel` to stop it, and `list` to inspect child status.",
      ],
      parameters: SubagentToolParamsSchema,
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
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
            content: [{ type: "text", text: "ok" }],
            details: { action: "start", args: params, prompt: started.prompt, state: started.state },
          };
        }

        if (params.action === "resume") {
          const resumed = await manager.resume({
            sessionId: params.sessionId!,
            task: params.task!,
            mode: params.mode,
            cwd: params.cwd,
            autoExit: params.autoExit,
          }, ctx, onUpdate);

          return {
            content: [{ type: "text", text: "ok" }],
            details: { action: "resume", args: params, prompt: resumed.prompt, state: resumed.state },
          };
        }

        if (params.action === "message") {
          const result = await manager.message({
            sessionId: params.sessionId!,
            message: params.message!,
            delivery: params.delivery ?? "steer",
          }, onUpdate);

          return {
            content: [{ type: "text", text: "ok" }],
            details: { action: "message", args: params, message: params.message!, delivery: params.delivery ?? "steer", state: result },
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
    }));

    scheduleParentSubagentToolActivation(pi);

    pi.on("session_start", async (_event, ctx) => {
      manager.setContext(ctx);
      if (isChildSession(readChildState(), ctx)) {
        return;
      }

      ensureParentSubagentToolActive(pi);
      await manager.restore(ctx);
    });

    pi.on("before_agent_start", async (_event, ctx) => {
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
