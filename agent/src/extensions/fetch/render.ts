import { formatSize } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { applyLinePrefix } from "../coreui/tools.js";
import {
  normalizeStatusText,
  STATUS_CONTENT_TYPE_MAX_LENGTH,
  STREAM_PREVIEW_LINE_LENGTH,
  STREAM_PREVIEW_LINE_LIMIT,
  TOOL_TEXT_PADDING_X,
  TOOL_TEXT_PADDING_Y,
  type ToolTheme,
  type WebFetchDetails,
  type WebFetchRenderState,
} from "./types.js";

function renderFetchErrorResult(
  expanded: boolean,
  lastComponent: unknown,
  rail: string,
  textContent: string,
  theme: ToolTheme,
): Text {
  if (!expanded) {
    return createTextComponent(lastComponent, "");
  }

  return createTextComponent(
    lastComponent,
    `${rail}${renderToolErrorLine(textContent || "webfetch failed", theme)}`,
  );
}

function renderFetchPartialResult(
  expanded: boolean,
  lastComponent: unknown,
  rail: string,
  textContent: string,
  details: WebFetchDetails | undefined,
  theme: ToolTheme,
): Text {
  const streamed = styleToolOutput(textContent, theme, STREAM_PREVIEW_LINE_LENGTH);
  const elapsed =
    details?.durationMs === undefined ? "" : ` (${formatDurationHuman(details.durationMs)})`;
  return renderStreamingPreview(streamed, theme, lastComponent, {
    expanded,
    linePrefix: rail,
    footer: `${summarizeLineCount(countTextLines(textContent))} so far${elapsed}${details ? ` · ${renderStatusMeta(details, theme)}` : ""}`,
  });
}

function renderFetchCompleteResult(
  expanded: boolean,
  lastComponent: unknown,
  rail: string,
  details: WebFetchDetails | undefined,
  theme: ToolTheme,
): Text {
  if (!details || !expanded) {
    return createTextComponent(lastComponent, "");
  }

  const body = details.body.trim();
  if (!body) {
    return createTextComponent(
      lastComponent,
      `${rail}${theme.fg("dim", "↳ ")}${renderStatusMeta(details, theme)}`,
    );
  }

  return createTextComponent(
    lastComponent,
    `${rail}${theme.fg("dim", "↳ ")}${renderStatusMeta(details, theme)}\n${applyLinePrefix(styleToolOutput(body, theme, STREAM_PREVIEW_LINE_LENGTH), rail)}`,
  );
}

function renderStatusMeta(
  details: Pick<WebFetchDetails, "status" | "statusText" | "contentType" | "bytes" | "truncation">,
  theme: ToolTheme,
): string {
  const color = getStatusColor(details.status);
  const parts = [theme.fg(color, `${details.status} ${details.statusText}`.trim())];

  if (details.contentType) {
    parts.push(
      theme.fg("muted", truncateMiddle(details.contentType, STATUS_CONTENT_TYPE_MAX_LENGTH)),
    );
  }
  parts.push(theme.fg("muted", formatSize(details.bytes)));
  if (details.truncation?.truncated === true) {
    parts.push(theme.fg("warning", "truncated"));
  }

  return parts.join(theme.fg("muted", " · "));
}

function getStatusColor(status: number): "success" | "warning" | "error" | "muted" {
  if (status >= 200 && status < 300) {
    return "success";
  }
  if (status >= 300 && status < 400) {
    return "warning";
  }
  if (status >= 400) {
    return "error";
  }
  return "muted";
}

