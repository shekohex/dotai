export type ToolOutputStyleOptions = {
  truncateFrom?: "head" | "tail";
};

type ToolOutputTheme = {
  fg: (token: "toolOutput" | "muted", value: string) => string;
};

type ToolResultLike = {
  content: Array<{ type: string; text?: string }>;
};

export function getTextContent(result: ToolResultLike): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

export function countTextLines(content: unknown): number {
  if (typeof content !== "string" || content.length === 0) {
    return 0;
  }

  return content.split("\n").length;
}

export function summarizeLineCount(lineCount: number): string {
  return `${lineCount} line${lineCount === 1 ? "" : "s"}`;
}

export function summarizeTextLineCount(text: string): string {
  return summarizeLineCount(
    text.split("\n").filter((line) => line.length > 0 || text.includes("\n")).length || 1,
  );
}

export function styleToolOutput(
  text: string,
  theme: ToolOutputTheme,
  maxLineLength?: number,
  options: ToolOutputStyleOptions = {},
): string {
  if (!text) {
    return "";
  }

  return text
    .split("\n")
    .map((line) => styleToolOutputLine(line, theme, maxLineLength, options))
    .join("\n");
}

function styleToolOutputLine(
  line: string,
  theme: ToolOutputTheme,
  maxLineLength?: number,
  options: ToolOutputStyleOptions = {},
): string {
  if (maxLineLength === undefined || line.length <= maxLineLength) {
    return theme.fg("toolOutput", line);
  }

  const truncatedChars = line.length - maxLineLength;
  if (options.truncateFrom === "tail") {
    const visibleText = line.slice(-maxLineLength);
    return `${theme.fg("muted", `…(truncated ${truncatedChars} chars)…`)}${theme.fg("toolOutput", visibleText)}`;
  }

  const visibleText = line.slice(0, maxLineLength);
  return `${theme.fg("toolOutput", visibleText)}${theme.fg("muted", ` …(truncated ${truncatedChars} chars)…`)}`;
}

export function formatDurationHuman(ms: number): string {
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
