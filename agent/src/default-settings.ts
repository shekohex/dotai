import type { SettingsManager } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Static } from "@sinclair/typebox";

import { defineModesFile, ModesFileSchema } from "./mode-utils.js";

type AgentSettings = Parameters<SettingsManager["applyOverrides"]>[0];
const cwd = dirname(fileURLToPath(import.meta.url));
const packageJsonFile = join(cwd, "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonFile, { encoding: "utf8" }));


export const defaultSettings = {
  defaultProvider: "codex-openai",
  defaultModel: "gpt-5.4",
  hideThinkingBlock: true,
  defaultThinkingLevel: "high",
  transport: "auto",
  quietStartup: true,
  editorPaddingX: 0,
  collapseChangelog: true,
  lastChangelogVersion: packageJson.version,
  theme: "catppuccin-mocha",
  retry: {
    enabled: true,
    maxRetries: 1024
  }
} satisfies AgentSettings;

export type DefaultModes = Static<typeof ModesFileSchema>;

export const defaultModesSchema = ModesFileSchema;

export const defaultModes = defineModesFile({
  version: 1,
  currentMode: "deep",
  modes: {
    mini: {
      provider: "codex-openai",
      modelId: "gpt-5.4-mini",
      thinkingLevel: "high",
      color: "accent"
    },
    rush: {
      provider: "opencode-go",
      modelId: "kimi-k2.5",
      thinkingLevel: "high",
      color: "success"
    },
    deep: {
      provider: "codex-openai",
      modelId: "gpt-5.4",
      thinkingLevel: "high",
      color: "warning"
    },
    review: {
      provider: "codex-openai",
      modelId: "gpt-5.4",
      thinkingLevel: "high",
      color: "muted"
    },
    search: {
      provider: "gemini",
      modelId: "gemini-3-flash-preview",
      thinkingLevel: "high",
      color: "borderMuted"
    },
    painter: {
      provider: "opencode-go",
      modelId: "glm-5.1",
      thinkingLevel: "high",
      color: "bashMode"
    }
  }
}) satisfies DefaultModes;
