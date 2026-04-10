import {
  type AgentToolResult,
  type ToolRenderResultOptions,
  bashToolDefinition,
  editToolDefinition,
  renderDiff,
  readToolDefinition,
  writeToolDefinition,
  type ExtensionAPI,
  BashToolDetails,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import path from "node:path";
import { shortenPathForTool } from "./path.js";
import { Type } from "@sinclair/typebox";
import { Static } from "@sinclair/typebox";

type ToolPathArgs = {
  path?: unknown;
  file_path?: unknown;
  offset?: unknown;
  limit?: unknown;
  command?: unknown;
  timeout?: unknown;
  content?: unknown;
  edits?: unknown;
};

type ToolPhase = "pending" | "success" | "error";

type ToolVerbs = {
  pending: string;
  success: string;
  error: string;
};

type ToolTheme = Parameters<NonNullable<typeof readToolDefinition.renderCall>>[1];
type BaseRenderContext = {
  cwd: string;
  isPartial: boolean;
  isError: boolean;
  lastComponent: unknown;
};
type ReadCallArgs = Parameters<NonNullable<typeof readToolDefinition.renderCall>>[0];
type ReadCallContext = Parameters<NonNullable<typeof readToolDefinition.renderCall>>[2];
type ReadResult = Parameters<NonNullable<typeof readToolDefinition.renderResult>>[0];
type ReadResultContext = Parameters<NonNullable<typeof readToolDefinition.renderResult>>[3];
type BashCallArgs = Static<typeof bashToolParams>;
type BashCallContext = Parameters<NonNullable<typeof bashToolDefinition.renderCall>>[2];
type BashResult = Parameters<NonNullable<typeof bashToolDefinition.renderResult>>[0];
type BashResultOptions = Parameters<NonNullable<typeof bashToolDefinition.renderResult>>[1];
type BashResultContext = Parameters<NonNullable<typeof bashToolDefinition.renderResult>>[3];
type EditCallArgs = Parameters<NonNullable<typeof editToolDefinition.renderCall>>[0];
type EditCallContext = Parameters<NonNullable<typeof editToolDefinition.renderCall>>[2];
type EditResult = Parameters<NonNullable<typeof editToolDefinition.renderResult>>[0];
type EditResultOptions = Parameters<NonNullable<typeof editToolDefinition.renderResult>>[1];
type EditResultContext = Parameters<NonNullable<typeof editToolDefinition.renderResult>>[3];
type WriteCallArgs = Parameters<NonNullable<typeof writeToolDefinition.renderCall>>[0];
type WriteCallContext = Parameters<NonNullable<typeof writeToolDefinition.renderCall>>[2];
type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
};

type BashRenderState = NonNullable<BashCallContext['state']>;

const BASH_OUTPUT_LINE_LIMIT = 80;
const TOOL_TEXT_PADDING_X = 0;
const TOOL_TEXT_PADDING_Y = 0;

export function registerCoreUIToolOverrides(pi: ExtensionAPI): (activeToolNames: string[]) => void {
  const registeredToolNames = new Set<string>();

  return (activeToolNames: string[]) => {
    const activeTools = new Set(activeToolNames);

    if (activeTools.has(readToolDefinition.name) && !registeredToolNames.has(readToolDefinition.name)) {
      registerReadToolOverride(pi);
      registeredToolNames.add(readToolDefinition.name);
    }

    if (activeTools.has(bashToolDefinition.name) && !registeredToolNames.has(bashToolDefinition.name)) {
      registerBashToolOverride(pi);
      registeredToolNames.add(bashToolDefinition.name);
    }

    if (activeTools.has(editToolDefinition.name) && !registeredToolNames.has(editToolDefinition.name)) {
      registerEditToolOverride(pi);
      registeredToolNames.add(editToolDefinition.name);
    }

    if (activeTools.has(writeToolDefinition.name) && !registeredToolNames.has(writeToolDefinition.name)) {
      registerWriteToolOverride(pi);
      registeredToolNames.add(writeToolDefinition.name);
    }
  };
}

function registerBashToolOverride(pi: ExtensionAPI): void {
  pi.registerTool(createBashToolOverrideDefinition());
}

function registerReadToolOverride(pi: ExtensionAPI): void {
  pi.registerTool(createReadToolOverrideDefinition());
}

function registerEditToolOverride(pi: ExtensionAPI): void {
  pi.registerTool(createEditToolOverrideDefinition());
}

function registerWriteToolOverride(pi: ExtensionAPI): void {
  pi.registerTool(createWriteToolOverrideDefinition());
}

