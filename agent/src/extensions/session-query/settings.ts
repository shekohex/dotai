import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { getAgentRuntime } from "../interview/settings.js";

export const SessionQuerySettingsSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

const AgentSettingsSchema = Type.Object(
  {
    sessionQuery: Type.Optional(SessionQuerySettingsSchema),
  },
  { additionalProperties: true },
);

export type SessionQuerySettings = Required<Static<typeof SessionQuerySettingsSchema>>;

export const defaultSessionQuerySettings = {
  enabled: false,
} as const satisfies SessionQuerySettings;

export function getSessionQuerySettings(): SessionQuerySettings {
  const settingsPath = join(getAgentRuntime(), "settings.json");
  if (!existsSync(settingsPath)) return defaultSessionQuerySettings;
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
  if (!Value.Check(AgentSettingsSchema, parsed)) return defaultSessionQuerySettings;
  const settings = Value.Parse(AgentSettingsSchema, parsed).sessionQuery;
  if (settings === undefined) return defaultSessionQuerySettings;
  return { ...defaultSessionQuerySettings, ...settings };
}
