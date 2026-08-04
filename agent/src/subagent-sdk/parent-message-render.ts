import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  applyLinePrefix,
  createTextComponent,
  formatDurationHuman,
  formatToolRail,
  getTextContent,
  renderToolError,
} from "../extensions/coreui/tools.js";
import { formatToolStatus } from "../extensions/coreui/tools-status.js";
import {
  parseSubagentParentMessage,
  type SubagentParentMessage,
  type SubagentParentMessageToolParams,
} from "./parent-message-types.js";

export interface SubagentParentMessageRenderState {
  startedAt?: number;
  endedAt?: number;
  interval?: NodeJS.Timeout;
  callComponent?: Text;
}

interface ParentMessageRenderContext {
  state: unknown;
  lastComponent: unknown;
  executionStarted: boolean;
  isPartial: boolean;
  isError: boolean;
  expanded: boolean;
  invalidate: () => void;
}

function isRenderState(value: unknown): value is SubagentParentMessageRenderState {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function syncRenderState(context: ParentMessageRenderContext): SubagentParentMessageRenderState {
  const state = isRenderState(context.state) ? context.state : {};
  if (context.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }
  if (context.isPartial && state.startedAt !== undefined && state.interval === undefined) {
    state.interval = setInterval(context.invalidate, 1000);
    state.interval.unref?.();
  }
  if (!context.isPartial && state.startedAt !== undefined) {
    state.endedAt ??= Date.now();
    if (state.interval !== undefined) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }
  return state;
}

function elapsedMs(state: SubagentParentMessageRenderState): number {
  if (state.startedAt === undefined) return 0;
  return (state.endedAt ?? Date.now()) - state.startedAt;
}

function summarizeMessage(message: string, maxLength = 72): string {
  const summary = message.replaceAll(/\s+/gu, " ").trim();
  return summary.length <= maxLength ? summary : `${summary.slice(0, maxLength - 1)}…`;
}

function formatCallText(
  args: SubagentParentMessageToolParams,
  theme: Theme,
  context: ParentMessageRenderContext,
  state: SubagentParentMessageRenderState,
): string {
  const status = formatToolStatus(theme, context, {
    pending: "messaging parent",
    success: "messaged parent",
    error: "message parent failed",
  });
  const kind = args.kind ?? "commentary";
  const delivery = args.delivery ?? "steer";
  const separator = theme.fg("dim", " · ");
  const header = [
    `${formatToolRail(theme, context)}${status}`,
    theme.fg("muted", kind),
    theme.fg("muted", delivery),
  ].join(separator);
  if (context.expanded) {
    return [
      header,
      `target: parent`,
      `kind: ${kind}`,
      `delivery: ${delivery}`,
      `message: ${args.message}`,
    ].join("\n");
  }
  const message = summarizeMessage(args.message);
  const duration = context.isPartial
    ? `${separator}${theme.fg("muted", formatDurationHuman(elapsedMs(state)))}`
    : "";
  return `${header}${separator}${theme.fg("text", message)}${duration}`;
}

function formatExpandedResult(details: SubagentParentMessage): string {
  return [
    `target: parent`,
    `kind: ${details.kind}`,
    `delivery: ${details.delivery}`,
    `createdAt: ${new Date(details.createdAt).toISOString()}`,
  ].join("\n");
}

export function renderSubagentParentMessageCall(
  args: SubagentParentMessageToolParams,
  theme: Theme,
  context: ParentMessageRenderContext,
): Text {
  const state = syncRenderState(context);
  const component = createTextComponent(
    state.callComponent ?? context.lastComponent,
    formatCallText(args, theme, context, state),
  );
  state.callComponent = component;
  return component;
}

export function renderSubagentParentMessageResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: ParentMessageRenderContext & { args: SubagentParentMessageToolParams },
): Text {
  const state = syncRenderState({ ...context, isPartial: options.isPartial });
  const details = parseSubagentParentMessage(result.details);
  if (state.callComponent instanceof Text) {
    const callText = formatCallText(
      context.args,
      theme,
      { ...context, isPartial: options.isPartial },
      state,
    );
    if (!options.isPartial && !context.isError) {
      state.callComponent.setText(
        `${callText}${theme.fg("dim", " · ")}${theme.fg("muted", `took ${formatDurationHuman(elapsedMs(state))}`)}`,
      );
    } else {
      state.callComponent.setText(callText);
    }
  }
  if (options.isPartial) {
    return createTextComponent(context.lastComponent, "");
  }
  if (context.isError) {
    return renderToolError(getTextContent(result), theme, context.lastComponent);
  }
  if (!options.expanded || details === undefined) {
    return createTextComponent(context.lastComponent, "");
  }
  return createTextComponent(
    context.lastComponent,
    applyLinePrefix(formatExpandedResult(details), formatToolRail(theme, context)),
  );
}
