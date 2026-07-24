import { francAll } from "franc-min";

const MIN_LANGUAGE_SAMPLE_LENGTH = 32;
const ENGLISH_ACCEPTANCE_SCORE = 0.85;
const NON_LATIN_SCRIPT_PATTERN =
  /[\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Devanagari}\p{Script=Han}\p{Script=Hangul}\p{Script=Hebrew}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/gu;
const LETTER_PATTERN = /\p{Letter}/gu;

interface DelegationLanguageAssessmentBase {
  detectedLanguage: string;
  englishScore?: number;
}

export type DelegationLanguageAssessment = DelegationLanguageAssessmentBase &
  (
    | { accepted: true; reason: "english" | "short-ambiguous" }
    | { accepted: false; reason: "non-latin-prose" | "non-english" }
  );

function characterCount(value: string, pattern: RegExp): number {
  return Array.from(value.matchAll(pattern)).length;
}

/**
 * Determines whether a live-model delegation is safe to send to the English-only AgentSession.
 * Short ASCII tasks are accepted because trigram detectors are unreliable for commands such as "Run
 * git status". Non-Latin prose and confidently non-English longer tasks are rejected.
 *
 * @param {string} request Delegation text authored by the live model.
 * @returns {DelegationLanguageAssessment} Language decision used at the AgentSession boundary.
 */
export function assessDelegationLanguage(request: string): DelegationLanguageAssessment {
  const normalized = request.normalize("NFKC").trim();
  const letters = characterCount(normalized, LETTER_PATTERN);
  const nonLatinLetters = characterCount(normalized, NON_LATIN_SCRIPT_PATTERN);
  const nonLatinRatio = letters === 0 ? 0 : nonLatinLetters / letters;
  const ranked = francAll(normalized, { minLength: 3 });
  const detectedLanguage = ranked[0]?.[0] ?? "und";
  const englishScore = ranked.find(([language]) => language === "eng")?.[1];

  if (nonLatinRatio >= 0.25) {
    return {
      accepted: false,
      detectedLanguage,
      ...(englishScore === undefined ? {} : { englishScore }),
      reason: "non-latin-prose",
    };
  }

  if (normalized.length < MIN_LANGUAGE_SAMPLE_LENGTH) {
    return {
      accepted: true,
      detectedLanguage,
      ...(englishScore === undefined ? {} : { englishScore }),
      reason: "short-ambiguous",
    };
  }

  if (detectedLanguage === "eng" || (englishScore ?? 0) >= ENGLISH_ACCEPTANCE_SCORE) {
    return {
      accepted: true,
      detectedLanguage,
      ...(englishScore === undefined ? {} : { englishScore }),
      reason: "english",
    };
  }

  return {
    accepted: false,
    detectedLanguage,
    ...(englishScore === undefined ? {} : { englishScore }),
    reason: "non-english",
  };
}

function comparableSpeech(value: string): string {
  return value.normalize("NFKC").replaceAll(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

/**
 * Describes whether the live model copied the current transcript or synthesized a new task.
 *
 * @param {string} request Delegation text authored by the live model.
 * @param {string} transcript Current coalesced user transcript.
 * @returns {"verbatim" | "synthesized" | "unknown"} Relationship shown in diagnostics and UI.
 */
export function delegationTranscriptRelation(
  request: string,
  transcript: string,
): "verbatim" | "synthesized" | "unknown" {
  const comparableRequest = comparableSpeech(request);
  const comparableTranscript = comparableSpeech(transcript);
  if (comparableTranscript.length === 0) return "unknown";
  return comparableRequest === comparableTranscript ? "verbatim" : "synthesized";
}
