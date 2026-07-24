import { isUnknownRecord } from "../../utils/unknown-value.js";
import { configureLiveDiagnostics } from "./diagnostics.js";
import {
  setLiveDiagnosticsEnabled,
  setLiveInstructions,
  setLiveVoice,
} from "./settings.js";

function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * Applies a voice update received from the paired macOS client.
 *
 * @param {unknown} params Untrusted JSON-RPC setting parameters.
 * @returns {Record<string, unknown>} Setting acknowledgement sent to the client.
 */
export function applyLiveVoiceSetting(params: unknown): Record<string, unknown> {
  try {
    if (!isUnknownRecord(params) || typeof params.voice !== "string") {
      throw new Error("Voice setting is missing a voice");
    }
    return { voice: setLiveVoice(params.voice), saved: true, appliesTo: "next-session" };
  } catch (cause) {
    return { saved: false, message: errorFrom(cause).message };
  }
}

/**
 * Applies custom instructions received from the paired macOS client.
 *
 * @param {unknown} params Untrusted JSON-RPC setting parameters.
 * @returns {Record<string, unknown>} Setting acknowledgement sent to the client.
 */
export function applyLiveInstructionsSetting(params: unknown): Record<string, unknown> {
  try {
    if (!isUnknownRecord(params) || typeof params.instructions !== "string") {
      throw new Error("Instruction setting is missing instructions");
    }
    return {
      instructions: setLiveInstructions(params.instructions),
      saved: true,
      appliesTo: "next-session",
    };
  } catch (cause) {
    return { saved: false, message: errorFrom(cause).message };
  }
}

/**
 * Applies diagnostics logging state received from the paired macOS client.
 *
 * @param {unknown} params Untrusted JSON-RPC setting parameters.
 * @returns {Record<string, unknown>} Setting acknowledgement sent to the client.
 */
export function applyLiveDiagnosticsSetting(params: unknown): Record<string, unknown> {
  try {
    if (!isUnknownRecord(params) || typeof params.enabled !== "boolean") {
      throw new Error("Diagnostics setting is missing enabled state");
    }
    const enabled = setLiveDiagnosticsEnabled(params.enabled);
    configureLiveDiagnostics(enabled);
    return { enabled, saved: true, appliesTo: "current" };
  } catch (cause) {
    return { saved: false, message: errorFrom(cause).message };
  }
}
