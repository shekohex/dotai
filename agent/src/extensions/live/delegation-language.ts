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
