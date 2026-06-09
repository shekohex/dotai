import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AiAutocompleteBackend, AiAutocompleteResult } from "./ai-autocomplete-backend.js";
import { DebouncedAiAutocompleteRunner } from "./ai-autocomplete-backend.js";
import type { AiAutocompleteSettings } from "./ai-autocomplete-settings.js";
import {
  colorizeWorkflowLines,
  disarmWorkflowMode,
  getWorkflowModeState,
  nextWorkflowAnimationTick,
  shouldDisarmWorkflowModeOnInput,
  syncWorkflowModeState,
  updateWorkflowModeAfterTextChange,
} from "../dynamic-workflows/workflow-editor.js";
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
const EDITOR_CURSOR = "\u001B[7m \u001B[0m";
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
  aiAutocomplete?: {
    backend: AiAutocompleteBackend;
    settings: AiAutocompleteSettings;
    cwd: string;
    getAssistantSummary?: () => string | undefined;
    setTriggerAutocomplete?: (trigger: (() => void) | undefined) => void;
    setCancelAutocomplete?: (cancel: (() => void) | undefined) => void;
  },
): (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CorePromptEditor {
  return (tui, theme, keybindings) =>
    new CorePromptEditor(tui, theme, keybindings, getTheme, isIdle, aiAutocomplete);
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
  private workflowAnimationTimer: ReturnType<typeof setInterval> | undefined;
  private readonly aiAutocomplete:
    | {
        backend: AiAutocompleteBackend;
        settings: AiAutocompleteSettings;
        cwd: string;
        getAssistantSummary?: () => string | undefined;
        setTriggerAutocomplete?: (trigger: (() => void) | undefined) => void;
        setCancelAutocomplete?: (cancel: (() => void) | undefined) => void;
        runner: DebouncedAiAutocompleteRunner;
      }
    | undefined;
  private aiCompletion: { text: string; sourceText: string; cursorOffset: number } | undefined;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    getTheme: () => Theme,
    isIdle: () => boolean,
    aiAutocomplete?: {
      backend: AiAutocompleteBackend;
      settings: AiAutocompleteSettings;
      cwd: string;
      getAssistantSummary?: () => string | undefined;
      setTriggerAutocomplete?: (trigger: (() => void) | undefined) => void;
      setCancelAutocomplete?: (cancel: (() => void) | undefined) => void;
    },
  ) {
    super(tui, theme, keybindings, {
      paddingX: CORE_PROMPT_EDITOR_CONFIG.paddingX,
    });
    this.getTheme = getTheme;
    this.isIdle = isIdle;
    this.aiAutocomplete = aiAutocomplete
      ? {
          ...aiAutocomplete,
          runner: new DebouncedAiAutocompleteRunner(aiAutocomplete.settings.debounceMs),
        }
      : undefined;
    this.installCallbackHooks();
    this.aiAutocomplete?.setTriggerAutocomplete?.(() => {
      this.triggerAiAutocomplete();
    });
    this.aiAutocomplete?.setCancelAutocomplete?.(() => {
      this.cancelAiAutocomplete();
    });
    this.startPlaceholderRotation();
  }

  override setPaddingX(_padding: number): void {
    super.setPaddingX(CORE_PROMPT_EDITOR_CONFIG.paddingX);
  }

  dispose(): void {
    this.stopPlaceholderRotation();
    this.stopWorkflowAnimation();
    this.aiAutocomplete?.runner.cancel();
    this.aiAutocomplete?.setTriggerAutocomplete?.(undefined);
    this.aiAutocomplete?.setCancelAutocomplete?.(undefined);
  }

  override handleInput(data: string): void {
    if (!data) {
      return;
    }

    if (data === "\t" && !this.isShowingAutocomplete() && this.acceptAiCompletion()) {
      return;
    }

    if (data === "\u001B" && this.aiCompletion !== undefined) {
      this.clearAiCompletion();
      return;
    }

    const workflowModeState = getWorkflowModeState();
    syncWorkflowModeState(workflowModeState, this.getText());
    if (shouldDisarmWorkflowModeOnInput(data, workflowModeState, this.getTextBeforeCursor())) {
      disarmWorkflowMode(workflowModeState);
      this.tui.requestRender();
      return;
    }

    const before = this.getText();
    this.handleCoreInput(data);
    updateWorkflowModeAfterTextChange(workflowModeState, before, this.getText());
  }

  private handleCoreInput(data: string): void {
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
        this.handleCoreInput(remaining);
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
      this.handleCoreInput(remaining);
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

    this.applyInlineAiCompletionHint(lines, width, paddingX);

    const workflowModeState = getWorkflowModeState();
    syncWorkflowModeState(workflowModeState, this.getText());
    this.reconcileWorkflowAnimation(workflowModeState.active);

    const renderedLines = colorizeWorkflowLines(
      lines.map((line) => this.applyBackground(line)),
      workflowModeState,
    );

    if (this.focused && renderedLines.length > 0) {
      renderedLines[0] = `${CURSOR_SHAPES[CORE_PROMPT_EDITOR_CONFIG.cursorShape]}${renderedLines[0]}`;
    }

    return renderedLines;
  }

  private getTextBeforeCursor(): string {
    const lines = this.getLines();
    const { line, col } = this.getCursor();
    return (
      lines.slice(0, line).join("\n") + (line > 0 ? "\n" : "") + (lines[line] ?? "").slice(0, col)
    );
  }

  private getCursorOffset(): number {
    return this.getTextBeforeCursor().length;
  }

  private isCursorAtTextEnd(): boolean {
    const lines = this.getLines();
    const cursor = this.getCursor();
    return cursor.line === lines.length - 1 && cursor.col === (lines.at(-1) ?? "").length;
  }

  private reconcileWorkflowAnimation(active: boolean): void {
    if (active && this.focused && this.workflowAnimationTimer === undefined) {
      this.workflowAnimationTimer = setInterval(() => {
        const state = getWorkflowModeState();
        state.tick = nextWorkflowAnimationTick(state.tick);
        this.tui.requestRender();
      }, 90);
      this.workflowAnimationTimer.unref?.();
      return;
    }

    if ((!active || !this.focused) && this.workflowAnimationTimer !== undefined) {
      this.stopWorkflowAnimation();
    }
  }

  private stopWorkflowAnimation(): void {
    if (this.workflowAnimationTimer === undefined) {
      return;
    }
    clearInterval(this.workflowAnimationTimer);
    this.workflowAnimationTimer = undefined;
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
    delete this.onSubmit;
    delete this.onChange;

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
    this.clearAiCompletion(false);

    if (text.length > 0) {
      this.stopPlaceholderRotation();
    } else {
      this.startPlaceholderRotation();
    }

    this.onChangeHandler?.(text);
    if (this.aiAutocomplete?.settings.mode === "eager") {
      this.scheduleAiAutocomplete(text);
    } else {
      this.aiAutocomplete?.runner.cancel();
    }
  };

  private triggerAiAutocomplete(): void {
    if (this.aiAutocomplete === undefined || !this.aiAutocomplete.settings.enabled) {
      return;
    }

    if (!this.isCursorAtTextEnd()) {
      this.clearAiCompletion();
      return;
    }

    this.clearAiCompletion(false);
    const text = this.getText();
    const cursorOffset = this.getCursorOffset();
    this.aiAutocomplete.runner.runNow(
      (signal) =>
        this.aiAutocomplete!.backend.complete({
          text,
          cursorOffset,
          cwd: this.aiAutocomplete!.cwd,
          assistantSummary: this.aiAutocomplete!.settings.includeAssistantSummary
            ? this.aiAutocomplete!.getAssistantSummary?.()
            : undefined,
          signal,
        }),
      (result) => {
        this.applyAiAutocompleteResult(result, text, cursorOffset);
      },
    );
  }

  private cancelAiAutocomplete(): void {
    this.aiAutocomplete?.runner.cancel();
    this.clearAiCompletion();
  }

  private scheduleAiAutocomplete(text: string): void {
    if (this.aiAutocomplete === undefined || !this.aiAutocomplete.settings.enabled) {
      this.aiAutocomplete?.runner.cancel();
      return;
    }

    if (!this.isCursorAtTextEnd()) {
      this.aiAutocomplete.runner.cancel();
      return;
    }

    const cursorOffset = this.getCursorOffset();
    this.aiAutocomplete.runner.schedule(
      (signal) =>
        this.aiAutocomplete!.backend.complete({
          text,
          cursorOffset,
          cwd: this.aiAutocomplete!.cwd,
          assistantSummary: this.aiAutocomplete!.settings.includeAssistantSummary
            ? this.aiAutocomplete!.getAssistantSummary?.()
            : undefined,
          signal,
        }),
      (result) => {
        this.applyAiAutocompleteResult(result, text, cursorOffset);
      },
    );
  }

  private applyAiAutocompleteResult(
    result: AiAutocompleteResult,
    sourceText: string,
    cursorOffset: number,
  ): void {
    if (!result.text || this.getText() !== sourceText || this.getCursorOffset() !== cursorOffset) {
      return;
    }

    this.aiCompletion = { text: result.text, sourceText, cursorOffset };
    this.tui.requestRender();
  }

  private acceptAiCompletion(): boolean {
    if (this.aiCompletion === undefined) {
      return false;
    }

    if (!this.isCursorAtTextEnd()) {
      this.clearAiCompletion();
      return false;
    }

    if (
      this.getText() !== this.aiCompletion.sourceText ||
      this.getCursorOffset() !== this.aiCompletion.cursorOffset
    ) {
      this.clearAiCompletion();
      return false;
    }

    const text = this.aiCompletion.text;
    this.clearAiCompletion(false);
    this.insertTextAtCursor(text);
    return true;
  }

  private clearAiCompletion(render = true): void {
    if (this.aiCompletion === undefined) {
      return;
    }
    this.aiCompletion = undefined;
    if (render) this.tui.requestRender();
  }

  private applyInlineAiCompletionHint(lines: string[], _width: number, _paddingX: number): void {
    if (this.aiCompletion === undefined || !this.isCursorAtTextEnd()) {
      return;
    }

    const markerIndex = lines.findIndex(
      (line) => line.includes(CURSOR_MARKER) || line.includes(EDITOR_CURSOR),
    );
    if (markerIndex === -1) return;

    const line = lines[markerIndex] ?? "";
    const markerStart = line.indexOf(CURSOR_MARKER);
    const cursorIndex = line.indexOf(EDITOR_CURSOR, markerStart === -1 ? 0 : markerStart);
    if (cursorIndex === -1) return;

    const hintStart = cursorIndex + EDITOR_CURSOR.length;
    const beforeHint = line.slice(0, hintStart);
    const afterHint = line.slice(hintStart);
    const availableWidth = visibleWidth(afterHint);
    if (availableWidth === 0) return;

    const hint = truncateToWidth(
      this.getTheme().fg("dim", this.aiCompletion.text),
      availableWidth,
      "…",
    );
    const hintWidth = visibleWidth(hint);
    lines[markerIndex] =
      `${beforeHint}${hint}${" ".repeat(Math.max(0, visibleWidth(afterHint) - hintWidth))}`;
  }

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
