import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { getAgentRuntime } from "../interview/settings.js";
import type { BatchingMode, ContextPruneConfig, PruneOn, SummarizerThinking } from "./types.js";
import {
  BATCHING_MODES,
  DEFAULT_CONFIG,
  PRUNE_ON_MODES,
  SUMMARIZER_THINKING_LEVELS,
} from "./types.js";

export const SETTINGS_PATH = join(getAgentRuntime(), "settings.json");
const SETTINGS_KEY = "contextPrune";

const ConfigFileSchema = Type.Partial(
  Type.Object({
    enabled: Type.Boolean(),
    showPruneStatusLine: Type.Boolean(),
    summarizerModels: Type.Array(Type.String()),
    summarizerThinking: Type.Union(
      SUMMARIZER_THINKING_LEVELS.map((level) => Type.Literal(level.value)),
    ),
    pruneOn: Type.Union(PRUNE_ON_MODES.map((mode) => Type.Literal(mode.value))),
    remindUnprunedCount: Type.Boolean(),
    batchingMode: Type.Union(BATCHING_MODES.map((mode) => Type.Literal(mode.value))),
  }),
);

type ConfigFile = Static<typeof ConfigFileSchema>;

const SettingsFileSchema = Type.Record(Type.String(), Type.Unknown());
const AgentSettingsSchema = Type.Object({
  contextPrune: Type.Optional(ConfigFileSchema),
});

function isPruneOn(value: unknown): value is PruneOn {
  return typeof value === "string" && PRUNE_ON_MODES.some((mode) => mode.value === value);
}

function isSummarizerThinking(value: unknown): value is SummarizerThinking {
  return (
    typeof value === "string" && SUMMARIZER_THINKING_LEVELS.some((level) => level.value === value)
  );
}

function isBatchingMode(value: unknown): value is BatchingMode {
  return typeof value === "string" && BATCHING_MODES.some((mode) => mode.value === value);
}

export async function loadConfig(): Promise<ContextPruneConfig> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const existing: ConfigFile = Value.Check(AgentSettingsSchema, parsed)
      ? (Value.Parse(AgentSettingsSchema, parsed).contextPrune ?? {})
      : {};
    const merged: ContextPruneConfig = { ...DEFAULT_CONFIG, ...existing };
    return {
      ...merged,
      enabled: typeof merged.enabled === "boolean" ? merged.enabled : DEFAULT_CONFIG.enabled,
      showPruneStatusLine:
        typeof merged.showPruneStatusLine === "boolean"
          ? merged.showPruneStatusLine
          : DEFAULT_CONFIG.showPruneStatusLine,
      pruneOn: isPruneOn(merged.pruneOn) ? merged.pruneOn : DEFAULT_CONFIG.pruneOn,
      summarizerThinking: isSummarizerThinking(merged.summarizerThinking)
        ? merged.summarizerThinking
        : DEFAULT_CONFIG.summarizerThinking,
      summarizerModels: Array.isArray(merged.summarizerModels)
        ? merged.summarizerModels.filter((modelName) => modelName.length > 0)
        : DEFAULT_CONFIG.summarizerModels,
      remindUnprunedCount:
        typeof merged.remindUnprunedCount === "boolean"
          ? merged.remindUnprunedCount
          : DEFAULT_CONFIG.remindUnprunedCount,
      batchingMode: isBatchingMode(merged.batchingMode)
        ? merged.batchingMode
        : DEFAULT_CONFIG.batchingMode,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: ContextPruneConfig): Promise<void> {
  const existing = await readSettingsFile();
  const nextSettings = {
    ...existing,
    [SETTINGS_KEY]: config,
  };
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf-8");
}

async function readSettingsFile(): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(SETTINGS_PATH, "utf-8"));
    return Value.Check(SettingsFileSchema, parsed) ? parsed : {};
  } catch {
    return {};
  }
}
