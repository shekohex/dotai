import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
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

type AiSuggestionLog = {
  suggestions: string[];
  selectedIndex: number;
  sourceText: string;
  cursorOffset: number;
};

type ManualAutocompleteRequest = {
  sourceText: string;
  cursorOffset: number;
  generationAttempt: number;
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
    setCycleAutocompleteSuggestion?: (cycle: ((direction: 1 | -1) => void) | undefined) => void;
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
  private aiAutocompleteGenerating = false;
  private manualAutocompleteRequest: ManualAutocompleteRequest | undefined;
  private readonly aiAutocomplete:
    | {
        backend: AiAutocompleteBackend;
        settings: AiAutocompleteSettings;
        cwd: string;
        getAssistantSummary?: () => string | undefined;
        setTriggerAutocomplete?: (trigger: (() => void) | undefined) => void;
        setCycleAutocompleteSuggestion?: (cycle: ((direction: 1 | -1) => void) | undefined) => void;
        setCancelAutocomplete?: (cancel: (() => void) | undefined) => void;
        runner: DebouncedAiAutocompleteRunner;
      }
    | undefined;
  private aiSuggestionLog: AiSuggestionLog | undefined;

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
      setCycleAutocompleteSuggestion?: (cycle: ((direction: 1 | -1) => void) | undefined) => void;
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
    this.aiAutocomplete?.setCycleAutocompleteSuggestion?.((direction) => {
      this.cycleAiAutocompleteSuggestion(direction);
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
    this.stopAiAutocompleteGeneration();
    this.manualAutocompleteRequest = undefined;
    this.aiAutocomplete?.runner.cancel();
    this.aiAutocomplete?.setTriggerAutocomplete?.(undefined);
    this.aiAutocomplete?.setCycleAutocompleteSuggestion?.(undefined);
    this.aiAutocomplete?.setCancelAutocomplete?.(undefined);
  }

  override handleInput(data: string): void {
    if (!data) {
      return;
    }

    if (matchesAiAutocompleteTriggerKey(data)) {
      this.triggerAiAutocomplete();
      return;
    }

    if (data === "\t" && !this.isShowingAutocomplete() && this.acceptAiCompletion()) {
      return;
    }

    if (matchesAiAutocompleteCycleKey(data, 1)) {
      this.cycleAiAutocompleteSuggestion(1);
      return;
    }

    if (matchesAiAutocompleteCycleKey(data, -1)) {
      this.cycleAiAutocompleteSuggestion(-1);
      return;
    }

    if (
      data === "\u001B" &&
      (this.aiSuggestionLog !== undefined || this.aiAutocompleteGenerating)
    ) {
      this.cancelPendingAiAutocompleteRequest();
      this.clearAiSuggestionLog();
      return;
    }

    this.cancelPendingAiAutocompleteRequest();
    this.clearAiSuggestionLog();

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
    this.cancelPendingAiAutocompleteRequest();
    this.currentText = text;
    this.clearAiSuggestionLog(false);

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
      this.clearAiSuggestionLog();
      return;
    }

    if (!this.isAiSuggestionLogValid()) {
      this.clearAiSuggestionLog(false);
    }
    const text = this.getText();
    const cursorOffset = this.getCursorOffset();
    const previousSuggestions = this.getCurrentAiSuggestions();
    const generationAttempt = this.getNextManualGenerationAttempt(text, cursorOffset);
    this.manualAutocompleteRequest = { sourceText: text, cursorOffset, generationAttempt };
    this.aiAutocomplete.runner.runNow(
      (signal) => {
        this.startAiAutocompleteGeneration();
        return this.aiAutocomplete!.backend.complete({
          text,
          cursorOffset,
          cwd: this.aiAutocomplete!.cwd,
          assistantSummary: this.aiAutocomplete!.settings.includeAssistantSummary
            ? this.aiAutocomplete!.getAssistantSummary?.()
            : undefined,
          previousSuggestions,
          trigger: "manual",
          generationAttempt,
          signal,
        });
      },
      (result) => {
        this.applyAiAutocompleteResult(result, text, cursorOffset);
        this.stopAiAutocompleteGeneration();
      },
      () => {
        this.stopAiAutocompleteGeneration();
      },
    );
  }

  private cancelAiAutocomplete(): void {
    this.cancelPendingAiAutocompleteRequest();
    this.clearAiSuggestionLog();
  }

  private cancelPendingAiAutocompleteRequest(): void {
    this.aiAutocomplete?.runner.cancel();
    this.stopAiAutocompleteGeneration();
    this.manualAutocompleteRequest = undefined;
  }

  private scheduleAiAutocomplete(text: string): void {
    if (this.aiAutocomplete === undefined || !this.aiAutocomplete.settings.enabled) {
      this.aiAutocomplete?.runner.cancel();
      this.stopAiAutocompleteGeneration();
      return;
    }

    if (!this.isCursorAtTextEnd()) {
      this.aiAutocomplete.runner.cancel();
      this.stopAiAutocompleteGeneration();
      return;
    }

    const cursorOffset = this.getCursorOffset();
    this.aiAutocomplete.runner.schedule(
      (signal) => {
        this.startAiAutocompleteGeneration();
        return this.aiAutocomplete!.backend.complete({
          text,
          cursorOffset,
          cwd: this.aiAutocomplete!.cwd,
          assistantSummary: this.aiAutocomplete!.settings.includeAssistantSummary
            ? this.aiAutocomplete!.getAssistantSummary?.()
            : undefined,
          previousSuggestions: this.getCurrentAiSuggestions(),
          trigger: "eager",
          generationAttempt: 1,
          signal,
        });
      },
      (result) => {
        this.applyAiAutocompleteResult(result, text, cursorOffset);
        this.stopAiAutocompleteGeneration();
      },
      () => {
        this.stopAiAutocompleteGeneration();
      },
    );
  }

  private startAiAutocompleteGeneration(): void {
    this.aiAutocompleteGenerating = true;
  }

  private stopAiAutocompleteGeneration(): void {
    this.aiAutocompleteGenerating = false;
  }

  private applyAiAutocompleteResult(
    result: AiAutocompleteResult,
    sourceText: string,
    cursorOffset: number,
  ): void {
    const newSuggestions = result.suggestions.filter((suggestion) => suggestion.length > 0);
    if (
      newSuggestions.length === 0 ||
      this.getText() !== sourceText ||
      this.getCursorOffset() !== cursorOffset
    ) {
      return;
    }

    const previousSuggestions =
      this.aiSuggestionLog !== undefined &&
      this.aiSuggestionLog.sourceText === sourceText &&
      this.aiSuggestionLog.cursorOffset === cursorOffset
        ? this.aiSuggestionLog.suggestions
        : [];
    const newSuggestionSet = new Set(newSuggestions);
    const suggestions = [
      ...previousSuggestions.filter((text) => !newSuggestionSet.has(text)),
      ...newSuggestions,
    ];
    this.aiSuggestionLog = {
      suggestions,
      selectedIndex: suggestions.length - 1,
      sourceText,
      cursorOffset,
    };
    this.tui.requestRender();
  }

  private cycleAiAutocompleteSuggestion(direction: 1 | -1): void {
    if (this.aiSuggestionLog === undefined) {
      return;
    }
    if (!this.isAiSuggestionLogValid()) {
      this.clearAiSuggestionLog();
      return;
    }

    const count = this.aiSuggestionLog.suggestions.length;
    if (count < 2) return;

    this.aiSuggestionLog.selectedIndex =
      (this.aiSuggestionLog.selectedIndex + direction + count) % count;
    this.tui.requestRender();
  }

  private acceptAiCompletion(): boolean {
    if (this.aiSuggestionLog === undefined) {
      return false;
    }

    if (!this.isAiSuggestionLogValid()) {
      this.clearAiSuggestionLog();
      return false;
    }

    const text = this.aiSuggestionLog.suggestions[this.aiSuggestionLog.selectedIndex];
    if (text === undefined) return false;
    this.cancelPendingAiAutocompleteRequest();
    this.clearAiSuggestionLog(false);
    this.insertTextAtCursor(text);
    return true;
  }

  private isAiSuggestionLogValid(): boolean {
    return (
      this.aiSuggestionLog !== undefined &&
      this.isCursorAtTextEnd() &&
      this.getText() === this.aiSuggestionLog.sourceText &&
      this.getCursorOffset() === this.aiSuggestionLog.cursorOffset
    );
  }

  private getCurrentAiSuggestions(): string[] | undefined {
    return this.isAiSuggestionLogValid() ? this.aiSuggestionLog?.suggestions : undefined;
  }

  private getNextManualGenerationAttempt(sourceText: string, cursorOffset: number): number {
    const previousSuggestions = this.getCurrentAiSuggestions();
    if (previousSuggestions !== undefined) return previousSuggestions.length + 1;

    if (
      this.manualAutocompleteRequest !== undefined &&
      this.manualAutocompleteRequest.sourceText === sourceText &&
      this.manualAutocompleteRequest.cursorOffset === cursorOffset
    ) {
      return this.manualAutocompleteRequest.generationAttempt + 1;
    }

    return 1;
  }

  private clearAiSuggestionLog(render = true): void {
    if (this.aiSuggestionLog === undefined) {
      return;
    }
    this.aiSuggestionLog = undefined;
    if (render) this.tui.requestRender();
  }

  private applyInlineAiCompletionHint(lines: string[], _width: number, _paddingX: number): void {
    if (this.aiSuggestionLog === undefined) {
      return;
    }
    if (!this.isAiSuggestionLogValid()) {
      this.clearAiSuggestionLog();
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

    const text = this.aiSuggestionLog.suggestions[this.aiSuggestionLog.selectedIndex];
    if (text === undefined) return;

    const hint = truncateToWidth(
      this.getTheme().fg("dim", getInlineAiCompletionPreview(text)),
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

function getInlineAiCompletionPreview(text: string): string {
  const [firstLine = ""] = text.split(/\r\n?|\n/u);
  return text.includes("\n") || text.includes("\r") ? `${firstLine}…` : firstLine;
}

function matchesAiAutocompleteTriggerKey(data: string): boolean {
  return matchesKey(data, Key.ctrl(Key.period));
}

function matchesAiAutocompleteCycleKey(data: string, direction: 1 | -1): boolean {
  if (direction === 1) return matchesKey(data, Key.ctrl(Key.comma));
  return matchesKey(data, Key.ctrlShift(Key.comma)) || matchesKey(data, Key.ctrl(Key.lessthan));
}
