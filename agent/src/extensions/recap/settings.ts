import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { getAgentRuntime } from "../interview/settings.js";

export const RecapSettingsSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    awayDelayMs: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: true },
);

const AgentSettingsSchema = Type.Object(
  {
    recap: Type.Optional(RecapSettingsSchema),
  },
  { additionalProperties: true },
);

export type RecapSettings = Required<Static<typeof RecapSettingsSchema>>;

export const defaultRecapSettings = {
  enabled: true,
  awayDelayMs: 5 * 60 * 1_000,
} as const satisfies RecapSettings;

export function getRecapSettings(): RecapSettings {
  const settingsPath = join(getAgentRuntime(), "settings.json");
  if (!existsSync(settingsPath)) return defaultRecapSettings;

  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
  if (!Value.Check(AgentSettingsSchema, parsed)) return defaultRecapSettings;

  const settings = Value.Parse(AgentSettingsSchema, parsed).recap;
  return settings === undefined ? defaultRecapSettings : { ...defaultRecapSettings, ...settings };
}
