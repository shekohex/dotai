import { CustomEditor } from "@mariozechner/pi-coding-agent";
import type { ExtensionContext, KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
  addVerticalPaddingLines,
  createPasteMarker,
  normalizePastedText,
  readEditorInternals,
  removeEditorChromeLines,
  shouldSummarizePaste,
  writeEditorPasteCounter,
  type CorePromptEditorConfig,
  type CursorShape,
} from "./editor-utils.js";
import { pickRandomWelcomeMessage } from "./whimsical.js";

const PASTE_START = "\u001B[200~";
const PASTE_END = "\u001B[201~";
const CURSOR = "\u001B[7m \u001B[27m";
const CURSOR_SHAPES: Record<CursorShape, string> = {
  "blinking-block": "\u001B[1 q",
  "steady-block": "\u001B[2 q",
  "blinking-underline": "\u001B[3 q",
  "steady-underline": "\u001B[4 q",
  "blinking-bar": "\u001B[5 q",
  "steady-bar": "\u001B[6 q",
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
    const lines = addVerticalPaddingLines(
      removeEditorChromeLines(super.render(width)),
      width,
      CORE_PROMPT_EDITOR_CONFIG.paddingY,
    );
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
    return `${backgroundAnsi}${line.replaceAll("\u001B[0m", `\u001B[0m${backgroundAnsi}`).replaceAll("\u001B[49m", backgroundAnsi)}\u001B[49m`;
  }

  private installCallbackHooks(): void {
    Reflect.deleteProperty(this, "onSubmit");
    Reflect.deleteProperty(this, "onChange");

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

  private insertPastedText(text: string): void {
    const filtered = normalizePastedText(text);

    if (!filtered) {
      return;
    }

    if (!shouldSummarizePaste(filtered, CORE_PROMPT_EDITOR_CONFIG)) {
      this.insertTextAtCursor(filtered);
      return;
    }

    const internals = readEditorInternals(this);
    const pasteId = internals.pasteCounter + 1;
    writeEditorPasteCounter(this, pasteId);
    internals.pastes.set(pasteId, filtered);

    this.insertTextAtCursor(createPasteMarker(pasteId, filtered, CORE_PROMPT_EDITOR_CONFIG));
  }
}