export function createReadToolOverrideDefinition() {
  return {
    ...readToolDefinition,
    renderCall(args: ReadCallArgs, theme: ToolTheme, context: ReadCallContext) {
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
    },
    renderResult(result: ReadResult, options: ToolRenderResultOptions, theme: ToolTheme, context: ReadResultContext) {
      const textContent = getTextContent(result);

      if (context.isError) {
        if (options.expanded) {
          return renderToolError(textContent || "failed to read", theme, context.lastComponent);
        }
        return createTextComponent(context.lastComponent, "");
      }

      if (options.isPartial) {
        return createTextComponent(context.lastComponent, theme.fg("dim", summarizeReadResult(result, true)));
      }

      if (!options.expanded) {
        return createTextComponent(context.lastComponent, "");
      }

      if (!textContent) {
        return createTextComponent(context.lastComponent, "");
      }

      return delegateReadResult(result, options, theme, context, textContent);
    },
  };
}

export const bashToolParams = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
  description: Type.String({
    description: "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
  })
});

export function createBashToolOverrideDefinition(): ToolDefinition<typeof bashToolParams, BashToolDetails | undefined, BashRenderState> {
  const { prepareArguments: _prepareArguments, ...rest } = bashToolDefinition;
  return {
    ...rest,
    parameters: bashToolParams,
    renderCall(args: BashCallArgs, theme: ToolTheme, context: BashCallContext) {
      const state = syncBashRenderState(context, context.isPartial);
      const description = typeof args.description === "string" ? args.description.trim() : "";
      const command = typeof args.command === "string" ? args.command.trim() : "";
      const timeout = typeof args.timeout === "number" ? args.timeout : undefined;
      const elapsed = getBashElapsed(state);
      const suffix = context.isPartial
        ? timeout !== undefined
          ? theme.fg("muted", ` (${formatDurationHuman(timeout * 1000)})`)
          : ""
        : elapsed !== undefined
          ? theme.fg("muted", ` ${formatDurationHuman(elapsed)}`)
          : "";
      if (context.expanded && command) {
        const commandLines = command.split("\n").map((line, i) =>
          i === 0
            ? `${formatBashStatus(theme, context)} ${theme.fg("toolOutput", line)}`
            : theme.fg("toolOutput", line)
        ).join("\n");
        return createTextComponent(context.lastComponent, `${commandLines}${suffix}`);
      }
      const label = description || command || "...";
      const text = `${formatBashStatus(theme, context)} ${theme.fg("text", label)}${suffix}`;
      return createTextComponent(context.lastComponent, text);
    },
    renderResult(result: BashResult, options: BashResultOptions, theme: ToolTheme, context: BashResultContext) {
      const state = syncBashRenderState(context, options.isPartial);
      const elapsedMs = getBashElapsed(state);
      if (options.isPartial) {
        const output = getTextContent(result);
        const bashOutput = summarizeBashOutput(output, theme);
        return renderStreamingPreview(
          bashOutput.renderedText,
          theme,
          context.lastComponent,
          {
            expanded: options.expanded,
            footer: `${summarizeLineCount(bashOutput.lineCount)} so far${elapsedMs !== undefined ? ` (${formatDurationHuman(elapsedMs)})` : ""}`,
          },
        );
      }

      const summary = summarizeBashResult(result, false, theme, elapsedMs, context.isError);
      const output = getTextContent(result);

      if (context.isError) {
        if (options.expanded) {
          const bashOutput = summarizeBashOutput(output, theme);
          return renderStreamingPreview(
            bashOutput.renderedText || styleToolOutput(output, theme, BASH_OUTPUT_LINE_LIMIT),
            theme,
            context.lastComponent,
            {
              expanded: true,
              footer: summarizeBashFooter(result, theme, context.isError),
            },
          );
        }
        return createTextComponent(context.lastComponent, summary);
      }

      if (options.expanded) {
        const bashOutput = summarizeBashOutput(output, theme);
        return renderStreamingPreview(
          bashOutput.renderedText || styleToolOutput(output, theme, BASH_OUTPUT_LINE_LIMIT),
          theme,
          context.lastComponent,
          {
            expanded: true,
            footer: elapsedMs !== undefined ? `Took ${formatDurationHuman(elapsedMs)}` : undefined,
          },
        );
      }

      if (!summary) {
        return createTextComponent(context.lastComponent, "");
      }

      return createTextComponent(context.lastComponent, summary);
    },
  };
}

