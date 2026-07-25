import { assessDelegationLanguage } from "./delegation-language.js";

const LONG_TRANSCRIPT_DURATION_MS = 55_000;
const LONG_TRANSCRIPT_WORDS = 100;
const LONG_TRANSCRIPT_CHARACTERS = 700;
const WORD_PATTERN = /[\p{Letter}\p{Number}][\p{Letter}\p{Mark}\p{Number}'’-]*/gu;

export interface TranslatedLiveTranscript {
  text: string;
  model: string;
}

export interface LiveTranscriptContext {
  text: string;
  sourceCharacters: number;
  sourceLanguage: string;
  translatedBy?: string;
}

/**
 * Returns true when a spoken turn is long enough that a concise delegation may lose context.
 *
 * @param {string} transcript Complete current spoken transcript.
 * @param {number} durationMs Approximate duration of the spoken turn.
 * @returns {boolean} Whether full transcript context should accompany the task.
 */
export function isLongLiveTranscript(transcript: string, durationMs: number): boolean {
  const normalized = transcript.trim();
  if (normalized.length === 0) return false;
  const words = Array.from(normalized.matchAll(WORD_PATTERN)).length;
  return (
    durationMs >= LONG_TRANSCRIPT_DURATION_MS ||
    words >= LONG_TRANSCRIPT_WORDS ||
    normalized.length >= LONG_TRANSCRIPT_CHARACTERS
  );
}

/**
 * Preserves a long English transcript verbatim or translates the entire non-English transcript.
 *
 * @param {string} transcript Complete current spoken transcript.
 * @param {number} durationMs Approximate duration of the spoken turn.
 * @param {(transcript: string) => Promise<TranslatedLiveTranscript>} translate Full translator.
 * @returns {Promise<LiveTranscriptContext | undefined>} Complete execution context when long.
 */
export async function prepareLongTranscriptContext(
  transcript: string,
  durationMs: number,
  translate: (transcript: string) => Promise<TranslatedLiveTranscript>,
): Promise<LiveTranscriptContext | undefined> {
  const normalized = transcript.trim();
  if (!isLongLiveTranscript(normalized, durationMs)) return undefined;
  const language = assessDelegationLanguage(normalized);
  if (language.accepted) {
    return {
      text: normalized,
      sourceCharacters: normalized.length,
      sourceLanguage: language.detectedLanguage,
    };
  }
  const translated = await translate(normalized);
  return {
    text: translated.text,
    sourceCharacters: normalized.length,
    sourceLanguage: language.detectedLanguage,
    translatedBy: translated.model,
  };
}

/**
 * Adds complete long-form voice context after the concise execution task.
 *
 * @param {string} task Concise English execution task.
 * @param {LiveTranscriptContext | undefined} transcript Optional complete transcript context.
 * @returns {string} Agent request containing both task and complete context.
 */
export function buildDelegationWithTranscriptContext(
  task: string,
  transcript: LiveTranscriptContext | undefined,
): string {
  if (transcript === undefined) return task.trim();
  const contextLabel =
    transcript.translatedBy === undefined
      ? "Complete spoken transcript"
      : "Complete English translation of the spoken transcript";
  return `${task.trim()}\n\n<full-voice-transcript>\n${contextLabel}. Preserve and use every relevant detail below; do not treat the concise task above as the complete context.\n\n${transcript.text}\n</full-voice-transcript>`;
}
