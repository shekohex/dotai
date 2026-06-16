import { type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";
import { bashToolDefinition, readToolDefinition } from "./builtins.js";
import type { BackgroundBashToolDetails } from "./tmux-background-types.js";
import {
  parseBackgroundCommand,
  runBackgroundCommandInTmux,
  warmTmuxAvailabilityCache,
} from "./tmux-background.js";
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
      "Clear, concise active-voice description of what this command does. For simple commands, use 5-10 words. Do not describe risk; describe the action. For piped commands or obscure flags, add enough context to clarify the operation. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: find . -name '*.tmp' -delete\nOutput: Finds and deletes temporary files\n\nInput: curl -s url | jq '.data[]'\nOutput: Fetches JSON and extracts data array elements",
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

export function createBashToolOverrideDefinition(
  pi: ExtensionAPI,
): ToolDefinition<typeof bashToolParams, BackgroundBashToolDetails | undefined, BashRenderState> {
  const { prepareArguments: _prepareArguments, ...rest } = bashToolDefinition;
  warmTmuxAvailabilityCache();
  return {
    ...rest,
    description: `${rest.description} Commands ending with '&' run in background using tmux and return immediately. Add '# poll:5000' after '&' to receive periodic updates every 5000ms.`,
    promptSnippet:
      "Execute bash commands. Prefer dedicated tools for file search/read. Use trailing '&' for tmux-backed background commands.",
    promptGuidelines: [
      "Prefer dedicated tools over bash when they fit: use `find` for path searches, `grep` for content searches, and `read` for reading files.",
      "Use bash for shell-native tasks, git inspection, package scripts, build/test commands, and commands that dedicated tools cannot express.",
      "Avoid destructive commands (`rm`, `git reset --hard`, `git clean`, `git checkout --`, force-push, truncating redirects) unless explicitly requested and scoped.",
      "Never skip git hooks with `--no-verify` or bypass signing unless the user explicitly asks; fix hook failures instead.",
      "Keep the current working directory stable; prefer repo-relative paths or absolute paths over unnecessary `cd` chains.",
      "For long-running commands, servers, watchers, REPLs, and interactive prompts, end the command with `&` to run it in a background tmux window and return immediately.",
      "To receive periodic background updates, append `# poll:<milliseconds>` after the trailing `&`, e.g. `npm run dev & # poll:5000`.",
      "Background commands report automatically when they finish. Never use `sleep` plus tmux/read loops to wait for completion.",
      "Only inspect background output manually when you need interim output before the automatic completion notification.",
      "The bash result includes tmux inspect/kill hints. Use normal tmux commands in later bash calls to peek or stop background work.",
      "Use `nohup ... &` only when you want shell-level nohup behavior too; the trailing `&` is what makes bash run it in background.",
    ],
    renderShell: "self",
    parameters: bashToolParams,
    execute(toolCallId, params, signal, onUpdate, ctx) {
      const backgroundCommand = parseBackgroundCommand(params.command);
      if (backgroundCommand) {
        return runBackgroundCommandInTmux({
          command: backgroundCommand,
          ctx,
          description: params.description,
          pi,
        });
      }

      return rest.execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall: renderBashToolCall,
    renderResult: renderBashToolResult,
  };
}

function summarizeBashResult(
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: BackgroundBashToolDetails;
  },
  theme: ToolTheme,
  isError?: boolean,
  elapsedMs?: number,
): string {
  if (result.details?.background === true) {
    return `${theme.fg("dim", " · ")}${theme.italic(theme.fg("muted", "background"))}`;
  }

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
