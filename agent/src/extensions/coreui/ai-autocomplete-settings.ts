import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { errorMessage } from "../../utils/error-message.js";
import { isRecord } from "../../utils/unknown-data.js";
import { getAgentRuntime } from "../interview/settings.js";

export const AiAutocompleteSettingsSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    backend: Type.Optional(Type.Union([Type.Literal("pi-ai")])),
    mode: Type.Optional(Type.Union([Type.Literal("eager"), Type.Literal("lazy")])),
    models: Type.Optional(Type.Array(Type.String())),
    debounceMs: Type.Optional(Type.Number()),
    timeoutMs: Type.Optional(Type.Number()),
    minInputChars: Type.Optional(Type.Number()),
    maxPrefixChars: Type.Optional(Type.Number()),
    maxSuffixChars: Type.Optional(Type.Number()),
    maxTokens: Type.Optional(Type.Number()),
    temperature: Type.Optional(Type.Number()),
    includeAssistantSummary: Type.Optional(Type.Boolean()),
    maxAssistantSummaryChars: Type.Optional(Type.Number()),
    promptFormat: Type.Optional(
      Type.Union([Type.Literal("zeta-inspired-next-edit"), Type.Literal("fim-chat")]),
    ),
  },
  { additionalProperties: true },
);

const SettingsFileSchema = Type.Record(Type.String(), Type.Unknown());
const SETTINGS_KEY = "aiAutocomplete";

export type AiAutocompleteSettings = Required<
  Omit<Static<typeof AiAutocompleteSettingsSchema>, "models">
> & {
  models: string[];
};

export const defaultAiAutocompleteSettings = {
  enabled: true,
  backend: "pi-ai",
  mode: "lazy",
  models: [
    "gemini/gemini-2.5-flash-lite",
    "deepseek/deepseek-v4-flash",
    "opencode-go/deepseek-v4-flash",
  ],
  debounceMs: 350,
  timeoutMs: 2500,
  minInputChars: 8,
  maxPrefixChars: 4000,
  maxSuffixChars: 1200,
  maxTokens: 48,
  temperature: 0,
  includeAssistantSummary: true,
  maxAssistantSummaryChars: 2000,
  promptFormat: "zeta-inspired-next-edit",
} as const satisfies AiAutocompleteSettings;

export function getAiAutocompleteSettings(): AiAutocompleteSettings {
  const settingsPath = join(getAgentRuntime(), "settings.json");
  if (!existsSync(settingsPath)) return { ...defaultAiAutocompleteSettings };

  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
  const settings = isRecord(parsed) ? parsed.aiAutocomplete : undefined;
  return parseAiAutocompleteSettings(settings);
}

export function parseAiAutocompleteSettings(settings: unknown): AiAutocompleteSettings {
  if (!isRecord(settings)) return { ...defaultAiAutocompleteSettings };
  try {
    const parsed = Value.Parse(AiAutocompleteSettingsSchema, settings);
    return {
      ...defaultAiAutocompleteSettings,
      ...parsed,
      models: parsed.models ?? [...defaultAiAutocompleteSettings.models],
    };
  } catch (error) {
    console.warn(
      `Invalid aiAutocomplete settings; disabling AI autocomplete. ${errorMessage(error)}`,
    );
    return { ...defaultAiAutocompleteSettings, enabled: false, models: [] };
  }
}

export async function saveAiAutocompleteSettings(settings: AiAutocompleteSettings): Promise<void> {
  const settingsPath = join(getAgentRuntime(), "settings.json");
  const existing = await readSettingsFile(settingsPath);
  const nextSettings = {
    ...existing,
    [SETTINGS_KEY]: settings,
  };
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf-8");
}

async function readSettingsFile(settingsPath: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath, "utf-8"));
    if (!Value.Check(SettingsFileSchema, parsed)) {
      throw new Error(`Settings file must be a JSON object: ${settingsPath}`);
    }
    return parsed;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }
}
