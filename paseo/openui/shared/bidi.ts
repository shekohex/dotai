import { detectDirection } from "./direction";

const STRONG_LETTER = /\p{L}/u;
const STRING_LITERAL = /"((?:[^"\\]|\\.)*)"/g;

/** Direction of the whole UI, read from the strings in its program, not from component names. */
export function programIsRtl(source: string): boolean {
  const strings = [...source.matchAll(STRING_LITERAL)].map((match) => match[1] ?? "").join(" ");
  return detectDirection(strings) === "rtl";
}

export interface Bidi {
  /** Text styles for one block: layout direction, writing direction and alignment. */
  text(content: string): {
    direction: "ltr" | "rtl";
    writingDirection: "ltr" | "rtl";
    textAlign: "left" | "right";
  };
  /** Layout direction for a row whose label is `content`, so icons and markers sit on the reading side. */
  row(content: string): { direction: "ltr" | "rtl" };
}

function directionOf(content: string, fallbackRtl: boolean): "ltr" | "rtl" {
  // Digits and symbols carry no direction of their own, so they follow the surrounding UI.
  if (!STRONG_LETTER.test(content)) return fallbackRtl ? "rtl" : "ltr";
  return detectDirection(content);
}

export function createBidi(fallbackRtl: boolean): Bidi {
  return {
    text(content) {
      const direction = directionOf(content, fallbackRtl);
      return {
        direction,
        writingDirection: direction,
        textAlign: direction === "rtl" ? "right" : "left",
      };
    },
    row(content) {
      return { direction: directionOf(content, fallbackRtl) };
    },
  };
}

/** Code, paths and URLs read left to right whatever language surrounds them. */
export const LTR_TEXT = { direction: "ltr", writingDirection: "ltr", textAlign: "left" } as const;
