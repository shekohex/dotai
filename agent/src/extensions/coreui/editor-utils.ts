type ThemeBackground = "userMessageBg";
export type PasteSummaryMode = "always" | "large-only" | "never";
export type CursorShape =
  | "blinking-block"
  | "steady-block"
  | "blinking-underline"
  | "steady-underline"
  | "blinking-bar"
  | "steady-bar";

export type CorePromptEditorConfig = {
  paddingX: number;
  paddingY: number;
  placeholderInsetX: number;
  background: ThemeBackground;
  placeholderRotationMs: number;
  pasteSummaryMode: PasteSummaryMode;
  pasteSummaryMinLines: number;
  pasteSummaryMinChars: number;
  cursorShape: CursorShape;
};

export type EditorInternals = {
  pastes: Map<number, string>;
  pasteCounter: number;
};

function readObjectProperty(target: object, key: PropertyKey): unknown {
  return Object.getOwnPropertyDescriptor(target, key)?.value;
}

function writeObjectProperty(target: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

const STRIP_ANSI_PATTERN = new RegExp(
  `${String.fromCodePoint(27)}(?:\\[[0-9;? ]*[ -/]*[@-~]|_pi:c${String.fromCodePoint(7)})`,
  "g",
);

function stripAnsi(text: string): string {
  return text.replace(STRIP_ANSI_PATTERN, "");
}

function isEditorChromeLine(line: string): boolean {
  const plain = stripAnsi(line).trim();
  return /^(?:─+|─── [↑↓] \d+ more ─*)$/.test(plain);
}

export function removeEditorChromeLines(lines: string[]): string[] {
  const renderedLines = [...lines];
  if (renderedLines.length > 0 && isEditorChromeLine(renderedLines[0])) {
    renderedLines.shift();
  }
  for (let i = renderedLines.length - 1; i >= 0; i--) {
    if (isEditorChromeLine(renderedLines[i])) {
      renderedLines.splice(i, 1);
      break;
    }
  }
  return renderedLines.length > 0 ? renderedLines : [""];
}

export function addVerticalPaddingLines(
  lines: string[],
  width: number,
  paddingY: number,
): string[] {
  const verticalPadding = Math.max(0, paddingY);
  if (verticalPadding === 0) {
    return lines;
  }
  const blankLine = " ".repeat(Math.max(0, width));
  return [
    ...Array.from({ length: verticalPadding }, () => blankLine),
    ...lines,
    ...Array.from({ length: verticalPadding }, () => blankLine),
  ];
}

export function normalizePastedText(text: string): string {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "    ");
  return normalized
    .split("")
    .filter((char) => {
      const codePoint = char.codePointAt(0);
      return char === "\n" || (codePoint !== undefined && codePoint >= 32);
    })
    .join("");
}

export function shouldSummarizePaste(text: string, config: CorePromptEditorConfig): boolean {
  switch (config.pasteSummaryMode) {
    case "never":
      return false;
    case "always":
      return true;
    case "large-only": {
      const lines = text.split("\n").length;
      return lines > config.pasteSummaryMinLines || text.length > config.pasteSummaryMinChars;
    }
  }
  return false;
}

export function createPasteMarker(
  pasteId: number,
  text: string,
  config: CorePromptEditorConfig,
): string {
  const lineCount = text.split("\n").length;
  if (
    lineCount > 1 &&
    (config.pasteSummaryMode === "always" || lineCount > config.pasteSummaryMinLines)
  ) {
    return `[paste #${pasteId} +${lineCount} lines]`;
  }
  return `[paste #${pasteId} ${text.length} chars]`;
}

export function readEditorInternals(target: object): EditorInternals {
  const existing = readObjectProperty(target, "pastes");
  let pastes = new Map<number, string>();
  if (existing instanceof Map) {
    const entries = [...existing.entries()];
    if (
      entries.every(
        (entry): entry is [number, string] =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === "number" &&
          typeof entry[1] === "string",
      )
    ) {
      pastes = new Map(entries);
    }
  }
  if (readObjectProperty(target, "pastes") !== pastes) {
    writeObjectProperty(target, "pastes", pastes);
  }
  const pasteCounterValue = readObjectProperty(target, "pasteCounter");
  const pasteCounter =
    typeof pasteCounterValue === "number" && Number.isFinite(pasteCounterValue)
      ? pasteCounterValue
      : 0;
  if (pasteCounterValue !== pasteCounter) {
    writeObjectProperty(target, "pasteCounter", pasteCounter);
  }
  return { pastes, pasteCounter };
}

export function writeEditorPasteCounter(target: object, value: number): void {
  writeObjectProperty(target, "pasteCounter", value);
}
