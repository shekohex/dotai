import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { getAgentRuntime } from "../interview/settings.js";
import type {
  BatchingMode,
  ContextPruneConfig,
  ContextPruneToolsConfig,
  PruneOn,
  SummarizerThinking,
} from "./types.js";
import {
  BATCHING_MODES,
  DEFAULT_CONFIG,
  PRUNE_ON_MODES,
  SUMMARIZER_THINKING_LEVELS,
} from "./types.js";
import {
  ContextPruneConfigFileSchema,
  ContextPruneToolsConfigFileSchema,
  type ContextPruneConfigFile,
} from "./schema.js";

export const SETTINGS_PATH = join(getAgentRuntime(), "settings.json");
const SETTINGS_KEY = "contextPrune";

const SettingsFileSchema = Type.Record(Type.String(), Type.Unknown());
const AgentSettingsSchema = Type.Object({
  contextPrune: Type.Optional(ContextPruneConfigFileSchema),
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

function resolveToolsConfig(value: unknown): ContextPruneToolsConfig {
  if (!Value.Check(ContextPruneToolsConfigFileSchema, value)) {
    return { ...DEFAULT_CONFIG.tools };
  }
  return Value.Parse(ContextPruneToolsConfigFileSchema, value);
}

export async function loadConfig(): Promise<ContextPruneConfig> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const contextPruneSettings = Value.Check(AgentSettingsSchema, parsed)
      ? Value.Parse(AgentSettingsSchema, parsed).contextPrune
      : undefined;
    const existing: ContextPruneConfigFile = Value.Check(
      ContextPruneConfigFileSchema,
      contextPruneSettings,
    )
      ? Value.Parse(ContextPruneConfigFileSchema, contextPruneSettings)
      : {};
    const merged = { ...DEFAULT_CONFIG, ...existing };
    const config = {
      ...merged,
      enabled: typeof merged.enabled === "boolean" ? merged.enabled : DEFAULT_CONFIG.enabled,
      tools: resolveToolsConfig(merged.tools),
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
      minRawCharsToPrune: Number.isFinite(merged.minRawCharsToPrune)
        ? Math.max(0, merged.minRawCharsToPrune)
        : DEFAULT_CONFIG.minRawCharsToPrune,
    };
    if (contextPruneSettings !== undefined && existing.tools === undefined) {
      await saveConfig(config);
    }
    return config;
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
