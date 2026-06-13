import type { QuestionAnswer, QuestionData } from "../../tool/types.js";
import type { WrappingSelectItem } from "../../view/components/wrapping-select.js";
import { ROW_INTENT_META } from "../row-intent.js";

/**
 * Pure derivation: does the option focused by `(currentTab, optionIndex)` carry a non-empty
 * `preview` string? Mode gates (chat focus, notes mode, multiSelect) layer on top via dispatch
 * branches; this predicate is intentionally mode-agnostic.
 *
 * @param {readonly QuestionData[]} questions Question list.
 * @param {number} currentTab Active question index.
 * @param {number} optionIndex Active option index.
 * @returns {boolean} True when focused option has preview text.
 */
export function computeFocusedOptionHasPreview(
  questions: readonly QuestionData[],
  currentTab: number,
  optionIndex: number,
): boolean {
  const q = questions[currentTab];
  if (q === undefined) return false;
  const opt = q.options[optionIndex];
  return opt !== undefined && typeof opt.preview === "string" && opt.preview.length > 0;
}

/**
 * Numbering for the chat row's WrappingSelect, computed from the active tab's items.
 *
 * The chat row lives in its own one-item WrappingSelect; the host calls this on every tab switch /
 * selection update to keep the chat row's `N. ` label continuous with the visible numbered rows of
 * the active tab. The shape `{ offset, total }` mirrors
 * `WrappingSelect.setNumbering(numberStartOffset, totalItemsForNumbering)` directly.
 *
 * @param {readonly WrappingSelectItem[]} items Visible row items for active tab.
 * @returns {{ offset: number; total: number }} Offset and total count for chat-row numbering.
 */
export function chatNumberingFor(items: readonly WrappingSelectItem[]): {
  offset: number;
  total: number;
} {
  // Count only the visible-numbered rows. The Next sentinel renders without a number
  // (see MultiSelectView), so it must NOT advance the chat row's number — otherwise
  // chat reads as "6." next to options labeled 1-4. Sourced from `ROW_INTENT_META[kind].numbered`
  // so adding a new non-numbered kind is a single META edit.
  const count = items.filter((i) => ROW_INTENT_META[i.kind].numbered).length;
  return { offset: count, total: count + 1 };
}

/**
 * Which row in the active tab should be marked as "previously confirmed"? Drives the
 * `WrappingSelect` confirmed-row indicator (label + ` ✔`) when the user navigates back to a
 * question they already answered. Returns `undefined` when no marker should be drawn — multi-select
 * handles its own `[✔]` boxes via `multiSelectChecked`, `kind: "chat"` ends the dialog so the row
 * can never be re-entered, and a missing/non-matching answer (defensive) silently skips the
 * marker.
 *
 * @param {readonly QuestionData[]} questions Question list.
 * @param {number} currentTab Active question index.
 * @param {ReadonlyMap<number, QuestionAnswer>} answers Answer map by question index.
 * @param {readonly WrappingSelectItem[]} items Visible row items for active tab.
 * @returns {{ index: number; labelOverride?: string } | undefined} Confirmed row marker, if any.
 */
export function selectConfirmedIndicator(
  questions: readonly QuestionData[],
  currentTab: number,
  answers: ReadonlyMap<number, QuestionAnswer>,
  items: readonly WrappingSelectItem[],
): { index: number; labelOverride?: string } | undefined {
  const q = questions[currentTab];
  if (q === undefined || q.multiSelect === true) return undefined;
  const prior = answers.get(currentTab);
  if (prior === undefined || prior.kind === "chat") return undefined;
  if (prior.kind === "custom") {
    const otherIndex = items.findIndex((it) => it.kind === "other");
    if (otherIndex < 0) return undefined;
    return { index: otherIndex, labelOverride: prior.answer ?? "" };
  }
  if (prior.kind !== "option" || typeof prior.answer !== "string") return undefined;
  const index = items.findIndex((it) => it.kind === "option" && it.label === prior.answer);
  if (index < 0) return undefined;
  return { index };
}

/**
 * Index of the preview pane to display for the current tab. The Submit tab (currentTab ===
 * questions.length) reuses the last question's pane purely for layout — the strategy machinery
 * picks the right body component independently. Defensive against `totalQuestions === 0`.
 *
 * @param {number} currentTab Active tab index.
 * @param {number} totalQuestions Total question count.
 * @returns {number} Preview pane index.
 */
export function selectActivePreviewPaneIndex(currentTab: number, totalQuestions: number): number {
  if (totalQuestions <= 0) return 0;
  return Math.min(currentTab, totalQuestions - 1);
}

/**
 * Items array for the active tab, with the same Submit-tab clamp as `selectActivePreviewPaneIndex`.
 * Falls back to an empty array if the index lands outside the items array (defensive).
 *
 * @param {ReadonlyArray<readonly WrappingSelectItem[]>} itemsByTab Items grouped by tab.
 * @param {number} currentTab Active tab index.
 * @param {number} totalQuestions Total question count.
 * @returns {readonly WrappingSelectItem[]} Items for active tab.
 */
export function selectActiveTabItems(
  itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>,
  currentTab: number,
  totalQuestions: number,
): readonly WrappingSelectItem[] {
  const idx = selectActivePreviewPaneIndex(currentTab, totalQuestions);
  return itemsByTab[idx] ?? [];
}
