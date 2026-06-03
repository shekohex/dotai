import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const DynamicWorkflowSettingsSchema = Type.Object(
  {
    mode: Type.Optional(Type.String()),
    toolNames: Type.Optional(Type.Array(Type.String())),
    outputRetryCount: Type.Optional(Type.Number({ minimum: 0 })),
    concurrency: Type.Optional(Type.Number({ minimum: 1 })),
    maxAgents: Type.Optional(Type.Number({ minimum: 1 })),
    agentTimeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
    tokenBudget: Type.Optional(Type.Union([Type.Number({ minimum: 1 }), Type.Null()])),
    persistLogs: Type.Optional(Type.Boolean()),
    backgroundDefault: Type.Optional(Type.Boolean()),
    subagentBackend: Type.Optional(Type.Union([Type.Literal("lite"), Type.Literal("process")])),
  },
  { additionalProperties: true },
);

const AgentSettingsSchema = Type.Object(
  {
    dynamic_workflows: Type.Optional(DynamicWorkflowSettingsSchema),
  },
  { additionalProperties: true },
);

export type DynamicWorkflowSettings = Required<Static<typeof DynamicWorkflowSettingsSchema>>;

export const defaultDynamicWorkflowSettings = {
  mode: "worker",
  toolNames: [],
  outputRetryCount: 3,
  concurrency: 8,
  maxAgents: 1000,
  agentTimeoutMs: 1_800_000,
  tokenBudget: null,
  persistLogs: true,
  backgroundDefault: true,
  subagentBackend: "lite",
} as const satisfies DynamicWorkflowSettings;

export function getDynamicWorkflowSettings(): DynamicWorkflowSettings {
  const settingsPath = join(getAgentDir(), "settings.json");
  if (!existsSync(settingsPath)) return defaultDynamicWorkflowSettings;
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
  if (!Value.Check(AgentSettingsSchema, parsed)) return defaultDynamicWorkflowSettings;
  const settings = Value.Parse(AgentSettingsSchema, parsed).dynamic_workflows;
  if (settings === undefined) return defaultDynamicWorkflowSettings;
  return { ...defaultDynamicWorkflowSettings, ...settings };
}
