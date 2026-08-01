import { formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  createTextComponent,
  formatToolRail,
  getTextContent,
  renderToolError,
  type CoreUIToolTheme,
} from "../coreui/tools.js";
import type { LiveScreenCaptureDetails } from "./screen-capture.js";

interface LookAtRenderState {
  callComponent?: Text;
}

interface LookAtRenderContext {
  state?: LookAtRenderState;
  lastComponent: unknown;
  isPartial: boolean;
  isError: boolean;
}

function formatCallStatus(
  text: string,
  theme: CoreUIToolTheme,
  context: LookAtRenderContext,
): string {
  return `${formatToolRail(theme, context)}${text}`;
}

function formatSuccessSummary(details: LiveScreenCaptureDetails, theme: CoreUIToolTheme): string {
  const delivery =
    details.describedBy === undefined || details.describedBy.length === 0
      ? "viewed directly"
      : `described by ${details.describedBy}`;
  return [
    theme.bold(theme.fg("muted", "look_at")),
    theme.fg("muted", `display ${details.displayId}`),
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
  const state = context.state ?? {};
  const status = context.isError
    ? `${theme.bold(theme.fg("error", "look_at"))}${theme.fg("dim", " · ")}${theme.fg("error", "error")}`
    : theme.italic(theme.fg("muted", "capturing current display…"));
  const component = createTextComponent(
    state.callComponent ?? context.lastComponent,
    formatCallStatus(status, theme, context),
  );
  state.callComponent = component;
  return component;
}

function renderLookAtResult(
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: LiveScreenCaptureDetails;
  },
  options: { expanded?: boolean; isPartial?: boolean },
  theme: CoreUIToolTheme,
  context: LookAtRenderContext,
): Text {
  const state = context.state ?? {};
  if (context.isError) {
    state.callComponent?.setText(
      formatCallStatus(
        `${theme.bold(theme.fg("error", "look_at"))}${theme.fg("dim", " · ")}${theme.fg("error", "error")}`,
        theme,
        context,
      ),
    );
    return renderToolError(
      sanitizeErrorMessage(getTextContent(result)),
      theme,
      context.lastComponent,
    );
  }
  if (options.isPartial === true) {
    return createTextComponent(context.lastComponent, "");
  }
  if (result.details === undefined) {
    state.callComponent?.setText(
      formatCallStatus(
        theme.bold(theme.fg("muted", "look_at · capture metadata unavailable")),
        theme,
        context,
      ),
    );
    return createTextComponent(context.lastComponent, "");
  }

  state.callComponent?.setText(
    formatCallStatus(formatSuccessSummary(result.details, theme), theme, context),
  );
  if (options.expanded !== true) {
    return createTextComponent(context.lastComponent, "");
  }
  return createTextComponent(
    context.lastComponent,
    formatCallStatus(formatExpandedDetails(result.details), theme, context),
  );
}

export { renderLookAtCall, renderLookAtResult };
