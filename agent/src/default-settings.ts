import type { SettingsManager } from "@mariozechner/pi-coding-agent";

type AgentSettings = Parameters<SettingsManager["applyOverrides"]>[0];

export const defaultSettings = {
  defaultProvider: "codex-openai",
  defaultModel: "gpt-5.4",
  hideThinkingBlock: false,
  defaultThinkingLevel: "high",
  transport: "auto",
  quietStartup: true,
  collapseChangelog: true,
  theme: "catppuccin-mocha",
  retry: {
    enabled: true,
    maxRetries: 1024
  }
} satisfies AgentSettings;