export function createEditToolOverrideDefinition() {
  return {
    ...editToolDefinition,
    renderCall(args: EditCallArgs, theme: ToolTheme, context: EditCallContext) {
      return renderStatusPathToolCall(
        { pending: "editing", success: "edited", error: "edit" },
        readPathArg(args),
        theme,
        context,
      );
    },
    renderResult(result: EditResult, options: EditResultOptions, theme: ToolTheme, context: EditResultContext) {
      const textContent = getTextContent(result);

      if (context.isError) {
        if (options.expanded) {
          return renderToolError(textContent || "failed to edit", theme, context.lastComponent);
        }
        return createTextComponent(context.lastComponent, "");
      }

      if (options.isPartial) {
        const diff = getDiffText(result.details);
        const stats = diff ? summarizeDiff(diff) : undefined;
        return renderStreamingPreview(
          diff ? renderDiff(diff, { filePath: readPathArg(context.args) || undefined }) : styleToolOutput(getTextContent(result), theme),
          theme,
          context.lastComponent,
          {
            expanded: options.expanded,
            footer: stats ? formatDiffStats(theme, stats.additions, stats.deletions) : summarizeEditProgress(context.args),
          },
        );
      }

      if (!options.expanded) {
        const diff = getDiffText(result.details);
        const stats = diff ? summarizeDiff(diff) : undefined;
        const filePath = shortenPathForTool(readPathArg(context.args), context.cwd) || "...";
        const basename = path.basename(filePath);
        const dirname = path.dirname(filePath);
        const dirSuffix = dirname === "." ? "./" : `${dirname}/`;
        const summary = stats && stats.changes > 0
          ? `${theme.fg("muted", " · ")}${formatDiffStats(theme, stats.additions, stats.deletions)}`
          : "";
        return createTextComponent(context.lastComponent, `${theme.bold(theme.fg("dim", "edited"))} ${theme.fg("text", basename)}${dirSuffix ? theme.fg("muted", ` ${dirSuffix}`) : ""}${summary}`);
      }

      const diff = getDiffText(result.details);
      if (diff) {
        return createTextComponent(context.lastComponent, `\n${renderDiff(diff, { filePath: readPathArg(context.args) || undefined })}`);
      }

      if (editToolDefinition.renderResult) {
        return editToolDefinition.renderResult(result, options, theme, {
          ...context,
          lastComponent: createTextComponent(context.lastComponent, ""),
        });
      }

      return createTextComponent(context.lastComponent, "");
    },
  };
}

export function createWriteToolOverrideDefinition() {
  return {
    ...writeToolDefinition,
    renderCall(args: WriteCallArgs, theme: ToolTheme, context: WriteCallContext) {
      return renderStatusPathToolCall(
        { pending: "writing", success: "written", error: "write" },
        readPathArg(args),
        theme,
        context,
        formatLineCountSuffix(args.content, theme),
      );
    },
    renderResult(
      result: AgentToolResult<undefined>,
      options: ToolRenderResultOptions,
      theme: ToolTheme,
      context: WriteCallContext,
    ) {
      const textContent = getTextContent(result);

      if (context.isError) {
        if (options.expanded) {
          return renderToolError(textContent || "failed to write", theme, context.lastComponent);
        }
        return createTextComponent(context.lastComponent, "");
      }

      if (options.isPartial) {
        const streamedText = getTextContent(result) || readContentArg(context.args);
        return renderStreamingPreview(
          styleToolOutput(streamedText, theme),
          theme,
          context.lastComponent,
          {
            expanded: options.expanded,
            footer: `${summarizeLineCount(countTextLines(streamedText))} so far`,
          },
        );
      }

      return createTextComponent(context.lastComponent, "");
    },
  };
}

function renderStatusPathToolCall(
  verbs: ToolVerbs,
  rawPath: string,
  theme: ToolTheme,
  context: BaseRenderContext,
  detail = "",
): Text {
  const filePath = shortenPathForTool(rawPath, context.cwd) || "...";
  const basename = path.basename(filePath);
  const dirname = path.dirname(filePath);
  const dirSuffix = dirname === "." ? "./" : `${dirname}/`;
  return renderStatusLine(verbs, basename, detail, theme, context, dirSuffix);
}

function renderStatusLine(
  verbs: ToolVerbs,
  subject: string,
  detail: string,
  theme: ToolTheme,
  context: BaseRenderContext,
  subjectDir = "",
): Text {
  const phase = getToolPhase(context);
  const status = formatToolStatus(theme, phase, verbs);
  const text = `${status} ${theme.fg("text", subject)}${subjectDir ? theme.fg("muted", ` ${subjectDir}`) : ""}${detail}`;

  return createTextComponent(context.lastComponent, text);
}

