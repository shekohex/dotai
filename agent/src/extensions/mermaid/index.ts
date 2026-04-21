import type { ExtensionAPI, MessageRenderer } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { theme as interactiveTheme } from "../../../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { truncateToWidth, type Component } from "@mariozechner/pi-tui";
import { installAssistantMessagePatch } from "./patch.js";
import { extractMermaidBlocks } from "./parsing.js";
import {
  collectRenderableDetails,
  getCachedAsciiLines,
  getLastAssistantText,
  selectAsciiVariant,
  COLLAPSED_LINES,
  MAX_BLOCKS,
  type MermaidDetails,
} from "./renderable.js";

const MESSAGE_TYPE = "pi-mermaid";

function renderMermaidBodyLines(
  width: number,
  details: MermaidDetails,
  theme: typeof interactiveTheme,
  options: {
    collapseLong: boolean;
    expanded: boolean;
    showSource: boolean;
    showLabel: boolean;
  },
): string[] {
  const contentWidth = Math.max(1, width);
  const selection = selectAsciiVariant(
    contentWidth,
    details.variants,
    details.ascii,
    details.lineCount,
  );
  const asciiLines = getCachedAsciiLines(selection.ascii);
  const hasOverflow = options.collapseLong && selection.lineCount > COLLAPSED_LINES;
  const isExpanded = options.expanded || !hasOverflow;
  const visibleLines = isExpanded ? asciiLines.lines : asciiLines.previewLines;
  const needsClip = selection.maxLineWidth > contentWidth;
  const clipAsciiLine = needsClip
    ? (line: string) => truncateToWidth(line, contentWidth, "")
    : (line: string) => line;

  const lines: string[] = [];
  if (options.showLabel) {
    const label = theme.fg("customMessageLabel", theme.bold("Mermaid"));
    lines.push(truncateToWidth(label, contentWidth));
  }
  for (const line of visibleLines) {
    lines.push(clipAsciiLine(line));
  }

  if (hasOverflow && !isExpanded) {
    const remainingLines = selection.lineCount - COLLAPSED_LINES;
    const hintText = `... (${remainingLines} more lines, ${keyHint("app.tools.expand", "to expand")})`;
    lines.push(truncateToWidth(theme.fg("muted", hintText), contentWidth));
  }
  if (selection.clipped) {
    const hintText = "... (clipped to fit width; widen terminal to view full diagram)";
    lines.push(truncateToWidth(theme.fg("muted", hintText), contentWidth));
  }

  return lines;
}

function createMermaidBodyComponent(
  details: MermaidDetails,
  theme: typeof interactiveTheme,
  options: {
    collapseLong: boolean;
    expanded: boolean;
    showSource: boolean;
    showLabel: boolean;
  },
): Component {
  return {
    render: (width) => renderMermaidBodyLines(width, details, theme, options),
    invalidate: () => {},
  };
}

function createInlineMermaidComponent(details: MermaidDetails): Component {
  return createMermaidBodyComponent(details, interactiveTheme, {
    collapseLong: false,
    expanded: true,
    showSource: false,
    showLabel: false,
  });
}

function createMermaidMessageRenderer(): MessageRenderer<MermaidDetails> {
  return (message, _state, theme) => {
    const details =
      message.details ??
      ({ source: "", index: 0, ascii: "", lineCount: 0 } satisfies MermaidDetails);
    return createMermaidBodyComponent(details, theme, {
      collapseLong: false,
      expanded: true,
      showSource: false,
      showLabel: false,
    });
  };
}

function registerMermaidCommand(pi: ExtensionAPI): void {
  pi.registerCommand("mermaid", {
    description: "Render mermaid in last assistant message as ASCII",
    handler: (_args, ctx) => {
      const lastAssistant = getLastAssistantText(ctx.sessionManager.getBranch());
      if (lastAssistant === null) {
        if (ctx.hasUI) ctx.ui.notify("No assistant message found", "warning");
        return Promise.resolve();
      }

      const blocks = extractMermaidBlocks(lastAssistant, MAX_BLOCKS + 1);
      if (blocks.length === 0) {
        if (ctx.hasUI) ctx.ui.notify("No mermaid blocks found", "warning");
        return Promise.resolve();
      }

      const notify = (message: string, type: "info" | "warning" | "error") => {
        if (ctx.hasUI) ctx.ui.notify(message, type);
      };

      const details = collectRenderableDetails(blocks, notify);
      for (const item of details) {
        pi.sendMessage({ customType: MESSAGE_TYPE, content: "", display: true, details: item });
      }

      return Promise.resolve();
    },
  });
}

export { extractMermaidBlocks };
export { buildInlineRenderableSegments } from "./renderable.js";

export default function (pi: ExtensionAPI) {
  installAssistantMessagePatch(createInlineMermaidComponent);
  pi.registerMessageRenderer(MESSAGE_TYPE, createMermaidMessageRenderer());
  registerMermaidCommand(pi);
}
