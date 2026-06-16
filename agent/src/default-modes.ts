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
        { provider: "zai-coding-plan", modelId: "glm-5.2", thinkingLevel: "xhigh" },
        { provider: "zai", modelId: "glm-5.2", thinkingLevel: "xhigh" },
      ],
    },
    docs: {
      provider: "opencode-go",
      modelId: "kimi-k2.7-code",
      thinkingLevel: "high",
      color: "success",
      tmuxTarget: "window",
      tools: ["*"],
      description: "technical writing/docs/issues/PRs",
      fallbacks: [
        { provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "high" },
        { provider: "zai", modelId: "glm-5.2", thinkingLevel: "xhigh" },
        { provider: "zai-coding-plan", modelId: "glm-5.2", thinkingLevel: "xhigh" },
      ],
    },
    build: {
      provider: "codex-openai",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
      color: "warning",
      tmuxTarget: "window",
      tools: ["*"],
      description: "default coding",
    },
    deep: {
      provider: "codex-openai",
      modelId: "gpt-5.5",
      thinkingLevel: "xhigh",
      color: "warning",
      tmuxTarget: "window",
      tools: ["*"],
      description: "complex implementation/debugging/review",
    },
    review: {
      provider: "codex-openai",
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
      modelId: "glm-5.2",
      thinkingLevel: "xhigh",
      color: "muted",
      tmuxTarget: "window",
      tools: ["read", "grep", "find", "bash", "websearch"],
      autoExit: true,
      description: "fast cheap correctness review",
      systemPrompt: modeSystemPrompt("review"),
      systemPromptMode: "replace",
      fallbacks: [{ provider: "zai-coding-plan", modelId: "glm-5.2", thinkingLevel: "xhigh" }],
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
        { provider: "zai", modelId: "glm-5.2", thinkingLevel: "xhigh" },
        { provider: "zai-coding-plan", modelId: "glm-5.2", thinkingLevel: "xhigh" },
      ],
    },
    commiter: {
      provider: "codex-openai",
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
      systemPrompt: modeSystemPrompt("search"),
      systemPromptMode: "replace",
      fallbacks: [
        { provider: "zai-coding-plan", modelId: "glm-5.2", thinkingLevel: "xhigh" },
        { provider: "zai", modelId: "glm-5.2", thinkingLevel: "xhigh" },
      ],
    },
    painter: {
      provider: "zai",
      modelId: "glm-5.2",
      thinkingLevel: "xhigh",
      color: "bashMode",
      tmuxTarget: "window",
      tools: ["*"],
      description: "frontend/UI/UX polish",
      systemPrompt: modeSystemPrompt("painter"),
      systemPromptMode: "append",
      fallbacks: [{ provider: "zai-coding-plan", modelId: "glm-5.2", thinkingLevel: "xhigh" }],
    },
    ask: {
      provider: "codex-openai",
      modelId: "gpt-5.5",
      thinkingLevel: "low",
      tmuxTarget: "window",
      tools: ["read", "grep", "find", "bash", "websearch", "execute", "subagent"],
      autoExit: true,
      description: "QA/codebase chat",
      systemPrompt: modeSystemPrompt("ask"),
      systemPromptMode: "append",
    },
    worker: {
      tools: ["*", "!subagent"],
      autoExit: true,
      description: "general-purpose worker",
      tmuxTarget: "window",
      systemPrompt: modeSystemPrompt("worker"),
      systemPromptMode: "append",
    },
    websearch: {
      provider: "zai",
      modelId: "glm-5.2",
      thinkingLevel: "xhigh",
      color: "muted",
      tmuxTarget: "window",
      tools: ["read", "grep", "find", "bash", "websearch"],
      autoExit: true,
      description: "web/current docs research",
      fallbacks: [{ provider: "zai-coding-plan", modelId: "glm-5.2", thinkingLevel: "xhigh" }],
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
        { provider: "zai-coding-plan", modelId: "glm-5.2", thinkingLevel: "xhigh" },
        { provider: "zai", modelId: "glm-5.2", thinkingLevel: "xhigh" },
      ],
    },
  },
} as const satisfies DefaultModes;

function modeSystemPrompt(mode: keyof DefaultModes["modes"]): string {
  return readFileSync(join(cwd, "resources", "modes", `${mode}.md`), {
    encoding: "utf-8",
  });
}
