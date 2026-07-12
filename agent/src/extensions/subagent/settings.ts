import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { getAgentRuntime } from "../interview/settings.js";

export const SubagentsSettingsSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

const AgentSettingsSchema = Type.Object(
  {
    subagents: Type.Optional(SubagentsSettingsSchema),
  },
  { additionalProperties: true },
);

export type SubagentsSettings = Required<Static<typeof SubagentsSettingsSchema>>;

export const defaultSubagentsSettings = {
  enabled: false,
} as const satisfies SubagentsSettings;

export function getSubagentsSettings(): SubagentsSettings {
  const settingsPath = join(getAgentRuntime(), "settings.json");
  if (!existsSync(settingsPath)) return defaultSubagentsSettings;
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
  if (!Value.Check(AgentSettingsSchema, parsed)) return defaultSubagentsSettings;
  const settings = Value.Parse(AgentSettingsSchema, parsed).subagents;
  if (settings === undefined) return defaultSubagentsSettings;
  return { ...defaultSubagentsSettings, ...settings };
}
