import type { SettingsManager } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { defaultModes, defaultModesSchema, type DefaultModes } from "./default-modes.js";
import { defaultInterviewSettings } from "./extensions/interview/settings.js";

type AgentSettings = Parameters<SettingsManager["applyOverrides"]>[0];
const PackageJsonSchema = Type.Object({
  version: Type.String(),
});
const cwd = import.meta.dirname;
const packageJsonFile = join(cwd, "..", "package.json");
const packageJson = Value.Parse(
  PackageJsonSchema,
  JSON.parse(readFileSync(packageJsonFile, { encoding: "utf8" })),
);

export type AvailableModes = keyof (typeof defaultModes)["modes"];
export type DefaultModesSettings = { current: AvailableModes };

export type DefaultSettings = AgentSettings & {
  interview: typeof defaultInterviewSettings;
  modes: DefaultModesSettings;
};

export const defaultMode = "build" as const satisfies AvailableModes;

export const defaultSettings = {
  defaultProvider: "codex-openai",
  defaultModel: "gpt-5.5",
  hideThinkingBlock: true,
  defaultThinkingLevel: "low",
  transport: "auto",
  quietStartup: true,
  editorPaddingX: 0,
  collapseChangelog: true,
  enableInstallTelemetry: false,
  lastChangelogVersion: packageJson.version,
  theme: "catppuccin-mocha",
  retry: {
    enabled: true,
    maxRetries: 1024,
  },
  terminal: {
    showImages: true,
    clearOnShrink: false,
    showTerminalProgress: true,
  },
  interview: defaultInterviewSettings,
  modes: {
    current: defaultMode,
  },
} as const satisfies DefaultSettings;

export { defaultModes, defaultModesSchema };
export type { DefaultModes };
