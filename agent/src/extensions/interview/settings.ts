/* oxlint-disable */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
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

export interface InterviewThemeSettings {
  mode?: "auto" | "light" | "dark";
  name?: string;
  lightPath?: string;
  darkPath?: string;
  toggleHotkey?: string;
}

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

export interface InterviewSettings {
  timeout?: number;
  port?: number;
  host?: string;
  publicBaseUrl?: string;
  autoOpenBrowser?: boolean;
  theme?: InterviewThemeSettings;
  snapshotDir?: string;
  autoSaveOnSubmit?: boolean;
  generateModel?: string;
}

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

  const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }

  const interview = (parsed as Record<string, unknown>).interview;
  if (typeof interview !== "object" || interview === null) {
    return {};
  }

  if (!Value.Check(InterviewSettingsSchema, interview)) {
    return {};
  }

  return Value.Parse(InterviewSettingsSchema, interview);
}
