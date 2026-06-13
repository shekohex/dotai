import type { ActiveView } from "../../view/stateful-view.js";

/**
 * Discriminated focus selector — single source of truth for "which view owns focus this tick?"
 * Priority order matches the dispatcher cascade (`key-router.ts:151-178`) and the reducer's
 * defensive clears (`state-reducer.ts:104-126`).
 *
 * Priority: notes > submit > chat > options.
 *
 * @param {{ notesVisible: boolean; chatFocused: boolean; currentTab: number }} state -
 *   Questionnaire state slice with focus fields
 * @param {number} totalQuestions - Total number of questions for submit-tab detection
 * @returns {ActiveView} The active view discriminator
 */
export function selectActiveView(
  state: { notesVisible: boolean; chatFocused: boolean; currentTab: number },
  totalQuestions: number,
): ActiveView {
  if (state.notesVisible) return "notes";
  if (state.currentTab === totalQuestions) return "submit";
  if (state.chatFocused) return "chat";
  return "options";
}
