import type { Text } from "@mariozechner/pi-tui";
import { readToolDefinition } from "./builtins.js";
import { splitToolPath, type ToolPathDisplay } from "./path.js";
import { countTextLines, summarizeLineCount } from "./tools-output.js";
import { createTextComponent } from "./tools-render.js";
import { formatToolRail, formatToolStatus, type ToolVerbs } from "./tools-status.js";

type ToolTheme = Parameters<NonNullable<typeof readToolDefinition.renderCall>>[1];

type BaseRenderContext = {
  cwd: string;
  isPartial: boolean;
  isError: boolean;
  lastComponent: unknown;
};

export function readPathArg(args: { path?: unknown; file_path?: unknown }): string {
  const value = args.file_path ?? args.path;
  return typeof value === "string" ? value : "";
}

export function readContentArg(args: { content?: unknown }): string {
  return typeof args.content === "string" ? args.content : "";
}

export function formatReadRangeSuffix(theme: ToolTheme, offset: unknown, limit: unknown): string {
  const startLine = typeof offset === "number" ? offset : undefined;
  const maxLines = typeof limit === "number" ? limit : undefined;

  if (startLine === undefined && maxLines === undefined) {
    return "";
  }

  const start = startLine ?? 1;
  const end = maxLines === undefined ? undefined : start + maxLines - 1;
  return theme.fg("dim", ` (${formatReadRange(start, end)})`);
}

export function formatLineCountSuffix(content: unknown, theme: ToolTheme): string {
  const lineCount = countTextLines(content);
  if (lineCount === 0) {
    return "";
  }

  return theme.fg("dim", ` · ± ${summarizeLineCount(lineCount)}`);
}

export function getToolPathDisplay(rawPath: string, cwd: string): ToolPathDisplay {
  return splitToolPath(rawPath, cwd);
}

export function formatMutedDirSuffix(theme: ToolTheme, dirSuffix: string): string {
  if (!dirSuffix) {
    return "";
  }

  return theme.fg("muted", ` ${dirSuffix}`);
}

export function renderStatusPathToolCall(
  verbs: ToolVerbs,
  rawPath: string,
  theme: ToolTheme,
  context: BaseRenderContext,
  detail = "",
): Text {
  const pathDisplay = getToolPathDisplay(rawPath, context.cwd);
  return renderStatusLine(
    verbs,
    pathDisplay.basename,
    detail,
    theme,
    context,
    pathDisplay.dirSuffix,
  );
}

export function renderStatusLine(
  verbs: ToolVerbs,
  subject: string,
  detail: string,
  theme: ToolTheme,
  context: BaseRenderContext,
  subjectDir = "",
): Text {
  const status = formatToolStatus(theme, context, verbs);
  const text = `${formatToolRail(theme, context)}${status} ${theme.fg("text", subject)}${formatMutedDirSuffix(theme, subjectDir)}${detail}`;

  return createTextComponent(context.lastComponent, text);
}

function formatReadRange(start: number, end?: number): string {
  if (end === undefined) {
    return `${start}`;
  }

  return `${start}-${end}`;
}
