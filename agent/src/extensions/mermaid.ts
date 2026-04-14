import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, MessageRenderer, SessionEntry } from "@mariozechner/pi-coding-agent";
import { AssistantMessageComponent, keyHint } from "@mariozechner/pi-coding-agent";
import { theme as interactiveTheme } from "../../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {
  Container,
  Markdown,
  Spacer,
  Text,
  type Component,
  type MarkdownTheme,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import { createHash } from "node:crypto";
import { renderMermaidASCII } from "beautiful-mermaid";

const MESSAGE_TYPE = "pi-mermaid";
const COLLAPSED_LINES = 10;
const MAX_BLOCKS = 5;
const MAX_SOURCE_LINES = 400;
const MAX_SOURCE_CHARS = 20000;
const MAX_ASCII_CACHE = 200;
const ASCII_PRESETS: Array<{ key: string; paddingX: number; boxBorderPadding: number }> = [
  { key: "default", paddingX: 5, boxBorderPadding: 1 },
  { key: "compact", paddingX: 3, boxBorderPadding: 1 },
  { key: "tight", paddingX: 2, boxBorderPadding: 1 },
  { key: "squeezed", paddingX: 1, boxBorderPadding: 0 },
];

type AsciiPreset = (typeof ASCII_PRESETS)[number];

const SUPPORTED_TYPES = new Map<string, string>([
  ["graph", "flowchart"],
  ["flowchart", "flowchart"],
  ["sequenceDiagram", "sequence"],
  ["classDiagram", "class"],
  ["erDiagram", "er"],
  ["stateDiagram", "state"],
  ["stateDiagram-v2", "state"],
]);

const SUPPORTED_TYPE_LABEL =
  "graph/flowchart, sequenceDiagram, classDiagram, erDiagram, stateDiagram(-v2)";

const asciiCache = new Map<string, AsciiVariant>();
const asciiLinesCache = new Map<string, { lines: string[]; previewLines: string[] }>();

interface AsciiVariant {
  presetKey: string;
  ascii: string;
  lineCount: number;
  maxLineWidth: number;
}

interface MermaidDetails {
  source: string;
  index: number;
  ascii: string;
  lineCount: number;
  variants?: AsciiVariant[];
}

interface MermaidFenceBlock {
  block: string;
  startOffset: number;
  endOffset: number;
}

type RenderableSegment =
  | { type: "markdown"; text: string }
  | { type: "diagram"; details: MermaidDetails };

type MermaidRenderOptions = {
  collapseLong: boolean;
  expanded: boolean;
  showSource: boolean;
  showLabel: boolean;
};

type AssistantMessagePatchInstance = {
  contentContainer: Container;
  hideThinkingBlock: boolean;
  markdownTheme: MarkdownTheme;
  hiddenThinkingLabel: string;
  lastMessage?: AssistantMessage;
};

let assistantPatchInstalled = false;

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (part && part.type === "text" ? part.text : ""))
      .filter((part: string) => part.trim().length > 0)
      .join("\n");
  }
  return "";
}

