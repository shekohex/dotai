import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

import {
  defaultObservationalMemorySettings,
  getObservationalMemorySettings,
  readObservationalMemorySettingsFile,
  type ObservationalMemorySettings,
} from "./settings.js";

export interface ConfiguredModel {
  provider: string;
  id: string;
  thinking?: ModelThinkingLevel;
}

/**
 * How `compactAfterTokens` is interpreted.
 *
 * - `"calibrated"` (default): use the static `compactAfterTokens` value directly.
 * - `"ratio"`: compute the effective threshold as `floor(model.contextWindow *
 *   compactAfterTokensRatio)`, scaling the proactive compaction trigger to the active model's
 *   context window. When the context window is unavailable (undefined, 0, or negative), falls back
 *   to the calibrated `compactAfterTokens` value.
 */
export type CompactAfterTokensMode = "calibrated" | "ratio";

export interface Config {
  observeAfterTokens: number;
  reflectAfterTokens: number;
  /**
   * Maximum estimated source tokens serialized into a single observer chunk. Unset (default)
   * derives the cap from the resolved memory model's context window; see
   * {@link resolveObserverChunkMaxTokens}.
   */
  observerChunkMaxTokens?: number;
  compactAfterTokens: number;
  compactAfterTokensMode: CompactAfterTokensMode;
  compactAfterTokensRatio: number;
  observationsPoolMaxTokens: number;
  observationsPoolTargetTokens: number;
  agentMaxTurns: number;
  /**
   * Maximum output tokens requested for background memory-agent loops (observer/reflector/dropper).
   * Always clamped to the model's own `maxTokens` when available.
   */
  agentMaxTokens: number;
  model?: ConfiguredModel;
  /**
   * Ordered fallback chain for background memory workers. Tried in order when `model` is missing
   * from the registry, fails the auth gate, or errors mid-call (rate limit, provider outage). The
   * session model remains the implicit final resort after the chain is exhausted.
   */
  fallbackModels: ConfiguredModel[];
  showWorkerNotifications: boolean;
  passive: boolean;
  debugLog: boolean;
}

export const DEFAULTS: Config = {
  ...defaultObservationalMemorySettings,
  fallbackModels: [...defaultObservationalMemorySettings.fallbackModels],
};

/**
 * Resolve the effective proactive-compaction token threshold for the given config and active model
 * context window.
 *
 * In `"calibrated"` mode this is always `config.compactAfterTokens`.
 *
 * In `"ratio"` mode this is `floor(contextWindow * compactAfterTokensRatio)` (clamped to a minimum
 * of 1) when `contextWindow` is a positive number, and falls back to `config.compactAfterTokens`
 * otherwise.
 *
 * @param {Config} config Resolved om config.
 * @param {number | undefined} contextWindow Active model context window, when known.
 * @returns {number} The effective compaction threshold in estimated source tokens.
 */
export function resolveCompactAfterTokens(
  config: Config,
  contextWindow: number | undefined,
): number {
  if (
    config.compactAfterTokensMode === "ratio" &&
    typeof contextWindow === "number" &&
    contextWindow > 0
  ) {
    return Math.max(1, Math.floor(contextWindow * config.compactAfterTokensRatio));
  }
  return config.compactAfterTokens;
}

/** Observer chunk cap used when no config is set and the model's context window is unknown. */
export const OBSERVER_CHUNK_FALLBACK_MAX_TOKENS = 60_000;

/** Smallest useful observer chunk: enough for labels, omission markers, and source context. */
export const OBSERVER_CHUNK_MIN_TOKENS = 256;

/**
 * Fraction of the memory model's context window used for the derived observer chunk cap. Chunk
 * sizes are estimated at ~4 chars/token, which can undercount real tokens by up to ~4x on non-ASCII
 * content, so 0.2 keeps even the worst case at ~80% of the window with room left for the system
 * prompt, prior memory, and the response.
 */
export const OBSERVER_CHUNK_CONTEXT_RATIO = 0.2;

/**
 * Resolve the maximum estimated tokens the observer serializes into one chunk.
 *
 * An explicit `observerChunkMaxTokens` config value always wins. Otherwise the cap is
 * `floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO)` for the resolved memory model, falling back
 * to {@link OBSERVER_CHUNK_FALLBACK_MAX_TOKENS} when the context window is unavailable.
 *
 * Without a cap, a backlog that outgrows the model's context window (e.g. after repeated observer
 * failures, or when the extension is enabled mid-way into a long session) makes every observer call
 * fail, so coverage never advances and the session can never recover. With the cap, oversized
 * backlogs are drained oldest-first across successive runs.
 *
 * @param {Config} config Resolved om config.
 * @param {number | undefined} contextWindow Resolved memory model context window, when known.
 * @returns {number} The maximum estimated token size of a single observer chunk.
 */