function renderStreamingPreview(
  renderedText: string,
  theme: ToolTheme,
  lastComponent: unknown,
  options: { expanded: boolean; footer?: string; linePrefix?: string },
): Text {
  const lines = renderedText.split("\n").filter((line) => line.length > 0);

  if (options.expanded) {
    const footer =
      options.footer !== undefined && options.footer.length > 0
        ? `${theme.fg("dim", "↳ ")}${theme.fg("muted", options.footer)}`
        : "";
    return createTextComponent(
      lastComponent,
      applyLinePrefix([renderedText, footer].filter(Boolean).join("\n"), options.linePrefix),
    );
  }

  const visibleLines = lines.slice(-STREAM_PREVIEW_LINE_LIMIT);
  const earlierCount = Math.max(lines.length - visibleLines.length, 0);
  const blocks: string[] = [];
  if (earlierCount > 0) {
    blocks.push(
      `${theme.fg("dim", "↳ ")}${theme.fg("muted", `... (${earlierCount} earlier lines)`)}`,
    );
  }
  if (visibleLines.length > 0) {
    blocks.push(visibleLines.join("\n"));
  }
  if (options.footer !== undefined && options.footer.length > 0) {
    blocks.push(`${theme.fg("dim", "↳ ")}${theme.fg("muted", options.footer)}`);
  }

  return createTextComponent(lastComponent, applyLinePrefix(blocks.join("\n"), options.linePrefix));
}

function renderToolErrorLine(message: string, theme: ToolTheme): string {
  return `${theme.fg("error", "↳ ")}${theme.fg("error", message.trim())}`;
}

function syncRenderState(
  context: { state: unknown; executionStarted: boolean; invalidate: () => void },
  isPartial: boolean,
  isWebFetchRenderState: (value: unknown) => value is WebFetchRenderState,
): WebFetchRenderState {
  const state = isWebFetchRenderState(context.state) ? context.state : {};
  if (context.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }
  if (state.startedAt !== undefined && isPartial && !state.interval) {
    state.interval = setInterval(() => {
      context.invalidate();
    }, 1000);
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

function getElapsedMs(state: WebFetchRenderState): number | undefined {
  if (state.startedAt === undefined) {
    return undefined;
  }
  return (state.endedAt ?? Date.now()) - state.startedAt;
}

function formatDurationHuman(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function countTextLines(content: string): number {
  if (!content) {
    return 0;
  }
  return content.split("\n").length;
}

function summarizeLineCount(lineCount: number): string {
  return `${lineCount} line${lineCount === 1 ? "" : "s"}`;
}

function styleToolOutput(text: string, theme: ToolTheme, maxLineLength?: number): string {
  if (!text) {
    return "";
  }

  return text
    .split("\n")
    .map((line) => {
      if (maxLineLength === undefined || line.length <= maxLineLength) {
        return theme.fg("toolOutput", line);
      }
      const visibleText = line.slice(0, maxLineLength);
      const truncatedChars = line.length - maxLineLength;
      return `${theme.fg("toolOutput", visibleText)}${theme.fg("muted", ` …(truncated ${truncatedChars} chars)…`)}`;
    })
    .join("\n");
}

function getTextContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function createTextComponent(lastComponent: unknown, text: string): Text {
  const component =
    lastComponent instanceof Text
      ? lastComponent
      : new Text("", TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y);
  component.setText(text);
  return component;
}

function formatResult(details: WebFetchDetails): string {
  const statusText = normalizeStatusText(details.statusText, details.status);
  const lines = [
    `URL: ${details.finalUrl}`,
    `Status: ${details.status} ${statusText}`,
    `Content-Type: ${details.contentType}`,
    `Bytes: ${formatSize(details.bytes)}`,
  ];
  if (details.finalUrl !== details.url) {
    lines.push(`Original URL: ${details.url}`);
  }
  if (details.body) {
    lines.push("", details.body);
  }
  return lines.join("\n");
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const headLength = Math.max(1, Math.floor((maxLength - 1) / 2));
  const tailLength = Math.max(1, maxLength - headLength - 1);
  return `${value.slice(0, headLength)}…${value.slice(-tailLength)}`;
}

export {
  createTextComponent,
  formatDurationHuman,
  formatResult,
  getElapsedMs,
  getTextContent,
  renderFetchCompleteResult,
  renderFetchErrorResult,
  renderFetchPartialResult,
  syncRenderState,
};