function parseTopLevelMermaidFences(text: string, maxBlocks = Infinity): MermaidFenceBlock[] {
  const blocks: MermaidFenceBlock[] = [];
  const lines = text.split(/(?<=\n)/);
  let offset = 0;
  let activeFence:
    | {
        char: "`" | "~";
        length: number;
        info: string;
        fenceStartOffset: number;
        bodyStartOffset: number;
        bodyLines: string[];
        isMermaid: boolean;
        nestedFences: Array<{ char: "`" | "~"; length: number }>;
      }
    | undefined;

  for (const line of lines) {
    const trimmedLine = line.replace(/[\r\n]+$/g, "");

    if (!activeFence) {
      const openMatch = trimmedLine.match(/^ {0,3}([`~]{3,})(.*)$/);
      if (openMatch) {
        const marker = openMatch[1] ?? "";
        const info = (openMatch[2] ?? "").trim();
        const char = marker[0] as "`" | "~";
        const infoToken = info.split(/\s+/)[0] ?? "";
        activeFence = {
          char,
          length: marker.length,
          info,
          fenceStartOffset: offset,
          bodyStartOffset: offset + line.length,
          bodyLines: [],
          isMermaid: infoToken.toLowerCase() === "mermaid",
          nestedFences: [],
        };
        offset += line.length;
        continue;
      }

      offset += line.length;
      continue;
    }

    const nestedOpenMatch = trimmedLine.match(/^ {0,3}([`~]{3,})(.+)$/);
    if (!activeFence.isMermaid && nestedOpenMatch) {
      const marker = nestedOpenMatch[1] ?? "";
      activeFence.nestedFences.push({
        char: marker[0] as "`" | "~",
        length: marker.length,
      });
      activeFence.bodyLines.push(line);
      offset += line.length;
      continue;
    }

    const closeMatch = trimmedLine.match(/^ {0,3}([`~]{3,})\s*$/);
    if (closeMatch) {
      const marker = closeMatch[1] ?? "";
      const nestedFence = activeFence.nestedFences.at(-1);
      if (nestedFence) {
        if (marker[0] === nestedFence.char && marker.length >= nestedFence.length) {
          activeFence.nestedFences.pop();
        }
        activeFence.bodyLines.push(line);
        offset += line.length;
        continue;
      }

      if (marker[0] === activeFence.char && marker.length >= activeFence.length) {
        if (activeFence.isMermaid) {
          const block = activeFence.bodyLines
            .join("")
            .replace(/[\r\n]+$/g, "")
            .trim();
          if (block) {
            blocks.push({
              block,
              startOffset: activeFence.fenceStartOffset,
              endOffset: offset + line.length,
            });
            if (blocks.length >= maxBlocks) return blocks;
          }
        }
        activeFence = undefined;
        offset += line.length;
        continue;
      }
    }

    activeFence.bodyLines.push(line);
    offset += line.length;
  }

  return blocks;
}

export function extractMermaidBlocks(text: string, maxBlocks = Infinity): string[] {
  return parseTopLevelMermaidFences(text, maxBlocks).map((entry) => entry.block);
}

function getMermaidTypeToken(block: string): string | null {
  const lines = block.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("%%")) continue;
    return trimmed.split(/\s+/)[0] ?? null;
  }
  return null;
}

function getSupportedMermaidType(block: string): {
  token: string | null;
  normalized: string | null;
} {
  const token = getMermaidTypeToken(block);
  if (!token) return { token, normalized: null };
  return { token, normalized: SUPPORTED_TYPES.get(token) ?? null };
}

function hashMermaid(block: string): string {
  return createHash("sha256").update(block).digest("hex").slice(0, 8);
}

function getAsciiCacheKey(diagramHash: string, presetKey: string): string {
  return `${diagramHash}:${presetKey}`;
}

function getCachedVariant(key: string): AsciiVariant | null {
  const cached = asciiCache.get(key);
  if (!cached) return null;
  asciiCache.delete(key);
  asciiCache.set(key, cached);
  return cached;
}

function setCachedVariant(key: string, variant: AsciiVariant): void {
  asciiCache.set(key, variant);
  if (asciiCache.size > MAX_ASCII_CACHE) {
    const oldest = asciiCache.keys().next().value as string | undefined;
    if (oldest) asciiCache.delete(oldest);
  }
}

function countAsciiLines(ascii: string): number {
  if (!ascii) return 0;
  return ascii.split(/\r?\n/).length;
}

function maxAsciiLineWidth(ascii: string): number {
  if (!ascii) return 0;
  return ascii.split(/\r?\n/).reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
}

function getCachedAsciiLines(ascii: string): { lines: string[]; previewLines: string[] } {
  if (!ascii) return { lines: [], previewLines: [] };
  const cached = asciiLinesCache.get(ascii);
  if (cached) {
    asciiLinesCache.delete(ascii);
    asciiLinesCache.set(ascii, cached);
    return cached;
  }

  const lines = ascii.split(/\r?\n/);
  const previewLines = lines.length > COLLAPSED_LINES ? lines.slice(0, COLLAPSED_LINES) : lines;
  const entry = { lines, previewLines };
  asciiLinesCache.set(ascii, entry);
  if (asciiLinesCache.size > MAX_ASCII_CACHE) {
    const oldest = asciiLinesCache.keys().next().value as string | undefined;
    if (oldest) asciiLinesCache.delete(oldest);
  }
  return entry;
}

function renderAsciiVariant(block: string, diagramHash: string, preset: AsciiPreset): AsciiVariant {
  const cacheKey = getAsciiCacheKey(diagramHash, preset.key);
  const cached = getCachedVariant(cacheKey);
  if (cached) return cached;

  const ascii = renderMermaidASCII(block, {
    paddingX: preset.paddingX,
    boxBorderPadding: preset.boxBorderPadding,
    colorMode: "none",
  }).trimEnd();
  const lineCount = countAsciiLines(ascii);
  const maxLineWidth = maxAsciiLineWidth(ascii);
  getCachedAsciiLines(ascii);
  const variant: AsciiVariant = { presetKey: preset.key, ascii, lineCount, maxLineWidth };
  setCachedVariant(cacheKey, variant);
  return variant;
}

function selectAsciiVariant(
  width: number,
  variants: AsciiVariant[] | undefined,
  fallbackAscii: string,
  fallbackLineCount: number,
): { ascii: string; lineCount: number; maxLineWidth: number; clipped: boolean } {
  const safeWidth = Math.max(1, width);
  if (variants && variants.length > 0) {
    for (const variant of variants) {
      if (variant.maxLineWidth <= safeWidth) {
        return { ...variant, clipped: false };
      }
    }
    const tightest = variants[variants.length - 1];
    return { ...tightest, clipped: tightest.maxLineWidth > safeWidth };
  }

  const maxLineWidth = maxAsciiLineWidth(fallbackAscii);
  const lineCount = fallbackLineCount || countAsciiLines(fallbackAscii);
  return { ascii: fallbackAscii, lineCount, maxLineWidth, clipped: maxLineWidth > safeWidth };
}

function buildMermaidDetails(block: string, index: number): MermaidDetails | null {
  const { normalized } = getSupportedMermaidType(block);
  if (!normalized) return null;

  const diagramHash = hashMermaid(block);
  const variants: AsciiVariant[] = [];
  for (const preset of ASCII_PRESETS) {
    try {
      variants.push(renderAsciiVariant(block, diagramHash, preset));
    } catch {
      continue;
    }
  }
  if (variants.length === 0) return null;

  return {
    source: block,
    index,
    ascii: variants[0].ascii,
    lineCount: variants[0].lineCount,
    variants,
  };
}

export function buildInlineRenderableSegments(text: string): RenderableSegment[] {
  const segments: RenderableSegment[] = [];
  let cursor = 0;
  let diagramIndex = 0;
  const fences = parseTopLevelMermaidFences(text);

  for (const fence of fences) {
    const start = fence.startOffset;
    const end = fence.endOffset;
    const block = fence.block;

    if (start > cursor) {
      segments.push({ type: "markdown", text: text.slice(cursor, start) });
    }

    if (!block) {
      segments.push({ type: "markdown", text: text.slice(start, end) });
    } else {
      const details = buildMermaidDetails(block, ++diagramIndex);
      if (details) {
        segments.push({ type: "diagram", details });
      } else {
        segments.push({ type: "markdown", text: text.slice(start, end) });
      }
    }

    cursor = end;
  }

  if (cursor < text.length) {
    segments.push({ type: "markdown", text: text.slice(cursor) });
  }

  return segments;
}

function hasRenderableMermaid(text: string): boolean {
  return buildInlineRenderableSegments(text).some((segment) => segment.type === "diagram");
}

function createMermaidBodyComponent(
  details: MermaidDetails,
  theme: typeof interactiveTheme,
  options: MermaidRenderOptions,
): Component {
  return {
    render: (width) => {
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
    },
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

function appendAssistantTextContent(
  container: Container,
  text: string,
  markdownTheme: MarkdownTheme,
): boolean {
  const segments = buildInlineRenderableSegments(text);
  const hasDiagrams = segments.some((segment) => segment.type === "diagram");
  if (!hasDiagrams) return false;

  let renderedAny = false;
  for (const segment of segments) {
    if (segment.type === "markdown") {
      const chunk = segment.text.trim();
      if (!chunk) continue;
      if (renderedAny) container.addChild(new Spacer(1));
      container.addChild(new Markdown(chunk, 1, 0, markdownTheme));
      renderedAny = true;
      continue;
    }

    if (renderedAny) container.addChild(new Spacer(1));
    container.addChild(createInlineMermaidComponent(segment.details));
    renderedAny = true;
  }

  return renderedAny;
}

function installAssistantMessagePatch(): void {
  if (assistantPatchInstalled) return;

  const prototype = AssistantMessageComponent.prototype as any as {
    __piMermaidPatched?: boolean;
    updateContent: (message: AssistantMessage) => void;
  };

  if (prototype.__piMermaidPatched) {
    assistantPatchInstalled = true;
    return;
  }

  const originalUpdateContent = prototype.updateContent;
  prototype.updateContent = function (
    this: AssistantMessagePatchInstance,
    message: AssistantMessage,
  ): void {
    const hasMermaid = message.content.some(
      (content) =>
        content.type === "text" && content.text.trim() && hasRenderableMermaid(content.text),
    );

    if (!hasMermaid) {
      originalUpdateContent.call(this, message);
      return;
    }

    this.lastMessage = message;
    this.contentContainer.clear();

    const hasVisibleContent = message.content.some(
      (content) =>
        (content.type === "text" && content.text.trim()) ||
        (content.type === "thinking" && content.thinking.trim()),
    );

    if (hasVisibleContent) {
      this.contentContainer.addChild(new Spacer(1));
    }

    for (let i = 0; i < message.content.length; i++) {
      const content = message.content[i];
      if (content.type === "text" && content.text.trim()) {
        const rendered = appendAssistantTextContent(
          this.contentContainer,
          content.text.trim(),
          this.markdownTheme,
        );
        if (!rendered) {
          this.contentContainer.addChild(
            new Markdown(content.text.trim(), 1, 0, this.markdownTheme),
          );
        }
        continue;
      }

      if (content.type !== "thinking" || !content.thinking.trim()) {
        continue;
      }

      const hasVisibleContentAfter = message.content
        .slice(i + 1)
        .some(
          (nextContent) =>
            (nextContent.type === "text" && nextContent.text.trim()) ||
            (nextContent.type === "thinking" && nextContent.thinking.trim()),
        );

      if (this.hideThinkingBlock) {
        this.contentContainer.addChild(
          new Text(
            interactiveTheme.italic(interactiveTheme.fg("thinkingText", this.hiddenThinkingLabel)),
            1,
            0,
          ),
        );
      } else {
        this.contentContainer.addChild(
          new Markdown(content.thinking.trim(), 1, 0, this.markdownTheme, {
            color: (text: string) => interactiveTheme.fg("thinkingText", text),
            italic: true,
          }),
        );
      }

      if (hasVisibleContentAfter) {
        this.contentContainer.addChild(new Spacer(1));
      }
    }

    const hasToolCalls = message.content.some((content) => content.type === "toolCall");
    if (hasToolCalls) return;

    if (message.stopReason === "aborted") {
      const abortMessage =
        message.errorMessage && message.errorMessage !== "Request was aborted"
          ? message.errorMessage
          : "Operation aborted";
      this.contentContainer.addChild(new Spacer(1));
      this.contentContainer.addChild(new Text(interactiveTheme.fg("error", abortMessage), 1, 0));
      return;
    }

    if (message.stopReason === "error") {
      const errorMessage = message.errorMessage || "Unknown error";
      this.contentContainer.addChild(new Spacer(1));
      this.contentContainer.addChild(
        new Text(interactiveTheme.fg("error", `Error: ${errorMessage}`), 1, 0),
      );
    }
  };

  prototype.__piMermaidPatched = true;
  assistantPatchInstalled = true;
}

function getLastAssistantText(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    if (entry.message.role !== "assistant") continue;
    const text = extractText(entry.message.content);
    if (text.trim()) return text;
  }
  return null;
}

function collectRenderableDetails(
  blocks: string[],
  notify: (message: string, type: "info" | "warning" | "error") => void,
): MermaidDetails[] {
  const details: MermaidDetails[] = [];

  if (blocks.length > MAX_BLOCKS) {
    notify(`Found ${blocks.length} mermaid blocks, rendering first ${MAX_BLOCKS}.`, "warning");
  }

  for (const [index, block] of blocks.slice(0, MAX_BLOCKS).entries()) {
    const blockIndex = index + 1;
    const blockLabel = blocks.length > 1 ? ` (block ${blockIndex})` : "";
    const sourceLines = block.split(/\r?\n/);
    if (sourceLines.length > MAX_SOURCE_LINES || block.length > MAX_SOURCE_CHARS) {
      notify(
        `Mermaid block ${blockIndex} too large (${sourceLines.length} lines, ${block.length} chars).`,
        "warning",
      );
      continue;
    }

    const { token, normalized } = getSupportedMermaidType(block);
    if (!normalized) {
      const typeLabel = token ?? "unknown";
      notify(
        `mermaid can't render type "${typeLabel}"${blockLabel}. Supported: ${SUPPORTED_TYPE_LABEL}.`,
        "info",
      );
      continue;
    }

    const blockDetails = buildMermaidDetails(block, blockIndex);
    if (!blockDetails) {
      notify(`Mermaid render failed${blockLabel}.`, "error");
      continue;
    }

    details.push(blockDetails);
  }

  return details;
}

export default function (pi: ExtensionAPI) {
  installAssistantMessagePatch();

  const renderMermaidMessage: MessageRenderer<MermaidDetails> = (message, _state, theme) => {
    const details = message.details as MermaidDetails | undefined;
    if (!details) return undefined;

    return createMermaidBodyComponent(details, theme, {
      collapseLong: false,
      expanded: true,
      showSource: false,
      showLabel: false,
    });
  };

  pi.registerMessageRenderer(MESSAGE_TYPE, renderMermaidMessage);

  pi.registerCommand("mermaid", {
    description: "Render mermaid in last assistant message as ASCII",
    handler: async (_args, ctx) => {
      const lastAssistant = getLastAssistantText(ctx.sessionManager.getBranch());
      if (!lastAssistant) {
        if (ctx.hasUI) ctx.ui.notify("No assistant message found", "warning");
        return;
      }

      const blocks = extractMermaidBlocks(lastAssistant, MAX_BLOCKS + 1);
      if (blocks.length === 0) {
        if (ctx.hasUI) ctx.ui.notify("No mermaid blocks found", "warning");
        return;
      }

      const notify = (message: string, type: "info" | "warning" | "error") => {
        if (ctx.hasUI) ctx.ui.notify(message, type);
      };

      const details = collectRenderableDetails(blocks, notify);
      for (const item of details) {
        pi.sendMessage({
          customType: MESSAGE_TYPE,
          content: "",
          display: true,
          details: item,
        });
      }
    },
  });
}