export function resolveObserverChunkMaxTokens(
  config: Config,
  contextWindow: number | undefined,
): number {
  if (config.observerChunkMaxTokens !== undefined && config.observerChunkMaxTokens > 0) {
    return Math.max(OBSERVER_CHUNK_MIN_TOKENS, config.observerChunkMaxTokens);
  }
  if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
    return Math.max(
      OBSERVER_CHUNK_MIN_TOKENS,
      Math.floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO),
    );
  }
  return OBSERVER_CHUNK_FALLBACK_MAX_TOKENS;
}

const PASSIVE_ENV = "PI_OBSERVATIONAL_MEMORY_PASSIVE";

function derivedObservationPoolTarget(maxTokens: number): number {
  return Math.floor(maxTokens / 2);
}

function isCompactAfterTokensMode(value: unknown): value is CompactAfterTokensMode {
  return value === "calibrated" || value === "ratio";
}

/**
 * Settings-file values that the TypeBox schema accepts but the runtime Config rejects or derives:
 * the pool target must stay below the pool max, and the configured model must not carry empty
 * identifiers.
 *
 * @param {Partial<ObservationalMemorySettings>} settings Schema-validated settings namespace.
 * @returns {Partial<Config>} Settings narrowed to the runtime Config shape.
 */
function normalizePartialSettings(settings: Partial<ObservationalMemorySettings>): Partial<Config> {
  const normalized: Partial<Config> = { ...settings };

  const configuredModel = normalized.model;
  if (configuredModel) {
    const model: ConfiguredModel = {
      provider: configuredModel.provider,
      id: configuredModel.id,
      ...(configuredModel.thinking ? { thinking: configuredModel.thinking } : {}),
    };
    normalized.model = model;
  }
  if (!isCompactAfterTokensMode(normalized.compactAfterTokensMode)) {
    delete normalized.compactAfterTokensMode;
  }
  return normalized;
}

/**
 * Read the `PI_OBSERVATIONAL_MEMORY_PASSIVE` override. Accepts the usual truthy/falsy spellings.
 *
 * @param {NodeJS.ProcessEnv} env Process environment (overridable for tests).
 * @returns {Partial<Config>} A partial passive override, or an empty object when unset.
 */
export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): Partial<Config> {
  const rawPassive = env[PASSIVE_ENV];
  if (rawPassive === undefined) return {};
  const passive = rawPassive.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(passive)) return { passive: true };
  if (["0", "false", "no", "off"].includes(passive)) return { passive: false };
  return {};
}

/**
 * Accept a configured pool target only when it stays below the pool max.
 *
 * @param {number | undefined} value Configured pool target.
 * @param {number} maxTokens Configured pool max.
 * @returns {number | undefined} The validated target, or undefined when unconfigured/invalid.
 */
function validTargetOrUndefined(value: number | undefined, maxTokens: number): number | undefined {
  return value !== undefined && value < maxTokens ? value : undefined;
}

/**
 * Load the effective om config: global settings (`observationalMemory` namespace in the agent
 * settings.json), then project-local `.pi/settings.json`, then the passive env override. The
 * observation pool target defaults to half the pool max unless configured below it.
 *
 * @param {string} cwd Project directory used for the local `.pi/settings.json` override.
 * @param {NodeJS.ProcessEnv} env Process environment (overridable for tests).
 * @returns {Config} The fully resolved config.
 */
export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Config {
  const globalConfig = normalizePartialSettings(getObservationalMemorySettings());
  const projectConfig = normalizePartialSettings(
    readObservationalMemorySettingsFile(join(cwd, ".pi", "settings.json")),
  );
  const envConfig = readEnvConfig(env);
  const merged = {
    ...DEFAULTS,
    observationsPoolTargetTokens: undefined,
    ...globalConfig,
    ...projectConfig,
    ...envConfig,
  };
  const target =
    validTargetOrUndefined(merged.observationsPoolTargetTokens, merged.observationsPoolMaxTokens) ??
    derivedObservationPoolTarget(merged.observationsPoolMaxTokens);

  return {
    ...merged,
    observationsPoolTargetTokens: target,
  };
}
