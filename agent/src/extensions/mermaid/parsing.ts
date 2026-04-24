import { Type } from "typebox";
import { Value } from "typebox/value";

type MermaidFenceBlock = {
  block: string;
  startOffset: number;
  endOffset: number;
};

const TextPartSchema = Type.Object(
  {
    type: Type.Literal("text"),
    text: Type.String(),
  },
  { additionalProperties: true },
);

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

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return Value.Check(TextPartSchema, value);
}

function parseFenceChar(marker: string): "`" | "~" | undefined {
  const firstChar = marker[0];
  if (firstChar === "`" || firstChar === "~") {
    return firstChar;
  }
  return undefined;
}

type ActiveFence = {
  startOffset: number;
  fenceChar: "`" | "~";
  fenceLength: number;
  nestedFenceDepth: number;
  lines: string[];
  contentStarted: boolean;
};

function buildMermaidFenceBlock(
  activeFence: ActiveFence,
  endOffset: number,
): MermaidFenceBlock | undefined {
  if (!activeFence.contentStarted || activeFence.lines.length === 0) {
    return undefined;
  }

  const langLine = activeFence.lines[0]?.trim().toLowerCase() ?? "";
  if (!langLine.startsWith("mermaid")) {
    return undefined;
  }

  const blockLines = activeFence.lines.slice(1);
  const block = blockLines.join("\n").trim();
  if (block.length === 0) {
    return undefined;
  }

  return {
    block,
    startOffset: activeFence.startOffset,
    endOffset,
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => (isTextPart(item) ? item.text : ""))
      .filter((item) => item.length > 0)
      .join("\n");
  }
  return "";
}

function parseTopLevelMermaidFences(text: string, maxBlocks = Infinity): MermaidFenceBlock[] {
  const blocks: MermaidFenceBlock[] = [];
  let offset = 0;
  let activeFence: ActiveFence | null = null;

  for (const line of text.split(/\r?\n/)) {
    const lineEndOffset = offset + line.length;
    const trimmedLine = line.trim();

    if (activeFence === null) {
      const parsedStart = parseFenceStart(line);
      if (parsedStart) {
        activeFence = {
          startOffset: offset,
          fenceChar: parsedStart.fenceChar,
          fenceLength: parsedStart.fenceLength,
          nestedFenceDepth: 0,
          lines: [parsedStart.info],
          contentStarted: true,
        };
      }
      offset = lineEndOffset + 1;
      continue;
    }

    if (trackNestedFenceIfNeeded(activeFence, trimmedLine)) {
      activeFence.lines.push(line);
      offset = lineEndOffset + 1;
      continue;
    }

    const closeResult = closeFenceIfNeeded(activeFence, trimmedLine, lineEndOffset);
    if (closeResult.closed) {
      if (closeResult.block) blocks.push(closeResult.block);
      if (blocks.length >= maxBlocks) {
        break;
      }
      activeFence = null;
      offset = lineEndOffset + 1;
      continue;
    }

    activeFence.lines.push(line);
    offset = lineEndOffset + 1;
  }

  return blocks;
}

function parseFenceStart(
  line: string,
): { fenceChar: "`" | "~"; fenceLength: number; info: string } | null {
  const startMatch = line.match(/^\s*([`~]{3,})(.*)$/);
  if (!startMatch) {
    return null;
  }

  const marker = startMatch[1];
  const fenceChar = marker ? parseFenceChar(marker) : undefined;
  if (!marker || !fenceChar) {
    return null;
  }

  return {
    fenceChar,
    fenceLength: marker.length,
    info: (startMatch[2] ?? "").trim(),
  };
}

function trackNestedFenceIfNeeded(activeFence: ActiveFence, trimmedLine: string): boolean {
  const nestedStartMatch = trimmedLine.match(/^([`~]{3,})/);
  if (!nestedStartMatch) {
    return false;
  }

  const nestedMarker = nestedStartMatch[1];
  const nestedChar = nestedMarker ? parseFenceChar(nestedMarker) : undefined;
  if (!nestedMarker || !nestedChar || nestedChar !== activeFence.fenceChar) {
    return false;
  }
  if (nestedMarker.length < activeFence.fenceLength) {
    return false;
  }

  const info = trimmedLine.slice(nestedMarker.length).trim().toLowerCase();
  if (info.startsWith("mermaid")) {
    activeFence.nestedFenceDepth += 1;
    return true;
  }

  return false;
}

function closeFenceIfNeeded(
  activeFence: ActiveFence,
  trimmedLine: string,
  lineEndOffset: number,
): { closed: boolean; block?: MermaidFenceBlock } {
  const endFenceMatch = trimmedLine.match(/^([`~]{3,})\s*$/);
  if (!endFenceMatch) {
    return { closed: false };
  }

  const marker = endFenceMatch[1];
  const markerChar = marker ? parseFenceChar(marker) : undefined;
  if (!marker || !markerChar || markerChar !== activeFence.fenceChar) {
    return { closed: false };
  }
  if (marker.length < activeFence.fenceLength) {
    return { closed: false };
  }

  if (activeFence.nestedFenceDepth > 0) {
    activeFence.nestedFenceDepth -= 1;
    return { closed: false };
  }

  return { closed: true, block: buildMermaidFenceBlock(activeFence, lineEndOffset) };
}

function extractMermaidBlocks(text: string, maxBlocks = Infinity): string[] {
  return parseTopLevelMermaidFences(text, maxBlocks).map((block) => block.block);
}

function getMermaidTypeToken(block: string): string | null {
  for (const line of block.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("%%")) continue;
    const [token] = trimmedLine.split(/[\s{[]/, 1);
    return token ?? null;
  }
  return null;
}

function getSupportedMermaidType(block: string): {
  token: string | null;
  normalized: string | null;
} {
  const token = getMermaidTypeToken(block);
  if (token === null || token.length === 0) {
    return { token, normalized: null };
  }
  return { token, normalized: SUPPORTED_TYPES.get(token) ?? null };
}

export {
  extractMermaidBlocks,
  extractText,
  getSupportedMermaidType,
  parseTopLevelMermaidFences,
  SUPPORTED_TYPE_LABEL,
};
export type { MermaidFenceBlock };
