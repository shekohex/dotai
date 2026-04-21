import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { createHash } from "node:crypto";
import { renderMermaidASCII } from "beautiful-mermaid";
import {
  extractText,
  getSupportedMermaidType,
  parseTopLevelMermaidFences,
  SUPPORTED_TYPE_LABEL,
} from "./parsing.js";

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

type AsciiVariant = {
  presetKey: string;
  ascii: string;
  lineCount: number;
  maxLineWidth: number;
};

type MermaidDetails = {
  source: string;
  index: number;
  ascii: string;
  lineCount: number;
  variants?: AsciiVariant[];
};

type RenderableSegment =
  | { type: "markdown"; text: string }
  | { type: "diagram"; details: MermaidDetails };

const asciiCache = new Map<string, AsciiVariant>();
const asciiLinesCache = new Map<string, { lines: string[]; previewLines: string[] }>();

function hashMermaid(block: string): string {
  return createHash("sha256").update(block).digest("hex").slice(0, 16);
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
  if (asciiCache.has(key)) {
    asciiCache.delete(key);
  }
  asciiCache.set(key, variant);
  while (asciiCache.size > MAX_ASCII_CACHE) {
    const oldestKey = asciiCache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    asciiCache.delete(oldestKey);
  }
}

function countAsciiLines(ascii: string): number {
  if (ascii.length === 0) return 0;
  return ascii.split(/\r?\n/).length;
}

function maxAsciiLineWidth(ascii: string): number {
  let maxWidth = 0;
  for (const line of ascii.split(/\r?\n/)) {
    if (line.length > maxWidth) maxWidth = line.length;
  }
  return maxWidth;
}

function getCachedAsciiLines(ascii: string): { lines: string[]; previewLines: string[] } {
  const cached = asciiLinesCache.get(ascii);
  if (cached) {
    return cached;
  }
  const lines = ascii.split(/\r?\n/);
  const previewLines = lines.slice(0, COLLAPSED_LINES);
  const computed = { lines, previewLines };
  asciiLinesCache.set(ascii, computed);
  return computed;
}

function renderAsciiVariant(block: string, diagramHash: string, preset: AsciiPreset): AsciiVariant {
  const key = getAsciiCacheKey(diagramHash, preset.key);
  const cached = getCachedVariant(key);
  if (cached) {
    return cached;
  }

  const ascii = renderMermaidASCII(block, {
    paddingX: preset.paddingX,
    boxBorderPadding: preset.boxBorderPadding,
  });
  const variant = {
    presetKey: preset.key,
    ascii,
    lineCount: countAsciiLines(ascii),
    maxLineWidth: maxAsciiLineWidth(ascii),
  };
  setCachedVariant(key, variant);
  return variant;
}

function selectAsciiVariant(
  terminalWidth: number,
  variants: AsciiVariant[] | undefined,
  fallbackAscii: string,
  fallbackLineCount: number,
): AsciiVariant & { clipped: boolean } {
  if (!variants || variants.length === 0) {
    return {
      presetKey: "fallback",
      ascii: fallbackAscii,
      lineCount: fallbackLineCount,
      maxLineWidth: maxAsciiLineWidth(fallbackAscii),
      clipped: maxAsciiLineWidth(fallbackAscii) > terminalWidth,
    };
  }

  for (const variant of variants) {
    if (variant.maxLineWidth <= terminalWidth) {
      return { ...variant, clipped: false };
    }
  }

  const narrowest = variants.at(-1) ?? variants[0];
  return { ...narrowest, clipped: true };
}

function buildMermaidDetails(block: string, index: number): MermaidDetails | null {
  const hash = hashMermaid(block);
  try {
    const variants = ASCII_PRESETS.map((preset) => renderAsciiVariant(block, hash, preset));
    const defaultVariant = variants[0];
    if (defaultVariant === undefined) {
      return null;
    }

    return {
      source: block,
      index,
      ascii: defaultVariant.ascii,
      lineCount: defaultVariant.lineCount,
      variants,
    };
  } catch {
    return null;
  }
}

function buildInlineRenderableSegments(text: string): RenderableSegment[] {
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

    if (block) {
      const details = buildMermaidDetails(block, ++diagramIndex);
      if (details) {
        segments.push({ type: "diagram", details });
      } else {
        segments.push({ type: "markdown", text: text.slice(start, end) });
      }
    } else {
      segments.push({ type: "markdown", text: text.slice(start, end) });
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

function getLastAssistantText(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
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
    if (normalized === null) {
      notify(
        `mermaid can't render type "${token ?? "unknown"}"${blockLabel}. Supported: ${SUPPORTED_TYPE_LABEL}.`,
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

export {
  buildInlineRenderableSegments,
  collectRenderableDetails,
  getCachedAsciiLines,
  getLastAssistantText,
  hasRenderableMermaid,
  selectAsciiVariant,
  MAX_BLOCKS,
  COLLAPSED_LINES,
};
export type { AsciiVariant, MermaidDetails, RenderableSegment };
