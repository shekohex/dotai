import { formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  applyLinePrefix,
  createTextComponent,
  formatDurationHuman,
  formatToolRail,
  getTextContent,
  renderToolError,
  type CoreUIToolTheme,
} from "../coreui/tools.js";
import { formatToolStatus } from "../coreui/tools-status.js";
import type {
  LiveScreenCaptureDetails,
  LiveScreenCaptureProgressDetails,
  LiveScreenCaptureToolDetails,
} from "./screen-capture.js";

interface LookAtRenderState {
  startedAt?: number;
  endedAt?: number;
  interval?: NodeJS.Timeout;
  callComponent?: Text;
  phase?: LiveScreenCaptureProgressDetails["phase"];
}

interface LookAtRenderContext {
  state: unknown;
  lastComponent: unknown;
  executionStarted: boolean;
  isPartial: boolean;
  isError: boolean;
  invalidate: () => void;
}

function isLookAtRenderState(value: unknown): value is LookAtRenderState {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function syncRenderState(context: LookAtRenderContext): LookAtRenderState {
  const state = isLookAtRenderState(context.state) ? context.state : {};
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

function elapsedMs(state: LookAtRenderState): number {
  if (state.startedAt === undefined) return 0;
  return (state.endedAt ?? Date.now()) - state.startedAt;
}

function isProgressDetails(
  details: LiveScreenCaptureToolDetails | undefined,
): details is LiveScreenCaptureProgressDetails {
  return (
    details !== undefined &&
    "phase" in details &&
    (details.phase === "capturing" || details.phase === "describing")
  );
}

function isCaptureDetails(
  details: LiveScreenCaptureToolDetails | undefined,
): details is LiveScreenCaptureDetails {
  return details !== undefined && "width" in details && "height" in details;
}

function formatCallText(
  theme: CoreUIToolTheme,
  context: LookAtRenderContext,
  state: LookAtRenderState,
): string {
  const status = formatToolStatus(theme, context, {
    pending: state.phase === "describing" ? "describing display" : "capturing display",
    success: "viewed display",
    error: "look at display failed",
  });
  const elapsed = context.isPartial
    ? `${theme.fg("dim", " · ")}${theme.fg("muted", formatDurationHuman(elapsedMs(state)))}`
    : "";
  return `${formatToolRail(theme, context)}${status}${elapsed}`;
}

function formatSuccessSummary(details: LiveScreenCaptureDetails, theme: CoreUIToolTheme): string {
  const delivery =
    details.describedBy === undefined || details.describedBy.length === 0
      ? "viewed directly"
      : `described by ${details.describedBy}`;
  return [
    theme.fg("muted", `${details.width}×${details.height}`),
    theme.fg("muted", `${formatSize(details.byteSize)} JPEG`),
    theme.fg("muted", delivery),
  ].join(theme.fg("dim", " · "));
}

function formatExpandedDetails(details: LiveScreenCaptureDetails): string {
  const lines = [
    `path: ${details.path}`,
    `mimeType: ${details.mimeType}`,
    `dimensions: ${details.width}×${details.height}`,
    `displayId: ${details.displayId}`,
    `capturedAt: ${new Date(details.timestamp).toISOString()}`,
    `byteSize: ${details.byteSize} (${formatSize(details.byteSize)})`,
    `sha256: ${details.sha256.slice(0, 12)}…`,
  ];
  if (details.pointerX !== undefined && details.pointerY !== undefined) {
    lines.push(`pointer: ${details.pointerX}, ${details.pointerY}`);
  }
  if (details.describedBy !== undefined) {
    lines.push(`describedBy: ${details.describedBy}`);
  }
  return lines.join("\n");
}

function sanitizeErrorMessage(message: string): string {
  return message.replaceAll(/[A-Za-z\d+/]{128,}={0,2}/gu, "[redacted image data]").slice(0, 500);
}

function renderLookAtCall(
  _args: object,
  theme: CoreUIToolTheme,
  context: LookAtRenderContext,
): Text {
  const state = syncRenderState(context);
  const component = createTextComponent(
    state.callComponent ?? context.lastComponent,
    formatCallText(theme, context, state),
  );
  state.callComponent = component;
  return component;
}

function renderLookAtResult(
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: LiveScreenCaptureToolDetails;
  },
  options: { expanded?: boolean; isPartial?: boolean },
  theme: CoreUIToolTheme,
  context: LookAtRenderContext,
): Text {
  const state = syncRenderState({ ...context, isPartial: options.isPartial === true });
  if (options.isPartial === true) {
    if (isProgressDetails(result.details)) state.phase = result.details.phase;
    state.callComponent?.setText(formatCallText(theme, { ...context, isPartial: true }, state));
    return createTextComponent(context.lastComponent, "");
  }
  if (context.isError) {
    state.callComponent?.setText(formatCallText(theme, context, state));
    return renderToolError(
      sanitizeErrorMessage(getTextContent(result)),
      theme,
      context.lastComponent,
    );
  }
  if (!isCaptureDetails(result.details)) {
    state.callComponent?.setText(
      `${formatCallText(theme, context, state)}${theme.fg("dim", " · ")}${theme.fg("muted", "metadata unavailable")}`,
    );
    return createTextComponent(context.lastComponent, "");
  }

  state.callComponent?.setText(
    [
      `${formatCallText(theme, context, state)} ${theme.fg("text", result.details.displayId)}`,
      formatSuccessSummary(result.details, theme),
      theme.fg("muted", `took ${formatDurationHuman(elapsedMs(state))}`),
    ].join(theme.fg("dim", " · ")),
  );
  if (options.expanded !== true) {
    return createTextComponent(context.lastComponent, "");
  }
  return createTextComponent(
    context.lastComponent,
    applyLinePrefix(formatExpandedDetails(result.details), formatToolRail(theme, context)),
  );
}

export { renderLookAtCall, renderLookAtResult };
