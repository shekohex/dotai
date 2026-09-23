import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { asRecord } from "../../utils/unknown-data.js";

export const OBSERVATIONAL_MEMORY_SETTINGS_KEY = "observationalMemory";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const ObservationalMemorySettingsSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    observeAfterTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    reflectAfterTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    observerChunkMaxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    compactAfterTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    compactAfterTokensMode: Type.Optional(
      Type.Union([Type.Literal("calibrated"), Type.Literal("ratio")]),
    ),
    compactAfterTokensRatio: Type.Optional(
      Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 }),
    ),
    observationsPoolMaxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    observationsPoolTargetTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    agentMaxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
    agentMaxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    model: Type.Optional(
      Type.Object(
        {
          provider: Type.String({ minLength: 1 }),
          id: Type.String({ minLength: 1 }),
          thinking: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)))),
        },
        { additionalProperties: false },
      ),
    ),
    fallbackModels: Type.Optional(
      Type.Array(
        Type.Object(
          {
            provider: Type.String({ minLength: 1 }),
            id: Type.String({ minLength: 1 }),
            thinking: Type.Optional(
              Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level))),
            ),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    showWorkerNotifications: Type.Optional(Type.Boolean()),
    passive: Type.Optional(Type.Boolean()),
    debugLog: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

export type ObservationalMemorySettings = Static<typeof ObservationalMemorySettingsSchema>;

/**
 * Default model for background memory workers (observer/reflector/dropper).
 *
 * Memory work is high-volume but low-stakes compression, so a fast cheap model is preferred over
 * the session model. Switch per project via settings:
 *
 * - `codex-openai/gpt-6-luna` (default) — fast, cheap, always-on summarization quality; the safest
 *   default for continuous observation.
 * - `zai/glm-5.3-flash` — cheapest useful option for high-frequency observing on long-running
 *   background threads.
 * - `opencode-go/deepseek-v4.1-flash` — stronger at dense technical transcripts (large refactors,
 *   migration sessions) where observation fidelity matters more than cost.
 */
export const defaultObservationalMemoryModel = {
  provider: "codex-openai",
  id: "gpt-6-luna",
  thinking: "medium",
} as const;

/**
 * Default fallback chain for background memory workers, tried in order when the primary memory
 * model is missing, unauthenticated, rate-limited, or down mid-call. The session model is always
 * the implicit final resort.
 *
 * - `zai/glm-5.3-flash` — cheapest useful option for high-frequency observing on long-running
 *   background threads.
 * - `opencode-go/deepseek-v4.1-flash` — stronger at dense technical transcripts (large refactors,
 *   migration sessions) where observation fidelity matters more than cost.
 */
export const defaultObservationalMemoryFallbackModels = [
  { provider: "zai", id: "glm-5.3-flash" },
  { provider: "opencode-go", id: "deepseek-v4.1-flash" },
] as const;

/**
 * Default observational-memory settings. Each key maps 1:1 to the `observationalMemory` namespace
 * in settings.json; see the schema above for the accepted shapes.
 *
 * - `observeAfterTokens` — raw/source tokens accumulated after the latest observation coverage before
 *   the observer wakes up. Lower = finer-grained memory, higher API usage. 10,000 keeps memory work
 *   a step behind the conversation without lagging.
 * - `reflectAfterTokens` — raw/source tokens since the last reflection before the reflector distills
 *   durable facts. 20,000 lets observations accumulate so patterns are reflected, not echoed.
 * - `observerChunkMaxTokens` — optional hard cap on the serialized observer chunk. Unset by default:
 *   the cap derives from the memory model's context window.
 * - `compactAfterTokens` — estimated source-entry tokens after the last compaction boundary before
 *   proactive compaction triggers (used directly in `"calibrated"` mode, as fallback in `"ratio"`
 *   mode). 81,000 suits typical ~128K-200K models.
 * - `compactAfterTokensMode` — `"calibrated"` uses `compactAfterTokens` as-is; `"ratio"` scales the
 *   threshold to `contextWindow * compactAfterTokensRatio`.
 * - `compactAfterTokensRatio` — fraction of the model's context window used as the proactive
 *   compaction threshold in `"ratio"` mode. 0.68 leaves room for the response on models that stay
 *   sharp at long range.
 * - `observationsPoolMaxTokens` — active observation pool size at which compaction performs a full
 *   fold (re-applying reflections and drops), keeping the summary bounded. 20,000 tokens is a
 *   comfortable agent-visible memory budget.
 * - `observationsPoolTargetTokens` — dropper maintenance target: once the active pool exceeds it
 *   (after a successful reflection), the dropper prunes observations that are safely covered.
 *   Derived as half the pool max when unset/invalid.
 * - `agentMaxTurns` — tool-call round trips each background worker may use per run. 16 is enough for
 *   full-chunk coverage without runaway loops.
 * - `agentMaxTokens` — output token budget requested for worker loops, clamped to the model's own
 *   max. 32,000 covers worst-case observation batches.
 * - `model` — provider/id of the model running the background workers. Defaults to
 *   `codex-openai/gpt-5.6-luna`; alternatives: `zai/glm-5.3-flash` (cheapest, good for
 *   high-frequency observing) and `opencode-go/deepseek-v4.1-flash` (stronger on dense technical
 *   transcripts). `thinking` sets the worker thinking level; "low" keeps memory work cheap.
 * - `fallbackModels` — ordered fallback chain for the memory workers, tried in order when `model` is
 *   missing from the registry, has no usable credentials, or fails mid-call (rate limit, provider
 *   outage). Defaults to `zai/glm-5.3-flash` then `opencode-go/deepseek-v4.1-flash`; the session
 *   model is always the implicit final resort. Each entry accepts the same `{ provider, id,
 *   thinking? }` shape as `model`.
 * - `showWorkerNotifications` — surface observer/reflector/dropper activity and failures as UI
 *   notices. Useful visibility; disable for quieter sessions.
 * - `passive` — disable automatic memory workers and proactive compaction while keeping `/om`
 *   commands and `recall` available.
 * - `debugLog` — write structured om worker logs to `.pi/om-debug/` for diagnosis.
 */
export const defaultObservationalMemorySettings = {
  enabled: false,
  observeAfterTokens: 10_000,
  reflectAfterTokens: 20_000,
  compactAfterTokens: 81_000,
  compactAfterTokensMode: "calibrated",
  compactAfterTokensRatio: 0.68,
  observationsPoolMaxTokens: 20_000,
  observationsPoolTargetTokens: 10_000,
  agentMaxTurns: 16,
  agentMaxTokens: 32_000,
  model: defaultObservationalMemoryModel,
  fallbackModels: defaultObservationalMemoryFallbackModels,
  showWorkerNotifications: true,
  passive: false,
  debugLog: false,
} as const;

/**
 * Validate and extract the `observationalMemory` namespace from a parsed settings.json-shaped
 * record. Returns undefined when the namespace is absent or does not match the schema — callers
 * fall back to defaults.
 *
 * @param {unknown} raw Parsed contents of a settings.json file.
 * @returns {Partial<ObservationalMemorySettings> | undefined} The validated namespace settings, or
 *   undefined when absent/invalid.
 */
export function parseObservationalMemorySettings(
  raw: unknown,
): Partial<ObservationalMemorySettings> | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const namespace = record[OBSERVATIONAL_MEMORY_SETTINGS_KEY];
  if (namespace === undefined || namespace === null) return undefined;
  // JSON has no undefined: hand-edited files and UI writers use null for "not set". Drop null
  // fields instead of rejecting the whole namespace.
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(asRecord(namespace) ?? {})) {
    if (value !== null) cleaned[key] = value;
  }
  if (Object.keys(cleaned).length === 0) return undefined;
  if (!Value.Check(ObservationalMemorySettingsSchema, cleaned)) return undefined;
  return Value.Parse(ObservationalMemorySettingsSchema, cleaned);
}

export function readObservationalMemorySettingsFile(
  path: string,
): Partial<ObservationalMemorySettings> {
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parseObservationalMemorySettings(raw) ?? {};
  } catch {
    return {};
  }
}

export function getObservationalMemorySettings(): Partial<ObservationalMemorySettings> {
  return readObservationalMemorySettingsFile(join(getAgentDir(), "settings.json"));
}
