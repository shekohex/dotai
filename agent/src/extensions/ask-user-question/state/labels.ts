import { ROW_INTENT_META, type SentinelKind } from "./row-intent.js";

// Centralized English UI copy. Keep copied call sites small without carrying
// localization infrastructure this wrapper does not use.
export const uiText = (_key: string, fallback: string): string => fallback;

export function displayLabel(kind: SentinelKind): string {
  return ROW_INTENT_META[kind].label;
}
