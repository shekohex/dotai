import { Type, type Static } from "typebox";

/** Voices currently accepted by the Codex Live signaling surface. */
export const LIVE_VOICES = [
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "cove",
] as const;

export const LiveVoiceSchema = Type.Union([
  Type.Literal("juniper"),
  Type.Literal("maple"),
  Type.Literal("spruce"),
  Type.Literal("ember"),
  Type.Literal("vale"),
  Type.Literal("breeze"),
  Type.Literal("arbor"),
  Type.Literal("sol"),
  Type.Literal("cove"),
]);

export type LiveVoice = Static<typeof LiveVoiceSchema>;

/**
 * Normalizes a user-facing voice name and rejects unsupported values.
 *
 * @param {string} voice User-facing voice name.
 * @returns {LiveVoice} Lowercase Codex Live voice identifier.
 */
export function normalizeLiveVoiceName(voice: string): LiveVoice {
  const normalized = voice.trim().toLowerCase();
  const migrated = normalized === "onyx" ? "sol" : normalized;
  switch (migrated) {
    case "juniper":
    case "maple":
    case "spruce":
    case "ember":
    case "vale":
    case "breeze":
    case "arbor":
    case "sol":
    case "cove":
      return migrated;
    default:
      throw new Error(`Unsupported Pi Live voice: ${voice}`);
  }
}
