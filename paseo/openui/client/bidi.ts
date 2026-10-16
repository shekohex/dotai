import { type Bidi, createBidi } from "../shared/bidi";
import { useUiEnv } from "./tokens";

export { createBidi, LTR_TEXT, programIsRtl } from "../shared/bidi";

/** Bidi helpers that fall back to the direction of the whole UI for text with no letters. */
export function useBidi(): Bidi {
  return createBidi(useUiEnv().rtl);
}
