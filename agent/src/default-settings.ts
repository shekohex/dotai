import type { SettingsManager } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { defineModesFile, ModesFileSchema } from "./mode-utils.js";

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

export const defaultSettings = {
  defaultProvider: "codex-openai",
  defaultModel: "gpt-5.3-codex",
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
    maxRetries: 1024,
  },
} satisfies AgentSettings;

export type DefaultModes = Static<typeof ModesFileSchema>;

export const defaultModesSchema = ModesFileSchema;

export const defaultModes = defineModesFile({
  version: 1,
  currentMode: "deep",
  modes: {
    rush: {
      provider: "codex-openai",
      modelId: "gpt-5.4-mini",
      thinkingLevel: "high",
      color: "warning",
      tmuxTarget: "window",
      tools: ["*"],
      description:
        "Use me when you want a cheap, fast agent for exploration, rough implementation, and trying ideas quickly and you’re willing to review the output carefully using the review mode.",
    },
    docs: {
      provider: "opencode-go",
      modelId: "kimi-k2.5",
      thinkingLevel: "high",
      color: "success",
      tmuxTarget: "window",
      tools: ["read", "bash", "edit", "write", "websearch"],
      description:
        "Use me when you want a cheap, fast agent for technical writing, including docs, issues, PR descriptions, changelogs, and release notes.",
    },
    deep: {
      provider: "codex-openai",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "high",
      color: "warning",
      tmuxTarget: "window",
      tools: ["*"],
      description:
        "Use me when you want the highest-quality help for complex implementation, debugging, and code review; I’m the default mode.",
    },
    review: {
      provider: "codex-openai",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "high",
      color: "muted",
      tmuxTarget: "window",
      tools: ["read", "bash", "websearch"],
      autoExit: true,
      description:
        "Use me when you want a focused code review that looks for bugs, regressions, security issues, and correctness problems.",
      systemPrompt: modeSystemPrompt("review"),
      systemPromptMode: "append",
    },
    commiter: {
      provider: "codex-openai",
      modelId: "gpt-5.4-mini",
      thinkingLevel: "low",
      color: "muted",
      tmuxTarget: "window",
      tools: ["read", "bash"],
      autoExit: true,
      description:
        "Use me when you want to group local git changes and create atomic conventional commits.",
      systemPrompt: modeSystemPrompt("commiter"),
      systemPromptMode: "append",
    },
    search: {
      provider: "gemini",
      modelId: "gemini-3-flash-preview",
      thinkingLevel: "high",
      color: "borderMuted",
      tmuxTarget: "window",
      tools: ["read", "bash"],
      autoExit: true,
      description:
        "Use me when you want a quick answer from the current codebase or local files, especially for fast exploration.",
    },
    painter: {
      provider: "opencode-go",
      modelId: "glm-5.1",
      thinkingLevel: "high",
      color: "bashMode",
      tmuxTarget: "window",
      tools: ["read", "bash", "edit", "write", "websearch"],
      description:
        "Use me when you want frontend and UI work, UX exploration, or product-facing implementation that should look polished and feel good to use.",
    },
    worker: {
      tools: ["*", "!subagent"],
      autoExit: true,
      description: "Use me when you want a general-purpose worker for a focused task.",
    },
  },
}) satisfies DefaultModes;

function modeSystemPrompt(mode: keyof DefaultModes["modes"]): string {
  return readFileSync(join(cwd, "resources", "modes", `${mode}.md`), {
    encoding: "utf-8",
  });
}
