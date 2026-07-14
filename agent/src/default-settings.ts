import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { defaultModes, defaultModesSchema, type DefaultModes } from "./default-modes.js";
import { defaultInterviewSettings } from "./extensions/interview/settings.js";
import { defaultOpenAIBetterSettings } from "./extensions/openai-better/settings.js";
import { DEFAULT_CONFIG as defaultContextPruneSettings } from "./extensions/context-prune/types.js";
import { defaultDynamicWorkflowSettings } from "./extensions/dynamic-workflows/settings.js";
import { defaultSessionQuerySettings } from "./extensions/session-query/settings.js";
import { defaultSessionArchiveSettings } from "./extensions/session-archive/settings.js";
import { defaultSubagentsSettings } from "./extensions/subagent/settings.js";
import { defaultAiAutocompleteSettings } from "./extensions/coreui/ai-autocomplete-settings.js";
import { defaultRecapSettings } from "./extensions/recap/settings.js";

type AgentSettings = Parameters<SettingsManager["applyOverrides"]>[0];
type TerminalSettings = NonNullable<AgentSettings["terminal"]> & { titleSpinner: boolean };
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

export type DefaultSettings = Omit<AgentSettings, "terminal"> & {
  terminal: TerminalSettings;
  interview: typeof defaultInterviewSettings;
  contextPrune: typeof defaultContextPruneSettings;
  dynamic_workflows: typeof defaultDynamicWorkflowSettings;
  sessionQuery: typeof defaultSessionQuerySettings;
  sessionArchive: typeof defaultSessionArchiveSettings;
  subagents: typeof defaultSubagentsSettings;
  aiAutocomplete: typeof defaultAiAutocompleteSettings;
  openaiBetter: typeof defaultOpenAIBetterSettings;
  recap: typeof defaultRecapSettings;
};

export const defaultSettings = {
  defaultProvider: "openai-codex",
  defaultModel: "gpt-5.5",
  hideThinkingBlock: true,
  defaultThinkingLevel: "low",
  transport: "sse",
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
    titleSpinner: true,
  },
  dynamic_workflows: defaultDynamicWorkflowSettings,
  sessionQuery: defaultSessionQuerySettings,
  sessionArchive: defaultSessionArchiveSettings,
  subagents: defaultSubagentsSettings,
  aiAutocomplete: defaultAiAutocompleteSettings,
  contextPrune: {
    ...defaultContextPruneSettings,
    tools: { ...defaultContextPruneSettings.tools },
  },
  interview: defaultInterviewSettings,
  openaiBetter: defaultOpenAIBetterSettings,
  recap: defaultRecapSettings,
} as const satisfies DefaultSettings;

export { defaultModes, defaultModesSchema };
export type { DefaultModes };
