export type TextDirection = "ltr" | "rtl";

const ARABIC_LETTER =
  /(?=\p{L})[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u;
const LATIN_LETTER = /(?=\p{L})[A-Za-z\u00C0-\u024F]/u;
const CODE_SPAN = /```[\s\S]*?```|`[^`\n]*`/g;

type Script = "arabic" | "latin";

function scriptOfLetter(char: string): Script | null {
  if (ARABIC_LETTER.test(char)) return "arabic";
  if (LATIN_LETTER.test(char)) return "latin";
  return null;
}

/** A token containing any Arabic letter counts as Arabic, so "الـdeps" is not a Latin word. */
function scriptOfToken(token: string): Script | null {
  let hasLatin = false;
  for (const char of token) {
    const script = scriptOfLetter(char);
    if (script === "arabic") return "arabic";
    if (script === "latin") hasLatin = true;
  }
  return hasLatin ? "latin" : null;
}

function firstStrongScript(text: string): Script | null {
  for (const char of text) {
    const script = scriptOfLetter(char);
    if (script) return script;
  }
  return null;
}

/**
 * Base direction of one block of text: first strong letter wins when it is Arabic; otherwise
 * Arabic wins when Arabic words outnumber Latin words. Code spans are ignored.
 *
 * The majority rule counts whitespace-separated words, not letters: Latin identifiers are long,
 * so letter counts make "useEffect بيعمل re-render لما الـ deps تتغير" look Latin.
 */
export function detectDirection(text: string): TextDirection {
  const prose = text.replace(CODE_SPAN, " ");
  if (firstStrongScript(prose) === "arabic") return "rtl";
  let arabicWords = 0;
  let latinWords = 0;
  for (const token of prose.split(/\s+/)) {
    const script = scriptOfToken(token);
    if (script === "arabic") arabicWords += 1;
    else if (script === "latin") latinWords += 1;
  }
  return arabicWords > latinWords ? "rtl" : "ltr";
}