function delegateReadResult(
  result: Parameters<NonNullable<typeof readToolDefinition.renderResult>>[0],
  options: Parameters<NonNullable<typeof readToolDefinition.renderResult>>[1],
  theme: Parameters<NonNullable<typeof readToolDefinition.renderResult>>[2],
  context: Parameters<NonNullable<typeof readToolDefinition.renderResult>>[3],
  fallbackText: string,
) {
  if (readToolDefinition.renderResult) {
    return readToolDefinition.renderResult(result, options, theme, {
      ...context,
      lastComponent: createTextComponent(context.lastComponent, ""),
    });
  }

  return new Text(`\n${theme.fg("toolOutput", fallbackText)}`, TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y);
}

function createTextComponent(lastComponent: unknown, text: string): Text {
  const component = lastComponent instanceof Text
    ? lastComponent
    : new Text("", TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y);
  component.setText(text);
  return component;
}


function renderStreamingPreview(
  renderedText: string,
  theme: ToolTheme,
  lastComponent: unknown,
  options: {
    expanded: boolean;
    footer?: string;
    tailLines?: number;
  },
): Text {
  const lines = renderedText.split("\n").filter((line) => line.length > 0);
  const tailSize = options.tailLines ?? 5;

  if (options.expanded) {
    const footerLines = [options.footer ? `${theme.fg("dim", "↳ ")}${theme.fg("muted", options.footer)}` : ""]
      .filter(Boolean)
      .join("\n");
    const text = [renderedText, footerLines].filter(Boolean).join("\n");
    return createTextComponent(lastComponent, text);
  }

  const visibleLines = lines.slice(-tailSize);
  const earlierCount = Math.max(lines.length - visibleLines.length, 0);
  const blocks: string[] = [];

  if (earlierCount > 0) {
    blocks.push(`${theme.fg("dim", "↳ ")}${theme.fg("muted", `... (${earlierCount} earlier lines)`)}`);
  }

  if (visibleLines.length > 0) {
    blocks.push(visibleLines.join("\n"));
  }

  if (options.footer) {
    blocks.push(`${theme.fg("dim", "↳ ")}${theme.fg("muted", options.footer)}`);
  }

  return createTextComponent(lastComponent, blocks.join("\n"));
}

function renderToolError(message: string, theme: ToolTheme, lastComponent: unknown): Text {
  return createTextComponent(lastComponent, message ? theme.fg("error", `↳ ${message.trim()}`) : "");
}



function getToolPhase(context: Pick<BaseRenderContext, "isPartial" | "isError">): ToolPhase {
  if (context.isError) {
    return "error";
  }

  if (context.isPartial) {
    return "pending";
  }

  return "success";
}

function formatToolStatus(theme: ToolTheme, phase: ToolPhase, verbs: ToolVerbs): string {
  if (phase === "error") {
    return theme.bold(theme.fg("error", verbs.error));
  }

  if (phase === "success") {
    return theme.bold(theme.fg("dim", verbs.success));
  }

  return theme.bold(theme.fg("dim", verbs.pending));
}

function formatBashStatus(theme: ToolTheme, context: BaseRenderContext): string {
  if (context.isError) {
    return theme.bold(theme.fg("error", "$"));
  }

  if (!context.isPartial) {
    return theme.bold(theme.fg("dim", "$"));
  }

  return theme.bold(theme.fg("dim", "$"));
}

