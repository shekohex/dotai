const LONG_TRANSCRIPT_DURATION_MS = 55_000;
const LONG_TRANSCRIPT_WORDS = 100;
const LONG_TRANSCRIPT_CHARACTERS = 700;
const MAX_CONVERSATION_CONTEXT_BYTES = 32 * 1024;
const WORD_PATTERN = /[\p{Letter}\p{Number}][\p{Letter}\p{Mark}\p{Number}'’-]*/gu;

interface LiveConversationEntry {
  role: "user" | "assistant";
  turn: number;
  text: string;
}

export interface AcceptedLiveDelegation {
  conversationContext: string;
}

export interface LiveTranscriptContext {
  text: string;
  sourceCharacters: number;
}

/** Tracks bounded voice context and suppresses repeated active delegations. */
export class LiveConversationTracker {
  readonly #delegationIds = new Set<string>();
  readonly #outstandingDelegations = new Map<string, string>();
  readonly #outstandingInputs = new Set<string>();
  #entries: LiveConversationEntry[] = [];
  #delegationsAwaitingUserFinish = 0;
  #userTranscriptOpen = false;

  updateTranscript(
    role: LiveConversationEntry["role"],
    turn: number,
    transcript: string,
    final = false,
  ): void {
    const text = transcript.trim();
    if (text.length === 0) return;
    if (role === "user") {
      this.#userTranscriptOpen = !final;
      if (final && this.#delegationsAwaitingUserFinish > 0) {
        this.#delegationsAwaitingUserFinish -= 1;
        return;
      }
    }
    const existingIndex = this.#entries.findIndex(
      (entry) => entry.role === role && entry.turn === turn,
    );
    const entry = { role, turn, text } satisfies LiveConversationEntry;
    if (existingIndex === -1) this.#entries.push(entry);
    else this.#entries[existingIndex] = entry;
    this.#boundEntries();
  }

  acceptDelegation(input: string, delegationId: string): AcceptedLiveDelegation | undefined {
    const normalized = input.trim();
    if (normalized.length === 0 || this.#delegationIds.has(delegationId)) return undefined;
    this.#delegationIds.add(delegationId);
    if (this.#delegationIds.size > 128) {
      const oldestDelegationId = this.#delegationIds.values().next().value;
      if (oldestDelegationId !== undefined) this.#delegationIds.delete(oldestDelegationId);
    }
    if (this.#outstandingInputs.has(normalized)) return undefined;
    this.#outstandingDelegations.set(delegationId, normalized);
    this.#outstandingInputs.add(normalized);
    const hasUserTranscript = this.#entries.some((entry) => entry.role === "user");
    if (this.#userTranscriptOpen || !hasUserTranscript) this.#delegationsAwaitingUserFinish += 1;
    if (!this.#entries.some((entry) => entry.role === "user" && entry.text === normalized)) {
      this.#entries.push({ role: "user", turn: Number.MAX_SAFE_INTEGER, text: normalized });
      this.#boundEntries();
    }
    const conversationContext = this.#renderEntries();
    this.#entries = [];
    return { conversationContext };
  }

  settleDelegation(delegationId: string): void {
    const input = this.#outstandingDelegations.get(delegationId);
    if (input === undefined) return;
    this.#outstandingDelegations.delete(delegationId);
    this.#outstandingInputs.delete(input);
  }

  reset(): void {
    this.#entries = [];
    this.#delegationIds.clear();
    this.#outstandingDelegations.clear();
    this.#outstandingInputs.clear();
    this.#delegationsAwaitingUserFinish = 0;
    this.#userTranscriptOpen = false;
  }

  #boundEntries(): void {
    this.#entries = this.#entries.filter(
      (entry) =>
        Buffer.byteLength(`${entry.role}: ${entry.text}`) <= MAX_CONVERSATION_CONTEXT_BYTES,
    );
    while (
      this.#entries.length > 0 &&
      Buffer.byteLength(this.#renderEntries()) > MAX_CONVERSATION_CONTEXT_BYTES
    ) {
      this.#entries.shift();
    }
  }

  #renderEntries(): string {
    return this.#entries.map((entry) => `${entry.role}: ${entry.text}`).join("\n");
  }
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
 * Preserves a complete long transcript verbatim for coordinator context.
 *
 * @param {string} transcript Complete current spoken transcript.
 * @param {number} durationMs Approximate duration of the spoken turn.
 * @returns {LiveTranscriptContext | undefined} Complete execution context when long.
 */
export function prepareLongTranscriptContext(
  transcript: string,
  durationMs: number,
): LiveTranscriptContext | undefined {
  const normalized = transcript.trim();
  if (!isLongLiveTranscript(normalized, durationMs)) return undefined;
  return {
    text: normalized,
    sourceCharacters: normalized.length,
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
  return `${task.trim()}\n\n<full-voice-transcript>\nComplete spoken transcript in the user's original language. Preserve and use every relevant detail below; do not treat the concise task above as the complete context.\n\n${transcript.text}\n</full-voice-transcript>`;
}
