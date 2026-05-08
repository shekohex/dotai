import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { getAgentRuntime } from "../interview/settings.js";

const ModeSettingsSchema = Type.Object(
  {
    current: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const AgentSettingsSchema = Type.Object(
  {
    modes: Type.Optional(ModeSettingsSchema),
  },
  { additionalProperties: true },
);

function getSettingsPath(): string {
  return join(getAgentRuntime(), "settings.json");
}

export function loadPersistedMode(): string | undefined {
  const settingsPath = getSettingsPath();
  if (!existsSync(settingsPath)) {
    return undefined;
  }

  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
  if (!Value.Check(AgentSettingsSchema, parsed)) {
    return undefined;
  }

  return Value.Parse(AgentSettingsSchema, parsed).modes?.current;
}

export function savePersistedMode(modeName: string | undefined): void {
  const settingsPath = getSettingsPath();
  const parsed: unknown = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, "utf-8"))
    : {};
  const currentSettings = Value.Check(AgentSettingsSchema, parsed)
    ? Value.Parse(AgentSettingsSchema, parsed)
    : {};
  const nextModeSettings =
    currentSettings.modes === undefined
      ? { current: modeName }
      : { ...currentSettings.modes, current: modeName };
  const nextSettings = {
    ...currentSettings,
    modes: nextModeSettings,
  };

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");
}

export function getModesSettingsPath(): string {
  return getSettingsPath();
}
