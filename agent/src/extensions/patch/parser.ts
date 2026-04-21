import type { Hunk, PatchTargetDetails, UpdateFileChunk } from "./types.js";

function parsePatchHeader(
  lines: string[],
  startIdx: number,
): { filePath: string; movePath?: string; nextIdx: number } | null {
  const line = lines[startIdx];

  if (line.startsWith("*** Add File:")) {
    const filePath = line.slice("*** Add File:".length).trim();
    return filePath ? { filePath, nextIdx: startIdx + 1 } : null;
  }

  if (line.startsWith("*** Delete File:")) {
    const filePath = line.slice("*** Delete File:".length).trim();
    return filePath ? { filePath, nextIdx: startIdx + 1 } : null;
  }

  if (line.startsWith("*** Update File:")) {
    const filePath = line.slice("*** Update File:".length).trim();
    let movePath: string | undefined;
    let nextIdx = startIdx + 1;

    if (nextIdx < lines.length && lines[nextIdx].startsWith("*** Move to:")) {
      movePath = lines[nextIdx].slice("*** Move to:".length).trim();
      nextIdx++;
    }

    return filePath ? { filePath, movePath, nextIdx } : null;
  }

  return null;
}

function parseUpdateFileChunks(
  lines: string[],
  startIdx: number,
): { chunks: UpdateFileChunk[]; nextIdx: number } {
  const chunks: UpdateFileChunk[] = [];
  let i = startIdx;

  while (i < lines.length && !lines[i].startsWith("***")) {
    if (!lines[i].startsWith("@@")) {
      i++;
      continue;
    }

    const parsed = parseUpdateFileChunk(lines, i);
    chunks.push(parsed.chunk);
    i = parsed.nextIdx;
  }

  return { chunks, nextIdx: i };
}

function parseUpdateFileChunk(
  lines: string[],
  startIdx: number,
): { chunk: UpdateFileChunk; nextIdx: number } {
  const contextLine = lines[startIdx].slice(2).trim();
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let isEndOfFile = false;
  let i = startIdx + 1;

  while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("***")) {
    const changeLine = lines[i];
    if (changeLine === "*** End of File") {
      isEndOfFile = true;
      i++;
      break;
    }

    applyChunkChangeLine(changeLine, oldLines, newLines);
    i++;
  }

  return {
    chunk: {
      old_lines: oldLines,
      new_lines: newLines,
      change_context: contextLine || undefined,
      is_end_of_file: isEndOfFile || undefined,
    },
    nextIdx: i,
  };
}

function applyChunkChangeLine(changeLine: string, oldLines: string[], newLines: string[]): void {
  if (changeLine.startsWith(" ")) {
    const content = changeLine.slice(1);
    oldLines.push(content);
    newLines.push(content);
    return;
  }
  if (changeLine.startsWith("-")) {
    oldLines.push(changeLine.slice(1));
    return;
  }
  if (changeLine.startsWith("+")) {
    newLines.push(changeLine.slice(1));
  }
}

function parseAddFileContent(
  lines: string[],
  startIdx: number,
): { content: string; nextIdx: number } {
  let content = "";
  let i = startIdx;

  while (i < lines.length && !lines[i].startsWith("***")) {
    if (lines[i].startsWith("+")) {
      content += `${lines[i].slice(1)}\n`;
    }
    i++;
  }

  if (content.endsWith("\n")) {
    content = content.slice(0, -1);
  }

  return { content, nextIdx: i };
}

export function stripHeredoc(input: string): string {
  const heredocMatch = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
  if (heredocMatch) {
    return heredocMatch[2];
  }
  return input;
}

function parsePatchBodyEntry(
  lines: string[],
  startIdx: number,
): { hunk: Hunk; nextIdx: number } | null {
  const header = parsePatchHeader(lines, startIdx);
  if (!header) {
    return null;
  }
  if (lines[startIdx].startsWith("*** Add File:")) {
    const { content, nextIdx } = parseAddFileContent(lines, header.nextIdx);
    return { hunk: { type: "add", path: header.filePath, contents: content }, nextIdx };
  }
  if (lines[startIdx].startsWith("*** Delete File:")) {
    return { hunk: { type: "delete", path: header.filePath }, nextIdx: header.nextIdx };
  }

  const { chunks, nextIdx } = parseUpdateFileChunks(lines, header.nextIdx);
  return {
    hunk: { type: "update", path: header.filePath, move_path: header.movePath, chunks },
    nextIdx,
  };
}

export function parsePatch(patchText: string): { hunks: Hunk[] } {
  const cleaned = stripHeredoc(patchText.trim());
  const lines = cleaned.split("\n");
  const hunks: Hunk[] = [];

  const beginIdx = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  const endIdx = lines.findIndex((line) => line.trim() === "*** End Patch");

  if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) {
    throw new Error("Invalid patch format: missing Begin/End markers");
  }

  let i = beginIdx + 1;

  while (i < endIdx) {
    const parsed = parsePatchBodyEntry(lines, i);
    if (!parsed) {
      i++;
      continue;
    }

    hunks.push(parsed.hunk);
    i = parsed.nextIdx;
  }

  return { hunks };
}

export function summarizeHunks(hunks: Hunk[]): PatchTargetDetails[] {
  return hunks.map((hunk) => {
    const movePath = hunk.type === "update" ? hunk.move_path : undefined;
    const hasMovePath = movePath !== undefined && movePath.length > 0;
    return {
      relativePath: hasMovePath ? movePath : hunk.path,
      type: hasMovePath ? "move" : hunk.type,
      sourcePath: hasMovePath ? hunk.path : undefined,
    };
  });
}

export function summarizePatchText(patchText: string): PatchTargetDetails[] {
  try {
    return summarizeHunks(parsePatch(patchText).hunks);
  } catch {
    return [];
  }
}

export function summarizePartialPatchText(patchText: string): PatchTargetDetails[] {
  const targets: PatchTargetDetails[] = [];
  const lines = stripHeredoc(patchText.trim()).split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("*** Add File:")) {
      targets.push({ relativePath: line.slice("*** Add File:".length).trim(), type: "add" });
      continue;
    }
    if (line.startsWith("*** Delete File:")) {
      targets.push({ relativePath: line.slice("*** Delete File:".length).trim(), type: "delete" });
      continue;
    }
    if (line.startsWith("*** Update File:")) {
      const relativePath = line.slice("*** Update File:".length).trim();
      const moveLine = lines[i + 1]?.trim();
      if (moveLine?.startsWith("*** Move to:")) {
        targets.push({
          relativePath: moveLine.slice("*** Move to:".length).trim(),
          type: "move",
          sourcePath: relativePath,
        });
        i++;
        continue;
      }
      targets.push({ relativePath, type: "update" });
    }
  }

  return targets.filter((target) => target.relativePath.length > 0);
}
