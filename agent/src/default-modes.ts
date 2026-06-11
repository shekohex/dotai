import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Static } from "typebox";

import { ModesFileSchema } from "./mode-definitions.js";

const cwd = import.meta.dirname;

export type DefaultModes = Static<typeof ModesFileSchema>;

export const defaultModesSchema = ModesFileSchema;

export const defaultModes = {
  version: 1,
  currentMode: "build",
  modes: {
    rush: {
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      thinkingLevel: "high",
      color: "warning",
      tmuxTarget: "window",
      tools: ["*", "!subagent"],
      description: "cheap fast exploration/rough implementation",
      fallbacks: [
        { provider: "opencode-go", modelId: "deepseek-v4-flash", thinkingLevel: "high" },
        { provider: "zai-coding-plan", modelId: "glm-5.1", thinkingLevel: "high" },
        { provider: "zai", modelId: "glm-5.1", thinkingLevel: "high" },
      ],
    },
    docs: {
      provider: "opencode-go",
      modelId: "kimi-k2.6",
      thinkingLevel: "high",
      color: "success",
      tmuxTarget: "window",
      tools: ["*"],
      description: "technical writing/docs/issues/PRs",
      fallbacks: [
        { provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "high" },
        { provider: "zai", modelId: "glm-5.1", thinkingLevel: "high" },
        { provider: "zai-coding-plan", modelId: "glm-5.1", thinkingLevel: "high" },
      ],
    },
    build: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
      color: "warning",
      tmuxTarget: "window",
      tools: ["*"],
      description: "default coding",
    },
    deep: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "xhigh",
      color: "warning",
      tmuxTarget: "window",
      tools: ["*"],
      description: "complex implementation/debugging/review",
    },
    review: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "xhigh",
      color: "muted",
      tmuxTarget: "window",
      tools: ["read", "grep", "find", "bash", "websearch"],
      autoExit: true,
      description: "focused correctness review",
      systemPrompt: modeSystemPrompt("review"),
      systemPromptMode: "replace",
    },
    "cheap-review": {
      provider: "zai",
      modelId: "glm-5.1",
      thinkingLevel: "high",
      color: "muted",
      tmuxTarget: "window",
      tools: ["read", "grep", "find", "bash", "websearch"],
      autoExit: true,
      description: "fast cheap correctness review",
      systemPrompt: modeSystemPrompt("review"),
      systemPromptMode: "replace",
      fallbacks: [{ provider: "zai-coding-plan", modelId: "glm-5.1", thinkingLevel: "high" }],
    },
    "fast-review": {
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
      thinkingLevel: "high",
      color: "muted",
      tmuxTarget: "window",
      tools: ["read", "grep", "find", "bash", "websearch"],
      autoExit: true,
      description: "ultra-fast parallel correctness review",
      systemPrompt: modeSystemPrompt("review"),
      systemPromptMode: "replace",
      fallbacks: [
        { provider: "zai", modelId: "glm-5.1", thinkingLevel: "high" },
        { provider: "zai-coding-plan", modelId: "glm-5.1", thinkingLevel: "high" },
      ],
    },
    commiter: {
      provider: "openai-codex",
      modelId: "gpt-5.4-mini",
      thinkingLevel: "low",
      color: "muted",
      tmuxTarget: "window",
      tools: ["read", "grep", "find", "bash"],
      autoExit: true,
      description: "atomic conventional commits",
      systemPrompt: modeSystemPrompt("commiter"),
      systemPromptMode: "append",
    },
    search: {
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      color: "borderMuted",
      thinkingLevel: "high",
      tmuxTarget: "window",
      tools: ["read", "grep", "find", "bash"],
      autoExit: true,
      description: "quick codebase/local-file answers",
      fallbacks: [
        { provider: "zai-coding-plan", modelId: "glm-5.1", thinkingLevel: "high" },
        { provider: "zai", modelId: "glm-5.1", thinkingLevel: "high" },
      ],
    },
    painter: {
      provider: "zai",
      modelId: "glm-5.1",
      thinkingLevel: "high",
      color: "bashMode",
      tmuxTarget: "window",
      tools: ["*"],
      description: "frontend/UI/UX polish",
      fallbacks: [{ provider: "zai-coding-plan", modelId: "glm-5.1", thinkingLevel: "high" }],
    },
    ask: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "low",
      tmuxTarget: "window",
      tools: ["read", "grep", "find", "bash", "websearch", "execute", "subagent"],
      autoExit: true,
      description: "QA/codebase chat",
    },
    worker: {
      tools: ["*", "!subagent"],
      autoExit: true,
      description: "general-purpose worker",
      tmuxTarget: "window",
    },
    websearch: {
      provider: "zai",
      modelId: "glm-5.1",
      thinkingLevel: "high",
      color: "muted",
      tmuxTarget: "window",
      tools: ["read", "grep", "find", "bash", "websearch"],
      autoExit: true,
      description: "web/current docs research",
      fallbacks: [{ provider: "zai-coding-plan", modelId: "glm-5.1", thinkingLevel: "high" }],
    },
    poke: {
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      thinkingLevel: "high",
      tmuxTarget: "window",
      tools: ["*"],
      autoExit: true,
      systemPrompt: modeSystemPrompt("poke"),
      systemPromptMode: "replace",
      fallbacks: [
        { provider: "opencode-go", modelId: "deepseek-v4-flash", thinkingLevel: "high" },
        { provider: "zai-coding-plan", modelId: "glm-5.1", thinkingLevel: "high" },
        { provider: "zai", modelId: "glm-5.1", thinkingLevel: "high" },
      ],
    },
  },
} as const satisfies DefaultModes;

function modeSystemPrompt(mode: keyof DefaultModes["modes"]): string {
  return readFileSync(join(cwd, "resources", "modes", `${mode}.md`), {
    encoding: "utf-8",
  });
}
