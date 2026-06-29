import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { getAgentRuntime } from "../interview/settings.js";

export const SessionArchiveSettingsSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    maxAgeDays: Type.Optional(Type.Number({ minimum: 1 })),
  },
  { additionalProperties: true },
);

const AgentSettingsSchema = Type.Object(
  {
    sessionArchive: Type.Optional(SessionArchiveSettingsSchema),
  },
  { additionalProperties: true },
);

export type SessionArchiveSettings = Required<Static<typeof SessionArchiveSettingsSchema>>;

export const defaultSessionArchiveSettings = {
  enabled: true,
  maxAgeDays: 7,
} as const satisfies SessionArchiveSettings;

export function getSessionArchiveSettings(): SessionArchiveSettings {
  const settingsPath = join(getAgentRuntime(), "settings.json");
  if (!existsSync(settingsPath)) return defaultSessionArchiveSettings;
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
  if (!Value.Check(AgentSettingsSchema, parsed)) return defaultSessionArchiveSettings;
  const settings = Value.Parse(AgentSettingsSchema, parsed).sessionArchive;
  if (settings === undefined) return defaultSessionArchiveSettings;
  return { ...defaultSessionArchiveSettings, ...settings };
}
