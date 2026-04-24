import { type BashToolDetails, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";
import { bashToolDefinition, readToolDefinition } from "./builtins.js";
import {
  formatBashResultSummary,
  formatBashTimeoutSuffix,
  formatCollapsedBashResultSummary,
  formatElapsedFooter,
  formatElapsedSuffix,
  formatPartialBashFooter,
  getBashElapsed,
  isBashRenderPartial,
  summarizeBashOutput,
  syncBashRenderState,
} from "./tools-bash.js";
import { getBashCallMetadata, type BashCallMetadata } from "./tools-bash-metadata.js";
import { getTextContent, styleToolOutput } from "./tools-output.js";
import { createTextComponent, renderStreamingPreview } from "./tools-render.js";
import { formatBashStatus } from "./tools-status.js";

const BASH_OUTPUT_LINE_LIMIT = 80;

type ToolTheme = Parameters<NonNullable<typeof readToolDefinition.renderCall>>[1];
type BaseRenderContext = {
  cwd: string;
  isPartial: boolean;
  isError: boolean;
  lastComponent: unknown;
};

export const bashToolParams = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
  ),
  description: Type.String({
    description:
      "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
  }),
});

type BashCallArgs = Static<typeof bashToolParams>;
type BashCallContext = Parameters<NonNullable<typeof bashToolDefinition.renderCall>>[2];
type BashResult = Parameters<NonNullable<typeof bashToolDefinition.renderResult>>[0];
type BashResultOptions = Parameters<NonNullable<typeof bashToolDefinition.renderResult>>[1];
type BashResultContext = Parameters<NonNullable<typeof bashToolDefinition.renderResult>>[3];

type BashRenderState = NonNullable<BashCallContext["state"]> & {
  completed?: boolean;
  callComponent?: Text;
  callText?: string;
};

function renderBashToolCall(args: BashCallArgs, theme: ToolTheme, context: BashCallContext) {
  const state = syncBashRenderState({
    state: context.state as BashRenderState,
    executionStarted: context.executionStarted,
    invalidate: context.invalidate,
    isPartial: context.isPartial,
  });
  const isPartial = isBashRenderPartial(state, context.isPartial);
  const renderContext = isPartial === context.isPartial ? context : { ...context, isPartial };
  const metadata = getBashCallMetadata(args, getBashElapsed(state));

  if (renderContext.expanded && metadata.command) {
    return setBashCallComponent(
      state,
      renderContext.lastComponent,
      renderExpandedBashCall(
        metadata.command,
        theme,
        renderContext,
        formatBashCallSuffix(theme, renderContext, metadata),
      ),
    );
  }

  return setBashCallComponent(
    state,
    renderContext.lastComponent,
    `${formatBashStatus(theme, renderContext)} ${theme.fg("text", metadata.label)}${formatBashCallSuffix(theme, renderContext, metadata)}`,
  );
}

function renderBashToolResult(
  result: BashResult,
  options: BashResultOptions,
  theme: ToolTheme,
  context: BashResultContext,
) {
  const state = syncBashRenderState({
    state: context.state as BashRenderState,
    executionStarted: context.executionStarted,
    invalidate: context.invalidate,
    isPartial: options.isPartial,
  });
  const isPartial = isBashRenderPartial(state, options.isPartial);
  const elapsedMs = getBashElapsed(state);
  if (isPartial) {
    return renderPartialBashResult(result, options, theme, context, elapsedMs);
  }

  const output = getTextContent(result);
  if (context.isError) {
    if (options.expanded) {
      return renderExpandedBashResult(
        output,
        theme,
        context,
        summarizeBashFooter(result, theme, context.isError),
      );
    }
    applyCollapsedBashSummaryToCall(
      state,
      summarizeBashResult(result, theme, context.isError, elapsedMs),
    );
    return createTextComponent(context.lastComponent, "");
  }

  if (options.expanded) {
    return renderExpandedBashResult(output, theme, context, formatElapsedFooter(elapsedMs));
  }

  applyCollapsedBashSummaryToCall(
    state,
    summarizeBashResult(result, theme, context.isError, elapsedMs),
  );
  return createTextComponent(context.lastComponent, "");
}

