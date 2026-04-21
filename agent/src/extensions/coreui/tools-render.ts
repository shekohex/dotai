import { readToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

type ToolTheme = Parameters<NonNullable<typeof readToolDefinition.renderCall>>[1];

export type CoreUIToolTheme = ToolTheme;

export type StreamingPreviewOptions = {
  expanded: boolean;
  footer?: string;
  tailLines?: number;
};

const TOOL_TEXT_PADDING_X = 0;
const TOOL_TEXT_PADDING_Y = 0;

export function createTextComponent(lastComponent: unknown, text: string): Text {
  const component =
    lastComponent instanceof Text
      ? lastComponent
      : new Text("", TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y);
  component.setText(text);
  return component;
}

export function renderStreamingPreview(
  renderedText: string,
  theme: CoreUIToolTheme,
  lastComponent: unknown,
  options: StreamingPreviewOptions,
): Text {
  const lines = renderedText.split("\n").filter((line) => line.length > 0);
  const tailSize = getTailSize(options.tailLines);

  if (options.expanded) {
    const footerLines = formatStreamingFooterLine(theme, options.footer);
    const text = [renderedText, footerLines].filter(Boolean).join("\n");
    return createTextComponent(lastComponent, text);
  }

  const visibleLines = lines.slice(-tailSize);
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
    blocks.push(formatStreamingFooterLine(theme, options.footer));
  }

  return createTextComponent(lastComponent, blocks.join("\n"));
}

export function applyLinePrefix(text: string, linePrefix?: string): string {
  if (linePrefix === undefined || linePrefix.length === 0 || text.length === 0) {
    return text;
  }

  return text
    .split("\n")
    .map((line) => `${linePrefix}${line}`)
    .join("\n");
}

export function renderToolError(
  message: string,
  theme: CoreUIToolTheme,
  lastComponent: unknown,
): Text {
  return createTextComponent(
    lastComponent,
    message ? theme.fg("error", `↳ ${message.trim()}`) : "",
  );
}

function getTailSize(tailLines?: number): number {
  if (tailLines === undefined) {
    return 5;
  }

  return tailLines;
}

function formatStreamingFooterLine(theme: ToolTheme, footer?: string): string {
  if (footer === undefined || footer.length === 0) {
    return "";
  }

  return `${theme.fg("dim", "↳ ")}${theme.fg("dim", footer)}`;
}