function getTextContent(result: ToolResult): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function summarizeReadResult(result: ToolResult, partial: boolean): string {
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

function summarizeBashResult(result: ToolResult, partial: boolean, theme: ToolTheme, elapsedMs?: number, isError?: boolean): string {
  const output = getTextContent(result);
  const { lineCount, exitCode } = summarizeBashOutput(output, theme);

  if (partial) {
    return `${theme.fg("muted", `${summarizeLineCount(lineCount)} so far`)}${elapsedMs !== undefined ? theme.fg("muted", ` (${formatDurationHuman(elapsedMs)})`) : ""}`;
  }

  const isOk = !isError && (exitCode === undefined || exitCode === "0");
  const exitStatus = isOk
    ? theme.fg("toolDiffAdded", "ok")
    : theme.fg("error", `exit ${exitCode ?? "1"}`);
  return `${theme.fg("muted", summarizeLineCount(lineCount))}${theme.fg("muted", " · ")}${exitStatus}`;
}

function summarizeBashFooter(result: ToolResult, theme: ToolTheme, isError?: boolean): string {
  const { lineCount, exitCode } = summarizeBashOutput(getTextContent(result), theme);
  const isOk = !isError && (exitCode === undefined || exitCode === "0");
  const exitStatus = isOk
    ? theme.fg("toolDiffAdded", "ok")
    : theme.fg("error", `exit ${exitCode ?? "1"}`);
  return `${theme.fg("muted", summarizeLineCount(lineCount))}${theme.fg("muted", " · ")}${exitStatus}`;
}

function summarizeBashOutput(output: string, theme: ToolTheme): { lineCount: number; exitCode?: string; renderedText: string } {
  if (!output) {
    return { lineCount: 0, renderedText: "" };
  }

  const lines = output.split("\n");
  const exitLine = [...lines].reverse().find((line: string) => /^exit code:/i.test(line.trim()));
  const exitCode = exitLine?.match(/exit code:\s*(-?\d+)/i)?.[1];
  const bodyLines = lines.filter(
    (line) => line.trim().length > 0 && line !== exitLine && !line.trimStart().startsWith("> "),
  );
  const visibleLines = bodyLines.length > 0 ? bodyLines : lines.filter((line) => line.trim().length > 0 && line !== exitLine);
  return {
    lineCount: visibleLines.length,
    exitCode,
    renderedText: styleToolOutput(visibleLines.join("\n"), theme, BASH_OUTPUT_LINE_LIMIT),
  };
}

function summarizeEditProgress(args: ToolPathArgs): string {
  const editCount = Array.isArray(args.edits) ? args.edits.length : 0;
  if (editCount === 0) {
    return "waiting for diff";
  }

  return `${editCount} edit${editCount === 1 ? "" : "s"} queued`;
}

function getDiffText(details: unknown): string {
  if (!details || typeof details !== "object") {
    return "";
  }

  const diff = (details as { diff?: unknown }).diff;
  return typeof diff === "string" ? diff : "";
}

function summarizeDiff(diff: string): { additions: number; deletions: number; changes: number } {
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions++;
      continue;
    }
    if (line.startsWith("-")) {
      deletions++;
    }
  }

  return {
    additions,
    deletions,
    changes: additions + deletions,
  };
}

function readPathArg(args: ToolPathArgs): string {
  const value = args.file_path ?? args.path;
  return typeof value === "string" ? value : "";
}

function formatReadRangeSuffix(theme: ToolTheme, offset: unknown, limit: unknown): string {
  const startLine = typeof offset === "number" ? offset : undefined;
  const maxLines = typeof limit === "number" ? limit : undefined;

  if (startLine === undefined && maxLines === undefined) {
    return "";
  }

  const start = startLine ?? 1;
  const end = maxLines !== undefined ? start + maxLines - 1 : undefined;
  return theme.fg("muted", ` (${start}${end ? `-${end}` : ""})`);
}

function formatLineCountSuffix(content: unknown, theme: ToolTheme): string {
  const lineCount = countTextLines(content);
  if (lineCount === 0) {
    return "";
  }

  return theme.fg("muted", ` · ± ${summarizeLineCount(lineCount)}`);
}

function countTextLines(content: unknown): number {
  if (typeof content !== "string" || content.length === 0) {
    return 0;
  }

  return content.split("\n").length;
}

function readContentArg(args: ToolPathArgs): string {
  return typeof args.content === "string" ? args.content : "";
}

function summarizeTextLineCount(text: string): string {
  return summarizeLineCount(text.split("\n").filter((line) => line.length > 0 || text.includes("\n")).length || 1);
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
    .map((line) => styleToolOutputLine(line, theme, maxLineLength))
    .join("\n");
}

function styleToolOutputLine(line: string, theme: ToolTheme, maxLineLength?: number): string {
  if (maxLineLength === undefined || line.length <= maxLineLength) {
    return theme.fg("toolOutput", line);
  }

  const truncatedChars = line.length - maxLineLength;
  const visibleText = line.slice(0, maxLineLength);
  return `${theme.fg("toolOutput", visibleText)}${theme.fg("muted", ` …(truncated ${truncatedChars} chars)…`)}`;
}

function syncBashRenderState(
  context: Pick<BashCallContext, "state" | "executionStarted" | "invalidate">,
  isPartial: boolean,
): BashRenderState {
  const state = context.state as BashRenderState;

  if (context.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }

  if (state.startedAt !== undefined && isPartial && !state.interval) {
    state.interval = setInterval(() => context.invalidate(), 1000);
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

function getBashElapsed(state: BashRenderState): number | undefined {
  if (state.startedAt === undefined) {
    return undefined;
  }

  return (state.endedAt ?? Date.now()) - state.startedAt;
}

function formatDurationHuman(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function formatDiffStats(theme: ToolTheme, additions: number, deletions: number): string {
  return `${theme.fg("toolDiffAdded", `+${additions}`)} ${theme.fg("toolDiffRemoved", `-${deletions}`)}`;
}
