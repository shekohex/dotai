import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

function expandUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function getAgentRuntime(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  return agentDir !== undefined && agentDir.length > 0 ? expandUserPath(agentDir) : getAgentDir();
}

export const SETTINGS_PATH = join(getAgentRuntime(), "settings.json");

export const InterviewThemeSettingsSchema = Type.Object(
  {
    mode: Type.Optional(
      Type.Union([Type.Literal("auto"), Type.Literal("light"), Type.Literal("dark")]),
    ),
    name: Type.Optional(Type.String()),
    lightPath: Type.Optional(Type.String()),
    darkPath: Type.Optional(Type.String()),
    toggleHotkey: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export type InterviewThemeSettings = Static<typeof InterviewThemeSettingsSchema>;

export const InterviewSettingsSchema = Type.Object(
  {
    timeout: Type.Optional(Type.Number()),
    port: Type.Optional(Type.Number()),
    host: Type.Optional(Type.String()),
    publicBaseUrl: Type.Optional(Type.String()),
    autoOpenBrowser: Type.Optional(Type.Boolean()),
    theme: Type.Optional(InterviewThemeSettingsSchema),
    snapshotDir: Type.Optional(Type.String()),
    autoSaveOnSubmit: Type.Optional(Type.Boolean()),
    generateModel: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export type InterviewSettings = Static<typeof InterviewSettingsSchema>;

const AgentSettingsSchema = Type.Object(
  {
    interview: Type.Optional(InterviewSettingsSchema),
  },
  { additionalProperties: true },
);

export const defaultInterviewSettings: Required<
  Pick<
    InterviewSettings,
    "timeout" | "port" | "host" | "autoOpenBrowser" | "snapshotDir" | "autoSaveOnSubmit"
  >
> & { publicBaseUrl?: string; theme: InterviewThemeSettings } = {
  timeout: 600,
  port: 19847,
  host: "0.0.0.0",
  autoOpenBrowser: true,
  snapshotDir: join(getAgentRuntime(), "interview-snapshots"),
  autoSaveOnSubmit: true,
  theme: {
    mode: "dark",
    name: "default",
    toggleHotkey: "mod+shift+l",
  },
};

export function loadSettings(): InterviewSettings {
  if (!existsSync(SETTINGS_PATH)) {
    return {};
  }

  const parsed: unknown = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  if (!Value.Check(AgentSettingsSchema, parsed)) {
    return {};
  }

  const settings = Value.Parse(AgentSettingsSchema, parsed);
  if (settings.interview === undefined) {
    return {};
  }

  return settings.interview;
}
