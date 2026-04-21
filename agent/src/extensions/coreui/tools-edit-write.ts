import {
  type AgentToolResult,
  type ToolRenderResultOptions,
  editToolDefinition,
  readToolDefinition,
  renderDiff,
  writeToolDefinition,
} from "@mariozechner/pi-coding-agent";
import {
  formatDiffStats,
  formatOptionalDiffStats,
  getDiffStats,
  getDiffText,
  summarizeEditProgress,
  type DiffStats,
} from "./tools-edit.js";
import {
  formatLineCountSuffix,
  formatMutedDirSuffix,
  getToolPathDisplay,
  readContentArg,
  readPathArg,
  renderStatusPathToolCall,
} from "./tools-path-render.js";
import {
  countTextLines,
  getTextContent,
  styleToolOutput,
  summarizeLineCount,
} from "./tools-output.js";
import { createTextComponent, renderStreamingPreview, renderToolError } from "./tools-render.js";

type ToolTheme = Parameters<NonNullable<typeof readToolDefinition.renderCall>>[1];
type BaseRenderContext = {
  cwd: string;
  isPartial: boolean;
  isError: boolean;
  lastComponent: unknown;
};
type EditCallArgs = Parameters<NonNullable<typeof editToolDefinition.renderCall>>[0];
type EditCallContext = Parameters<NonNullable<typeof editToolDefinition.renderCall>>[2];
type EditResult = Parameters<NonNullable<typeof editToolDefinition.renderResult>>[0];
type EditResultOptions = Parameters<NonNullable<typeof editToolDefinition.renderResult>>[1];
type EditResultContext = Parameters<NonNullable<typeof editToolDefinition.renderResult>>[3];
type WriteCallArgs = Parameters<NonNullable<typeof writeToolDefinition.renderCall>>[0];
type WriteCallContext = Parameters<NonNullable<typeof writeToolDefinition.renderCall>>[2];

export function createEditToolOverrideDefinition() {
  return {
    ...editToolDefinition,
    renderShell: "self" as const,
    renderCall(args: EditCallArgs, theme: ToolTheme, context: EditCallContext) {
      return renderStatusPathToolCall(
        { pending: "editing", success: "edited", error: "edit" },
        readPathArg(args),
        theme,
        context,
      );
    },
    renderResult: renderEditToolResult,
  };
}

function renderEditToolResult(
  result: EditResult,
  options: EditResultOptions,
  theme: ToolTheme,
  context: EditResultContext,
) {
  const textContent = getTextContent(result);
  if (context.isError) {
    if (options.expanded) {
      return renderToolError(textContent || "failed to edit", theme, context.lastComponent);
    }
    return createTextComponent(context.lastComponent, "");
  }
  if (options.isPartial) {
    return renderEditPartialResult(result, options, theme, context);
  }
  if (!options.expanded) {
    return renderCollapsedEditResult(result, theme, context);
  }

  return renderExpandedEditResult(result, options, theme, context);
}

function renderEditPartialResult(
  result: EditResult,
  options: EditResultOptions,
  theme: ToolTheme,
  context: EditResultContext,
) {
  const diff = getDiffText(result.details);
  const stats = getDiffStats(diff);
  return renderStreamingPreview(
    renderEditStreamingContent(diff, getTextContent(result), theme, readPathArg(context.args)),
    theme,
    context.lastComponent,
    {
      expanded: options.expanded,
      footer: formatEditStreamingFooter(theme, stats, context.args),
    },
  );
}

function renderCollapsedEditResult(
  result: EditResult,
  theme: ToolTheme,
  context: EditResultContext,
) {
  const diff = getDiffText(result.details);
  const stats = getDiffStats(diff);
  return createTextComponent(
    context.lastComponent,
    formatCollapsedEditSummary(theme, context, readPathArg(context.args), stats),
  );
}

function renderExpandedEditResult(
  result: EditResult,
  options: EditResultOptions,
  theme: ToolTheme,
  context: EditResultContext,
) {
  const diff = getDiffText(result.details);
  if (diff) {
    return createTextComponent(
      context.lastComponent,
      `\n${renderDiff(diff, { filePath: readPathArg(context.args) || undefined })}`,
    );
  }

  if (editToolDefinition.renderResult) {
    return editToolDefinition.renderResult(result, options, theme, {
      ...context,
      lastComponent: createTextComponent(context.lastComponent, ""),
    });
  }

  return createTextComponent(context.lastComponent, "");
}

export function createWriteToolOverrideDefinition() {
  return {
    ...writeToolDefinition,
    renderShell: "self" as const,
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

function renderEditStreamingContent(
  diff: string,
  output: string,
  theme: ToolTheme,
  filePath: string,
): string {
  if (diff) {
    return renderDiff(diff, { filePath: filePath || undefined });
  }

  return styleToolOutput(output, theme);
}

function formatEditStreamingFooter(
  theme: ToolTheme,
  stats: DiffStats | undefined,
  args: { edits?: unknown },
): string {
  if (!stats) {
    return summarizeEditProgress(args);
  }

  return formatDiffStats(theme, stats.additions, stats.deletions);
}

function formatCollapsedEditSummary(
  theme: ToolTheme,
  context: BaseRenderContext,
  rawPath: string,
  stats: DiffStats | undefined,
): string {
  const pathDisplay = getToolPathDisplay(rawPath, context.cwd);
  const status = theme.bold(theme.fg("dim", "edited"));
  const summary = formatOptionalDiffStats(theme, stats);

  return `${status} ${theme.fg("text", pathDisplay.basename)}${formatMutedDirSuffix(theme, pathDisplay.dirSuffix)}${summary}`;
}
