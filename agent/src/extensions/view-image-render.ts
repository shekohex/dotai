import { formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  applyLinePrefix,
  createTextComponent,
  formatDurationHuman,
  formatMutedDirSuffix,
  formatToolRail,
  getTextContent,
  getToolPathDisplay,
  renderToolError,
  type CoreUIToolTheme,
} from "./coreui/tools.js";
import { formatToolStatus } from "./coreui/tools-status.js";
import { parseViewImageDetails, type ViewImageDetails } from "./view-image-types.js";

export interface ViewImageRenderState {
  startedAt?: number;
  endedAt?: number;
  interval?: NodeJS.Timeout;
  callComponent?: Text;
  phase?: ViewImageDetails["phase"];
}

interface ViewImageRenderContext {
  cwd: string;
  state: unknown;
  lastComponent: unknown;
  executionStarted: boolean;
  isPartial: boolean;
  isError: boolean;
  expanded: boolean;
  invalidate: () => void;
}

function isViewImageRenderState(value: unknown): value is ViewImageRenderState {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function syncRenderState(
  context: Pick<ViewImageRenderContext, "state" | "executionStarted" | "isPartial" | "invalidate">,
): ViewImageRenderState {
  const state = isViewImageRenderState(context.state) ? context.state : {};
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

function elapsedMs(state: ViewImageRenderState): number {
  if (state.startedAt === undefined) return 0;
  return (state.endedAt ?? Date.now()) - state.startedAt;
}

function formatImagePath(path: string, cwd: string, theme: CoreUIToolTheme): string {
  const display = getToolPathDisplay(path, cwd);
  return `${theme.fg("text", display.basename || path || "image")}${formatMutedDirSuffix(theme, display.dirSuffix)}`;
}

function formatImageBasename(path: string, cwd: string, theme: CoreUIToolTheme): string {
  const display = getToolPathDisplay(path, cwd);
  return theme.fg("text", display.basename || path || "image");
}

function formatCallText(
  args: { path?: unknown },
  theme: CoreUIToolTheme,
  context: ViewImageRenderContext,
  state: ViewImageRenderState,
): string {
  const path = typeof args.path === "string" ? args.path : "";
  const pendingVerb = state.phase === "describing" ? "describing" : "loading";
  const status = formatToolStatus(theme, context, {
    pending: pendingVerb,
    success: "viewed",
    error: "view image failed",
  });
  const duration = context.isPartial
    ? theme.fg("muted", ` · ${formatDurationHuman(elapsedMs(state))}`)
    : "";
  const displayPath = context.isPartial
    ? formatImagePath(path, context.cwd, theme)
    : formatImageBasename(path, context.cwd, theme);
  return `${formatToolRail(theme, context)}${status} ${displayPath}${duration}`;
}

function formatSuccessSummary(details: ViewImageDetails, theme: CoreUIToolTheme): string {
  const delivery =
    details.describedBy === undefined ? "viewed directly" : `described by ${details.describedBy}`;
  const parts = [
    details.mimeType,
    details.byteSize === undefined ? undefined : formatSize(details.byteSize),
    delivery,
  ].filter((part): part is string => part !== undefined && part.length > 0);
  return parts.map((part) => theme.fg("muted", part)).join(theme.fg("dim", " · "));
}

function formatExpandedDetails(details: ViewImageDetails): string {
  const lines = [`path: ${details.path}`];
  if (details.mimeType !== undefined) lines.push(`mimeType: ${details.mimeType}`);
  if (details.byteSize !== undefined) {
    lines.push(`byteSize: ${details.byteSize} (${formatSize(details.byteSize)})`);
  }
  lines.push(
    details.describedBy === undefined
      ? "presentation: viewed directly"
      : `presentation: described by ${details.describedBy}`,
  );
  return lines.join("\n");
}

function updateCompletedCall(
  args: { path?: unknown },
  details: ViewImageDetails | undefined,
  theme: CoreUIToolTheme,
  context: ViewImageRenderContext,
  state: ViewImageRenderState,
): void {
  if (!(state.callComponent instanceof Text)) return;
  const base = formatCallText(args, theme, { ...context, isPartial: false }, state);
  if (context.isError || details === undefined) {
    state.callComponent.setText(base);
    return;
  }
  const summary = formatSuccessSummary(details, theme);
  const took = theme.fg("muted", `took ${formatDurationHuman(elapsedMs(state))}`);
  state.callComponent.setText([base, summary, took].filter(Boolean).join(theme.fg("dim", " · ")));
}

export function renderViewImageCall(
  args: { path?: unknown },
  theme: CoreUIToolTheme,
  context: ViewImageRenderContext,
): Text {
  const state = syncRenderState(context);
  const component = createTextComponent(
    state.callComponent ?? context.lastComponent,
    formatCallText(args, theme, context, state),
  );
  state.callComponent = component;
  return component;
}

export function renderViewImageResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: CoreUIToolTheme,
  context: ViewImageRenderContext & { args: { path?: unknown } },
): Text {
  const state = syncRenderState({ ...context, isPartial: options.isPartial });
  const details = parseViewImageDetails(result.details);
  if (options.isPartial) {
    state.phase = details?.phase ?? state.phase;
    if (state.callComponent instanceof Text) {
      state.callComponent.setText(
        formatCallText(context.args, theme, { ...context, isPartial: true }, state),
      );
    }
    return createTextComponent(context.lastComponent, "");
  }

  updateCompletedCall(context.args, details, theme, context, state);
  if (context.isError) {
    return renderToolError(getTextContent(result), theme, context.lastComponent);
  }
  if (!options.expanded || details === undefined) {
    return createTextComponent(context.lastComponent, "");
  }
  return createTextComponent(
    context.lastComponent,
    applyLinePrefix(formatExpandedDetails(details), formatToolRail(theme, context)),
  );
}
