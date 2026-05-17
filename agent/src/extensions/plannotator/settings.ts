import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

function getAgentRuntime(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  return agentDir !== undefined && agentDir.length > 0 ? agentDir : getAgentDir();
}

const PlannotatorSettingsSchema = Type.Object(
  {
    submitPlanTool: Type.Optional(
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
    plannotator: Type.Optional(PlannotatorSettingsSchema),
  },
  { additionalProperties: true },
);

type AgentSettings = Static<typeof AgentSettingsSchema>;

export function isSubmitPlanToolEnabled(): boolean {
  const settingsPath = join(getAgentRuntime(), "settings.json");
  if (!existsSync(settingsPath)) {
    return false;
  }

  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
  if (!Value.Check(AgentSettingsSchema, parsed)) {
    return false;
  }

  const settings: AgentSettings = Value.Parse(AgentSettingsSchema, parsed);
  return settings.plannotator?.submitPlanTool?.enabled === true;
}
