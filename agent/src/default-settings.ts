import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { defaultModes, defaultModesSchema, type DefaultModes } from "./default-modes.js";
import { defaultInterviewSettings } from "./extensions/interview/settings.js";
import { defaultOpenAIBetterSettings } from "./extensions/openai-better/settings.js";
import { DEFAULT_CONFIG as defaultContextPruneSettings } from "./extensions/context-prune/types.js";

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
  contextPrune: typeof defaultContextPruneSettings;
  modes: DefaultModesSettings;
  openaiBetter: typeof defaultOpenAIBetterSettings;
};

export const defaultMode = "build" as const satisfies AvailableModes;

export const defaultSettings = {
  defaultProvider: "openai-codex",
  defaultModel: "gpt-5.5",
  hideThinkingBlock: true,
  defaultThinkingLevel: "low",
  transport: "websocket-cached",
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
  contextPrune: defaultContextPruneSettings,
  interview: defaultInterviewSettings,
  openaiBetter: defaultOpenAIBetterSettings,
  modes: {
    current: defaultMode,
  },
} as const satisfies DefaultSettings;

export { defaultModes, defaultModesSchema };
export type { DefaultModes };
