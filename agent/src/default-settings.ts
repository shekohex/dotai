import type { SettingsManager } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
