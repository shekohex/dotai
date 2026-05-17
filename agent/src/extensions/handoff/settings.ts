import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { getAgentRuntime } from "../interview/settings.js";

const HandoffSettingsSchema = Type.Object(
  {
    command: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

const AgentSettingsSchema = Type.Object(
  {
    handoff: Type.Optional(HandoffSettingsSchema),
  },
  { additionalProperties: true },
);

type AgentSettings = Static<typeof AgentSettingsSchema>;

export function isHandoffCommandEnabled(): boolean {
  const settingsPath = join(getAgentRuntime(), "settings.json");
  if (!existsSync(settingsPath)) {
    return false;
  }

  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
  if (!Value.Check(AgentSettingsSchema, parsed)) {
    return false;
  }

  const settings: AgentSettings = Value.Parse(AgentSettingsSchema, parsed);
  return settings.handoff?.command?.enabled === true;
}
