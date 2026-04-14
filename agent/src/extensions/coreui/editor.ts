import { CustomEditor } from "@mariozechner/pi-coding-agent";
import type { ExtensionContext, KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { pickRandomWelcomeMessage } from "./whimsical.js";

type ThemeBackground = Parameters<Theme["bg"]>[0];
type PasteSummaryMode = "always" | "large-only" | "never";
type CursorShape =
  | "blinking-block"
  | "steady-block"
  | "blinking-underline"
  | "steady-underline"
  | "blinking-bar"
  | "steady-bar";

type CorePromptEditorConfig = {
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

type EditorInternals = {
  pastes: Map<number, string>;
  pasteCounter: number;
};

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const CURSOR = "\x1b[7m \x1b[27m";
const STRIP_ANSI_PATTERN = new RegExp(
  `${String.fromCharCode(27)}(?:\\[[0-9;? ]*[ -/]*[@-~]|_pi:c${String.fromCharCode(7)})`,
  "g",
);
const CURSOR_SHAPES: Record<CursorShape, string> = {
  "blinking-block": "\x1b[1 q",
  "steady-block": "\x1b[2 q",
  "blinking-underline": "\x1b[3 q",
  "steady-underline": "\x1b[4 q",
  "blinking-bar": "\x1b[5 q",
  "steady-bar": "\x1b[6 q",
};

const CORE_PROMPT_EDITOR_CONFIG: CorePromptEditorConfig = {
  paddingX: 1,
  paddingY: 1,
  placeholderInsetX: 1,
  background: "userMessageBg",
  placeholderRotationMs: 5000,
  pasteSummaryMode: "large-only",
  pasteSummaryMinLines: 10,
  pasteSummaryMinChars: 1500,
  cursorShape: "steady-bar",
};

export function createCorePromptEditorFactory(
  getTheme: () => ExtensionContext["ui"]["theme"],
  isIdle: () => boolean,
): (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CorePromptEditor {
  return (tui, theme, keybindings) =>
    new CorePromptEditor(tui, theme, keybindings, getTheme, isIdle);
}

class CorePromptEditor extends CustomEditor {
  private readonly getTheme: () => Theme;
  private readonly isIdle: () => boolean;
  private bufferedPaste = "";
  private receivingPaste = false;
  private currentText = "";
  private placeholderMessage = pickRandomWelcomeMessage();
  private placeholderTimer: ReturnType<typeof setInterval> | undefined;
  private onSubmitHandler: ((text: string) => void) | undefined;
  private onChangeHandler: ((text: string) => void) | undefined;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    getTheme: () => Theme,
    isIdle: () => boolean,
  ) {
    super(tui, theme, keybindings, {
      paddingX: CORE_PROMPT_EDITOR_CONFIG.paddingX,
    });
    this.getTheme = getTheme;
    this.isIdle = isIdle;
    this.installCallbackHooks();
    this.startPlaceholderRotation();
  }

  override setPaddingX(_padding: number): void {
    super.setPaddingX(CORE_PROMPT_EDITOR_CONFIG.paddingX);
  }

  dispose(): void {
    this.stopPlaceholderRotation();
  }

  override handleInput(data: string): void {
    if (!data) {
      return;
    }

    if (this.receivingPaste) {
      const endIndex = data.indexOf(PASTE_END);

      if (endIndex === -1) {
        this.bufferedPaste += data;
        return;
      }

      this.bufferedPaste += data.slice(0, endIndex);

      const pastedText = this.bufferedPaste;
      this.bufferedPaste = "";
      this.receivingPaste = false;

      if (pastedText) {
        this.insertPastedText(pastedText);
      }

      const remaining = data.slice(endIndex + PASTE_END.length);
      if (remaining) {
        this.handleInput(remaining);
      }
      return;
    }

    const startIndex = data.indexOf(PASTE_START);
    if (startIndex === -1) {
      super.handleInput(data);
      return;
    }

    const beforePaste = data.slice(0, startIndex);
    if (beforePaste) {
      super.handleInput(beforePaste);
    }

    this.receivingPaste = true;
    this.bufferedPaste = "";

    const remaining = data.slice(startIndex + PASTE_START.length);
    if (remaining) {
      this.handleInput(remaining);
    }
  }

  override render(width: number): string[] {
    const lines = this.addVerticalPadding(this.removeEditorChrome(super.render(width)), width);
    const paddingX = Math.min(
      CORE_PROMPT_EDITOR_CONFIG.paddingX,
      Math.max(0, Math.floor((width - 1) / 2)),
    );

    if (this.getText().length === 0) {
      this.applyPlaceholder(lines, width, paddingX);
    }

    const renderedLines = lines.map((line) => this.applyBackground(line));

    if (this.focused && renderedLines.length > 0) {
      renderedLines[0] = `${CURSOR_SHAPES[CORE_PROMPT_EDITOR_CONFIG.cursorShape]}${renderedLines[0]}`;
    }

    return renderedLines;
  }

  private applyPlaceholder(lines: string[], width: number, paddingX: number): void {
    if (lines.length === 0) {
      return;
    }

    const placeholderLineIndex = Math.min(CORE_PROMPT_EDITOR_CONFIG.paddingY, lines.length - 1);

    const contentWidth = Math.max(1, width - paddingX * 2);
    const cursorPrefix = this.focused ? `${CURSOR_MARKER}${CURSOR}` : "";
    const cursorWidth = this.focused ? 1 : 0;
    const placeholderInset = " ".repeat(CORE_PROMPT_EDITOR_CONFIG.placeholderInsetX);
    const placeholderInsetWidth = CORE_PROMPT_EDITOR_CONFIG.placeholderInsetX;
    const placeholder = truncateToWidth(
      this.getTheme().fg("dim", this.placeholderMessage),
      Math.max(0, contentWidth - cursorWidth - placeholderInsetWidth),
      "…",
    );
    const placeholderWidth = visibleWidth(placeholder);
    const trailingSpaces = " ".repeat(
      Math.max(0, contentWidth - cursorWidth - placeholderInsetWidth - placeholderWidth),
    );

    lines[placeholderLineIndex] =
      `${" ".repeat(paddingX)}${cursorPrefix}${placeholderInset}${placeholder}${trailingSpaces}${" ".repeat(paddingX)}`;
  }

  private applyBackground(line: string): string {
    const theme = this.getTheme();
    const backgroundAnsi = theme.getBgAnsi(CORE_PROMPT_EDITOR_CONFIG.background);
    return `${backgroundAnsi}${line.replaceAll("\x1b[0m", `\x1b[0m${backgroundAnsi}`).replaceAll("\x1b[49m", backgroundAnsi)}\x1b[49m`;
  }

  private installCallbackHooks(): void {
    delete (this as { onSubmit?: (text: string) => void }).onSubmit;
    delete (this as { onChange?: (text: string) => void }).onChange;

    Object.defineProperty(this, "onSubmit", {
      configurable: true,
      enumerable: true,
      get: () => this.handleSubmit,
      set: (handler: ((text: string) => void) | undefined) => {
        this.onSubmitHandler = handler;
      },
    });

    Object.defineProperty(this, "onChange", {
      configurable: true,
      enumerable: true,
      get: () => this.handleChange,
      set: (handler: ((text: string) => void) | undefined) => {
        this.onChangeHandler = handler;
      },
    });
  }

  private readonly handleSubmit = (text: string): void => {
    this.rotatePlaceholder();
    this.startPlaceholderRotation();
    this.onSubmitHandler?.(text);
  };

  private readonly handleChange = (text: string): void => {
    this.currentText = text;

    if (text.length > 0) {
      this.stopPlaceholderRotation();
    } else {
      this.startPlaceholderRotation();
    }

    this.onChangeHandler?.(text);
  };

  private startPlaceholderRotation(): void {
    if (this.currentText.length > 0) {
      return;
    }

    if (this.placeholderTimer) {
      return;
    }

    this.placeholderTimer = setInterval(() => {
      if (this.currentText.length > 0 || !this.isIdle()) {
        return;
      }

      this.rotatePlaceholder();
    }, CORE_PROMPT_EDITOR_CONFIG.placeholderRotationMs);
  }

  private stopPlaceholderRotation(): void {
    if (!this.placeholderTimer) {
      return;
    }

    clearInterval(this.placeholderTimer);
    this.placeholderTimer = undefined;
  }

  private rotatePlaceholder(): void {
    this.placeholderMessage = pickRandomWelcomeMessage(this.placeholderMessage);
    this.tui.requestRender();
  }

  private removeEditorChrome(lines: string[]): string[] {
    const renderedLines = [...lines];

    if (renderedLines.length > 0 && this.isEditorChromeLine(renderedLines[0]!)) {
      renderedLines.shift();
    }

    for (let i = renderedLines.length - 1; i >= 0; i--) {
      if (this.isEditorChromeLine(renderedLines[i]!)) {
        renderedLines.splice(i, 1);
        break;
      }
    }

    return renderedLines.length > 0 ? renderedLines : [""];
  }

  private addVerticalPadding(lines: string[], width: number): string[] {
    const verticalPadding = Math.max(0, CORE_PROMPT_EDITOR_CONFIG.paddingY);

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

  private isEditorChromeLine(line: string): boolean {
    const plain = this.stripAnsi(line).trim();
    return /^(?:─+|─── [↑↓] \d+ more ─*)$/.test(plain);
  }

  private stripAnsi(text: string): string {
    return text.replace(STRIP_ANSI_PATTERN, "");
  }

  private insertPastedText(text: string): void {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
    const filtered = normalized
      .split("")
      .filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
      .join("");

    if (!filtered) {
      return;
    }

    if (!this.shouldSummarizePaste(filtered)) {
      this.insertTextAtCursor(filtered);
      return;
    }

    const internals = this.getInternals();
    const pasteId = internals.pasteCounter + 1;
    internals.pasteCounter = pasteId;
    internals.pastes.set(pasteId, filtered);

    this.insertTextAtCursor(this.createPasteMarker(pasteId, filtered));
  }

  private shouldSummarizePaste(text: string): boolean {
    switch (CORE_PROMPT_EDITOR_CONFIG.pasteSummaryMode) {
      case "never":
        return false;
      case "always":
        return true;
      case "large-only": {
        const lines = text.split("\n").length;
        return (
          lines > CORE_PROMPT_EDITOR_CONFIG.pasteSummaryMinLines ||
          text.length > CORE_PROMPT_EDITOR_CONFIG.pasteSummaryMinChars
        );
      }
    }
  }

  private createPasteMarker(pasteId: number, text: string): string {
    const lineCount = text.split("\n").length;

    if (
      lineCount > 1 &&
      (CORE_PROMPT_EDITOR_CONFIG.pasteSummaryMode === "always" ||
        lineCount > CORE_PROMPT_EDITOR_CONFIG.pasteSummaryMinLines)
    ) {
      return `[paste #${pasteId} +${lineCount} lines]`;
    }

    return `[paste #${pasteId} ${text.length} chars]`;
  }

  private getInternals(): EditorInternals {
    return this as unknown as EditorInternals;
  }
}
