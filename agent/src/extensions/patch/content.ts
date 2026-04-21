import { readFileSync } from "node:fs";
import type { UpdateFileChunk } from "./types.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function deriveNewContentsFromChunks(
  filePath: string,
  chunks: UpdateFileChunk[],
): { unified_diff: string; content: string } {
  let originalContent: string;
  try {
    originalContent = readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new Error(`Failed to read file ${filePath}: ${errorMessage(error)}`, { cause: error });
  }

  const originalLines = originalContent.split("\n");

  if (originalLines.length > 0 && originalLines.at(-1) === "") {
    originalLines.pop();
  }

  const replacements = computeReplacements(originalLines, filePath, chunks);
  const newLines = applyReplacements(originalLines, replacements);

  if (newLines.length === 0 || newLines.at(-1) !== "") {
    newLines.push("");
  }

  const newContent = newLines.join("\n");
  const unifiedDiff = generateUnifiedDiff(originalContent, newContent);

  return {
    unified_diff: unifiedDiff,
    content: newContent,
  };
}

function computeReplacements(
  originalLines: string[],
  filePath: string,
  chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    const computed = computeChunkReplacement(originalLines, filePath, chunk, lineIndex);
    lineIndex = computed.nextLineIndex;
    replacements.push(computed.replacement);
  }

  replacements.sort((a, b) => a[0] - b[0]);

  return replacements;
}

function computeChunkReplacement(
  originalLines: string[],
  filePath: string,
  chunk: UpdateFileChunk,
  lineIndex: number,
): { replacement: [number, number, string[]]; nextLineIndex: number } {
  const scopedLineIndex = resolveChunkStartIndex(originalLines, filePath, chunk, lineIndex);
  if (chunk.old_lines.length === 0) {
    const insertionIdx =
      originalLines.length > 0 && originalLines.at(-1) === ""
        ? originalLines.length - 1
        : originalLines.length;
    return { replacement: [insertionIdx, 0, chunk.new_lines], nextLineIndex: scopedLineIndex };
  }

  const matched = matchChunkPattern(originalLines, scopedLineIndex, filePath, chunk);
  return {
    replacement: [matched.foundIndex, matched.pattern.length, matched.newSlice],
    nextLineIndex: matched.foundIndex + matched.pattern.length,
  };
}

function resolveChunkStartIndex(
  originalLines: string[],
  filePath: string,
  chunk: UpdateFileChunk,
  lineIndex: number,
): number {
  if (chunk.change_context === undefined || chunk.change_context.length === 0) {
    return lineIndex;
  }

  const contextIdx = seekSequence(originalLines, [chunk.change_context], lineIndex);
  if (contextIdx === -1) {
    throw new Error(`Failed to find context '${chunk.change_context}' in ${filePath}`);
  }

  return contextIdx + 1;
}

function matchChunkPattern(
  originalLines: string[],
  lineIndex: number,
  filePath: string,
  chunk: UpdateFileChunk,
): { foundIndex: number; pattern: string[]; newSlice: string[] } {
  let pattern = chunk.old_lines;
  let newSlice = chunk.new_lines;
  let foundIndex = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);
  if (foundIndex === -1 && pattern.length > 0 && pattern.at(-1) === "") {
    pattern = pattern.slice(0, -1);
    if (newSlice.length > 0 && newSlice.at(-1) === "") {
      newSlice = newSlice.slice(0, -1);
    }
    foundIndex = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);
  }
  if (foundIndex === -1) {
    throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.old_lines.join("\n")}`);
  }

  return { foundIndex, pattern, newSlice };
}

function applyReplacements(
  lines: string[],
  replacements: Array<[number, number, string[]]>,
): string[] {
  const result = [...lines];

  for (let i = replacements.length - 1; i >= 0; i--) {
    const [startIdx, oldLen, newSegment] = replacements[i];
    result.splice(startIdx, oldLen);
    for (let j = 0; j < newSegment.length; j++) {
      result.splice(startIdx + j, 0, newSegment[j]);
    }
  }

  return result;
}

function normalizeUnicode(value: string): string {
  return value
    .replaceAll(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replaceAll(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replaceAll(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
    .replaceAll("…", "...")
    .replaceAll("\u00A0", " ");
}

function tryMatch(
  lines: string[],
  pattern: string[],
  startIndex: number,
  compare: (a: string, b: string) => boolean,
  eof: boolean,
): number {
  if (eof) {
    const fromEnd = lines.length - pattern.length;
    if (fromEnd >= startIndex) {
      let matches = true;
      for (let j = 0; j < pattern.length; j++) {
        if (!compare(lines[fromEnd + j], pattern[j])) {
          matches = false;
          break;
        }
      }
      if (matches) return fromEnd;
    }
  }

  for (let i = startIndex; i <= lines.length - pattern.length; i++) {
    let matches = true;
    for (let j = 0; j < pattern.length; j++) {
      if (!compare(lines[i + j], pattern[j])) {
        matches = false;
        break;
      }
    }
    if (matches) return i;
  }

  return -1;
}

function seekSequence(lines: string[], pattern: string[], startIndex: number, eof = false): number {
  if (pattern.length === 0) return -1;

  const exact = tryMatch(lines, pattern, startIndex, (a, b) => a === b, eof);
  if (exact !== -1) return exact;

  const rstrip = tryMatch(lines, pattern, startIndex, (a, b) => a.trimEnd() === b.trimEnd(), eof);
  if (rstrip !== -1) return rstrip;

  const trim = tryMatch(lines, pattern, startIndex, (a, b) => a.trim() === b.trim(), eof);
  if (trim !== -1) return trim;

  return tryMatch(
    lines,
    pattern,
    startIndex,
    (a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()),
    eof,
  );
}

function generateUnifiedDiff(oldContent: string, newContent: string): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  let diff = "@@ -1 +1 @@\n";
  const maxLen = Math.max(oldLines.length, newLines.length);
  let hasChanges = false;

  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i] || "";
    const newLine = newLines[i] || "";

    if (oldLine !== newLine) {
      if (oldLine) diff += `-${oldLine}\n`;
      if (newLine) diff += `+${newLine}\n`;
      hasChanges = true;
    } else if (oldLine) {
      diff += ` ${oldLine}\n`;
    }
  }

  return hasChanges ? diff : "";
}

export function trimDiff(diff: string): string {
  const lines = diff.split("\n");
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  );

  if (contentLines.length === 0) return diff;

  let min = Infinity;
  for (const line of contentLines) {
    const content = line.slice(1);
    if (content.trim().length > 0) {
      const match = content.match(/^(\s*)/);
      if (match) min = Math.min(min, match[1].length);
    }
  }
  if (min === Infinity || min === 0) return diff;

  return lines
    .map((line) => {
      if (
        (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
        !line.startsWith("---") &&
        !line.startsWith("+++")
      ) {
        const prefix = line[0];
        const content = line.slice(1);
        return prefix + content.slice(min);
      }
      return line;
    })
    .join("\n");
}