export function createBashToolOverrideDefinition(): ToolDefinition<
  typeof bashToolParams,
  BashToolDetails | undefined,
  BashRenderState
> {
  const { prepareArguments: _prepareArguments, ...rest } = bashToolDefinition;
  return {
    ...rest,
    renderShell: "self",
    parameters: bashToolParams,
    renderCall: renderBashToolCall,
    renderResult: renderBashToolResult,
  };
}

function summarizeBashResult(
  result: { content: Array<{ type: string; text?: string }> },
  theme: ToolTheme,
  isError?: boolean,
  elapsedMs?: number,
): string {
  const output = getTextContent(result);
  const summary = summarizeBashOutput(output, (visibleText) =>
    styleToolOutput(visibleText, theme, BASH_OUTPUT_LINE_LIMIT),
  );
  return formatCollapsedBashResultSummary(
    theme,
    summary.lineCount,
    summary.exitCode,
    isError,
    elapsedMs,
  );
}

function summarizeBashFooter(
  result: { content: Array<{ type: string; text?: string }> },
  theme: ToolTheme,
  isError?: boolean,
): string {
  const summary = summarizeBashOutput(getTextContent(result), (visibleText) =>
    styleToolOutput(visibleText, theme, BASH_OUTPUT_LINE_LIMIT),
  );
  return formatBashResultSummary(theme, summary.lineCount, summary.exitCode, isError, true);
}

function applyCollapsedBashSummaryToCall(state: BashRenderState, summary: string): void {
  if (
    !(state.callComponent instanceof Text) ||
    summary.length === 0 ||
    state.callText === undefined ||
    state.callText.length === 0
  ) {
    return;
  }

  state.callComponent.setText(`${state.callText}${summary}`);
}

function renderExpandedBashCall(
  command: string,
  theme: ToolTheme,
  context: BaseRenderContext,
  suffix: string,
): string {
  const commandLines = command
    .split("\n")
    .map((line, index) => formatExpandedBashCommandLine(line, index === 0, theme, context))
    .join("\n");

  return `${commandLines}${suffix}`;
}

function formatExpandedBashCommandLine(
  line: string,
  isFirstLine: boolean,
  theme: ToolTheme,
  context: BaseRenderContext,
): string {
  if (!isFirstLine) {
    return theme.fg("toolOutput", line);
  }

  return `${formatBashStatus(theme, context)} ${theme.fg("toolOutput", line)}`;
}

function formatBashCallSuffix(
  theme: ToolTheme,
  context: Pick<BashCallContext, "isPartial" | "expanded">,
  metadata: BashCallMetadata,
): string {
  if (context.isPartial) {
    return formatBashTimeoutSuffix(theme, metadata.timeout);
  }

  if (!context.expanded) {
    return "";
  }

  return formatElapsedSuffix(theme, metadata.elapsed);
}

function setBashCallComponent(state: BashRenderState, lastComponent: unknown, text: string): Text {
  const existingComponent = state.callComponent instanceof Text ? state.callComponent : undefined;
  const component = createTextComponent(existingComponent ?? lastComponent, text);
  state.callComponent = component;
  state.callText = text;
  return component;
}

function renderPartialBashResult(
  result: BashResult,
  options: BashResultOptions,
  theme: ToolTheme,
  context: BashResultContext,
  elapsedMs?: number,
): Text {
  const output = getTextContent(result);
  const summary = summarizeBashOutput(output, (visibleText) =>
    styleToolOutput(visibleText, theme, BASH_OUTPUT_LINE_LIMIT),
  );
  return renderStreamingPreview(summary.renderedText, theme, context.lastComponent, {
    expanded: options.expanded,
    footer: formatPartialBashFooter(summary.lineCount, elapsedMs),
  });
}

function renderExpandedBashResult(
  output: string,
  theme: ToolTheme,
  context: BashResultContext,
  footer?: string,
): Text {
  const summary = summarizeBashOutput(output, (visibleText) =>
    styleToolOutput(visibleText, theme, BASH_OUTPUT_LINE_LIMIT),
  );
  const renderedText =
    summary.renderedText || styleToolOutput(output, theme, BASH_OUTPUT_LINE_LIMIT);

  return renderStreamingPreview(renderedText, theme, context.lastComponent, {
    expanded: true,
    footer,
  });
}
