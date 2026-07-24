import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { getAgentRuntime } from "../interview/settings.js";

const LiveDiagnosticEntrySchema = Type.Object({
  timestamp: Type.String(),
  event: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  details: Type.Record(Type.String(), Type.Unknown()),
});

type LiveDiagnosticEntry = Static<typeof LiveDiagnosticEntrySchema>;

export const LIVE_DIAGNOSTIC_LOG_PATH = join(getAgentRuntime(), "logs", "live.jsonl");

let writeTail: Promise<void> = Promise.resolve();

/**
 * Appends redacted Pi Live diagnostics without delaying session work.
 *
 * @param {string} sessionId Active Pi session identifier.
 * @param {string} event Diagnostic event name.
 * @param {Record<string, unknown>} details Redacted event metadata.
 * @returns {void}
 */
export function appendLiveDiagnostic(
  sessionId: string,
  event: string,
  details: Record<string, unknown>,
): void {
  const entry = Value.Parse(LiveDiagnosticEntrySchema, {
    timestamp: new Date().toISOString(),
    event,
    sessionId,
    details,
  }) satisfies LiveDiagnosticEntry;
  writeTail = writeTail
    .then(async () => {
      await mkdir(dirname(LIVE_DIAGNOSTIC_LOG_PATH), { recursive: true });
      await appendFile(LIVE_DIAGNOSTIC_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
    })
    .catch(() => {});
}
