import { readToolDefinition, type ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import { getTextContent, summarizeTextLineCount } from "./tools-output.js";
import {
  formatReadRangeSuffix,
  renderStatusLine,
  renderStatusPathToolCall,
} from "./tools-path-render.js";
import { createTextComponent, renderToolError } from "./tools-render.js";

type ToolTheme = Parameters<NonNullable<typeof readToolDefinition.renderCall>>[1];
type ReadCallArgs = Parameters<NonNullable<typeof readToolDefinition.renderCall>>[0];
type ReadCallContext = Parameters<NonNullable<typeof readToolDefinition.renderCall>>[2];
type ReadResult = Parameters<NonNullable<typeof readToolDefinition.renderResult>>[0];
type ReadResultContext = Parameters<NonNullable<typeof readToolDefinition.renderResult>>[3];

function renderReadToolCall(args: ReadCallArgs, theme: ToolTheme, context: ReadCallContext) {
  const rawPath = readPathArg(args);
  const skillMatch = rawPath.match(/(?:^|[\\/])([^\\/]+)[\\/]SKILL\.md$/);
  if (skillMatch) {
    return renderStatusLine(
      { pending: "reading", success: "skill", error: "skill" },
      skillMatch[1],
      "",
      theme,
      context,
    );
  }

  return renderStatusPathToolCall(
    { pending: "reading", success: "read", error: "read" },
    rawPath,
    theme,
    context,
    formatReadRangeSuffix(theme, args.offset, args.limit),
  );
}

function renderReadToolResult(
  result: ReadResult,
  options: ToolRenderResultOptions,
  theme: ToolTheme,
  context: ReadResultContext,
) {
  const textContent = getTextContent(result);
  if (context.isError) {
    if (options.expanded) {
      return renderToolError(textContent || "failed to read", theme, context.lastComponent);
    }
    return createTextComponent(context.lastComponent, "");
  }
  if (options.isPartial) {
    return createTextComponent(
      context.lastComponent,
      theme.fg("dim", summarizeReadResult(result, true)),
    );
  }
  if (!options.expanded || !textContent) {
    return createTextComponent(context.lastComponent, "");
  }

  return delegateReadResult(result, options, theme, context, textContent);
}

function delegateReadResult(
  result: ReadResult,
  options: ToolRenderResultOptions,
  theme: ToolTheme,
  context: ReadResultContext,
  fallbackText: string,
) {
  if (readToolDefinition.renderResult) {
    return readToolDefinition.renderResult(result, options, theme, {
      ...context,
      lastComponent: createTextComponent(context.lastComponent, ""),
    });
  }

  return createTextComponent(context.lastComponent, `\n${theme.fg("toolOutput", fallbackText)}`);
}

function summarizeReadResult(
  result: { content: Array<{ type: string; text?: string }> },
  partial: boolean,
): string {
  const image = result.content.find((part) => part.type === "image");
  if (image) {
    return partial ? "image loading" : "image";
  }

  const text = getTextContent(result);
  if (!text) {
    return partial ? "waiting for output" : "ready";
  }

  const lineSummary = summarizeTextLineCount(text);
  return partial ? `${lineSummary} so far` : lineSummary;
}

function readPathArg(args: { path?: unknown; file_path?: unknown }): string {
  const value = args.file_path ?? args.path;
  return typeof value === "string" ? value : "";
}

export function createReadToolOverrideDefinition() {
  return {
    ...readToolDefinition,
    renderShell: "self" as const,
    renderCall: renderReadToolCall,
    renderResult: renderReadToolResult,
  };
}
