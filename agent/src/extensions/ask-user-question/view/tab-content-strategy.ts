import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Input } from "@earendil-works/pi-tui";
import { Spacer, Text } from "@earendil-works/pi-tui";
import { uiText } from "../state/labels.js";
import type { QuestionData } from "../tool/types.js";
import type { ChatRowView } from "./components/chat-row-view.js";
import { OneLineClippedText } from "./components/one-line-clipped-text.js";
import type { PreviewPaneProps } from "./components/preview/preview-pane.js";
import type { DialogState } from "./dialog-builder.js";
import {
  HINT_PART_CANCEL,
  HINT_PART_COLLAPSE,
  HINT_PART_ENTER,
  HINT_PART_NAV,
  HINT_PART_NOTES,
  HINT_PART_TAB,
  HINT_PART_TOGGLE,
} from "./dialog-builder.js";
import type { StatefulView } from "./stateful-view.js";
import type { TabComponents } from "./tab-components.js";

const NOTES_HEADER = "Notes:";

/** Interface for objects that can provide the focused row range. */
export interface HasFocusedRowRange {
  focusedItemRowRange(width: number): [number, number] | undefined;
}

/**
 * Type guard: checks whether a value has `focusedItemRowRange`.
 *
 * @param {unknown} v - Value to check
 * @returns {v is HasFocusedRowRange} Type predicate result
 */
function hasFocusedRowRange(v: unknown): v is HasFocusedRowRange {
  return (
    typeof v === "object" &&
    v !== null &&
    "focusedItemRowRange" in v &&
    typeof v.focusedItemRowRange === "function"
  );
}

/**
 * Per-tab content provider. Pure functional — closes over construction-time config; per-tick state
 * threads through method args. The chrome wrapper enforces height equality across tabs via
 * `bodyHeight + footerRowCount`.
 */
export interface TabContentStrategy {
  /**
   * Total RENDERED footer rows — MUST equal what `footerRows()` actually emits. Drives residual
   * math.
   */
  readonly footerRowCount: number;

  /** Variable rows above the body, after top chrome (border + tabBar + Spacer). */
  headingRows(state: DialogState): Component[];

  /** Body Component placed at the body slot. */
  bodyComponent(state: DialogState): Component;

  /** Natural rendered height of `bodyComponent(state)` at given width. */
  bodyHeight(width: number, state: DialogState): number;

  /** Optional rows between body's trailing Spacer and the bottom border. */
  midRows(state: DialogState): Component[];

  /** Footer rows below the bottom border. Rendered row count MUST equal `footerRowCount`. */
  footerRows(state: DialogState): Component[];

  /**
   * Row range of the focused item within the body's rendered output, or undefined if no interactive
   * focus.
   */
  focusedItemRowRange(width: number, state: DialogState): [number, number] | undefined;
}

export interface QuestionTabStrategyConfig {
  theme: Theme;
  questions: readonly QuestionData[];
  getPreviewPane: () => StatefulView<PreviewPaneProps>;
  tabsByIndex: ReadonlyArray<TabComponents>;
  notesInput: Input;
  chatRow: ChatRowView;
  isMulti: boolean;
  getCurrentBodyHeight: (width: number) => number;
}

export class QuestionTabStrategy implements TabContentStrategy {
  /** Spacer(1) + chatRow(1) + Spacer(1) + Text(hint, 1) = 4 rendered rows. */
  readonly footerRowCount = 4;

  constructor(private readonly config: QuestionTabStrategyConfig) {}

  headingRows(state: DialogState): Component[] {
    const out: Component[] = [];
    const question = this.config.questions[state.currentTab];
    /* In multi-question mode the tab bar already shows the header; suppress the inline badge. */
    if (!this.config.isMulti && question?.header !== undefined && question.header.length > 0) {
      out.push(new Text(this.config.theme.bg("selectedBg", ` ${question.header} `), 1, 0));
      out.push(new Spacer(1));
    }
    if (question !== undefined) {
      out.push(new Text(this.config.theme.bold(question.question), 1, 0));
      out.push(new Spacer(1));
    }
    return out;
  }

  bodyComponent(state: DialogState): Component {
    const question = this.config.questions[state.currentTab];
    const mso = this.config.tabsByIndex[state.currentTab]?.multiSelect;
    if (question?.multiSelect === true && mso !== undefined) return mso;
    return this.config.getPreviewPane();
  }

  bodyHeight(width: number, _state: DialogState): number {
    return this.config.getCurrentBodyHeight(width);
  }

  midRows(state: DialogState): Component[] {
    if (!state.notesVisible) return [];
    return [
      new Text(this.config.theme.fg("muted", uiText("notes.header", NOTES_HEADER)), 1, 0),
      this.config.notesInput,
      new Spacer(1),
    ];
  }

  footerRows(state: DialogState): Component[] {
    const question = this.config.questions[state.currentTab];
    return [
      new Spacer(1),
      this.config.chatRow,
      new Spacer(1),
      new OneLineClippedText(
        this.config.theme.fg("dim", buildHintText(question, this.config.isMulti, state)),
        1,
      ),
    ];
  }

  focusedItemRowRange(width: number, state: DialogState): [number, number] | undefined {
    const question = this.config.questions[state.currentTab];
    const mso = this.config.tabsByIndex[state.currentTab]?.multiSelect;
    if (question?.multiSelect === true && mso !== undefined) return mso.focusedItemRowRange(width);
    const pane = this.config.getPreviewPane();
    if (hasFocusedRowRange(pane)) {
      return pane.focusedItemRowRange(width);
    }
    return undefined;
  }
}

/**
 * Build the controls hint line. Order: Enter · ↑/↓ [· Space toggle] [· n notes] [· Tab switch] ·
 * Esc · Ctrl+] collapse
 *
 * `HINT_SINGLE` / `HINT_MULTI` are the CORE prefix that must always render — the collapse
 * affordance is appended last so the core stays a contiguous substring even when the trailing part
 * is clipped by `OneLineClippedText` on terminals < ~95 cols. This is the trade we picked over
 * wrapping (which would inflate `footerRowCount` and desync the height math in
 * `DialogView.render`).
 *
 * @param {QuestionData | undefined} question - Current question or undefined
 * @param {boolean} isMulti - Whether multi-question mode
 * @param {DialogState} state - Current dialog state
 * @returns {string} Hint text
 */
export function buildHintText(
  question: QuestionData | undefined,
  isMulti: boolean,
  state: DialogState,
): string {
  const parts: string[] = [
    uiText("hint.enter", HINT_PART_ENTER),
    uiText("hint.navigate", HINT_PART_NAV),
  ];
  if (question?.multiSelect === true) parts.push(uiText("hint.toggle", HINT_PART_TOGGLE));
  if (
    question !== undefined &&
    question.multiSelect !== true &&
    state.focusedOptionHasPreview &&
    !state.notesVisible
  ) {
    parts.push(uiText("hint.notes", HINT_PART_NOTES));
  }
  if (isMulti) parts.push(uiText("hint.tab", HINT_PART_TAB));
  parts.push(uiText("hint.cancel", HINT_PART_CANCEL));
  parts.push(uiText("hint.collapse", HINT_PART_COLLAPSE));
  return parts.join(" · ");
}
