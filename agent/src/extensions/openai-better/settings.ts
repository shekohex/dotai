import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { getAgentRuntime } from "../interview/settings.js";

export const openAIBetterSettingsSchema = Type.Object({
  fast: Type.Object({
    persistState: Type.Boolean(),
    enabled: Type.Boolean(),
    supportedModels: Type.Array(Type.String()),
  }),
  image: Type.Object({
    enabled: Type.Boolean(),
    defaultModel: Type.String(),
    defaultSave: Type.Union([
      Type.Literal("none"),
      Type.Literal("project"),
      Type.Literal("global"),
      Type.Literal("custom"),
    ]),
    outputFormat: Type.Union([Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")]),
    timeoutMs: Type.Number(),
  }),
});

const AgentSettingsSchema = Type.Object({
  openaiBetter: Type.Optional(openAIBetterSettingsSchema),
});

export type OpenAIBetterSettings = Static<typeof openAIBetterSettingsSchema>;

export const defaultOpenAIBetterSettings = {
  fast: {
    persistState: true,
    enabled: false,
    supportedModels: [
      "codex-openai/gpt-5.4",
      "codex-openai/gpt-5.5",
      "codex-openai/gpt-5.4-mini",
      "codex-openai/gpt-5.5-mini",
    ],
  },
  image: {
    enabled: false,
    defaultModel: "gpt-5.5",
    defaultSave: "project",
    outputFormat: "png",
    timeoutMs: 360_000,
  },
} as const satisfies OpenAIBetterSettings;

function settingsPath(): string {
  return join(getAgentRuntime(), "settings.json");
}

export function getOpenAIBetterSettings(): OpenAIBetterSettings {
  const path = settingsPath();
  if (!existsSync(path)) return defaultOpenAIBetterSettings;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!Value.Check(AgentSettingsSchema, parsed)) return defaultOpenAIBetterSettings;
  return Value.Parse(AgentSettingsSchema, parsed).openaiBetter ?? defaultOpenAIBetterSettings;
}

export function parseSupportedModelKey(
  value: string,
): { provider: string; id: string } | undefined {
  const key = value.trim();
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return undefined;
  const provider = key.slice(0, slash).trim();
  const id = key.slice(slash + 1).trim();
  return provider.length > 0 && id.length > 0 ? { provider, id } : undefined;
}
