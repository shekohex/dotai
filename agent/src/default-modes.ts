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
      provider: "opencode-go",
      modelId: "deepseek-v4-flash",
      thinkingLevel: "high",
      color: "warning",
      tmuxTarget: "window",
      tools: ["*", "!subagent"],
      description:
        "Use me when you want a cheap, fast agent for exploration, rough implementation, and trying ideas quickly and you’re willing to review the output carefully using the review mode.",
    },
    docs: {
      provider: "opencode-go",
      modelId: "kimi-k2.6",
      thinkingLevel: "high",
      color: "success",
      tmuxTarget: "window",
      tools: ["*"],
      description:
        "Use me when you want a cheap, fast agent for technical writing, including docs, issues, PR descriptions, changelogs, and release notes.",
    },
    build: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
      color: "warning",
      tmuxTarget: "window",
      tools: ["*"],
      description:
        "Use me when you want fast, capable model for day to day coding tasks, I'm the default mode.",
    },
    deep: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "xhigh",
      color: "warning",
      tmuxTarget: "window",
      tools: ["*"],
      description:
        "Use me when you want the highest-quality help for complex implementation, debugging, and code review.",
    },
    review: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "xhigh",
      color: "muted",
      tmuxTarget: "window",
      tools: ["read", "bash", "websearch"],
      autoExit: true,
      description:
        "Use me when you want a focused code review that looks for bugs, regressions, security issues, and correctness problems.",
      systemPrompt: modeSystemPrompt("review"),
      systemPromptMode: "replace",
    },
    "cheap-review": {
      provider: "zai-coding-plan",
      modelId: "glm-5.1",
      thinkingLevel: "high",
      color: "muted",
      tmuxTarget: "window",
      tools: ["read", "bash", "websearch"],
      autoExit: true,
      description:
        "Use me when you want a fast and cheap code review that looks for bugs, regressions, security issues, and correctness problems.",
      systemPrompt: modeSystemPrompt("review"),
      systemPromptMode: "replace",
    },
    "fast-review": {
      provider: "opencode-go",
      modelId: "deepseek-v4-flash",
      thinkingLevel: "high",
      color: "muted",
      tmuxTarget: "window",
      tools: ["read", "bash", "websearch"],
      autoExit: true,
      description:
        "Use me when you want a ultra fast and dirt cheap code review that looks for bugs, regressions, security issues, and correctness problems. You can use a lot of parallel review agents to get a quick answer.",
      systemPrompt: modeSystemPrompt("review"),
      systemPromptMode: "replace",
    },
    commiter: {
      provider: "openai-codex",
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
      provider: "opencode-go",
      modelId: "deepseek-v4-flash",
      color: "borderMuted",
      thinkingLevel: "high",
      tmuxTarget: "window",
      tools: ["read", "bash"],
      autoExit: true,
      description:
        "Use me when you want a quick answer from the current codebase or local files, especially for fast exploration.",
    },
    painter: {
      provider: "zai-coding-plan",
      modelId: "glm-5.1",
      thinkingLevel: "high",
      color: "bashMode",
      tmuxTarget: "window",
      tools: ["*"],
      description:
        "Use me when you want frontend and UI work, UX exploration, or product-facing implementation that should look polished and feel good to use.",
    },
    ask: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "low",
      tmuxTarget: "window",
      tools: ["read", "bash", "websearch", "execute", "subagent"],
      autoExit: true,
      description: "Use me when you want to do QA and chat with your codebase, explore options",
    },
    worker: {
      tools: ["*", "!subagent"],
      autoExit: true,
      description: "Use me when you want a general-purpose worker for a focused task.",
      tmuxTarget: "window",
    },
    websearch: {
      provider: "zai-coding-plan",
      modelId: "glm-5.1",
      thinkingLevel: "high",
      color: "muted",
      tmuxTarget: "window",
      tools: ["read", "bash", "websearch"],
      autoExit: true,
      description:
        "Use me when you want to search the web for information or look up up-to-date library documentation or doing an overall web research.",
    },
  },
} as const satisfies DefaultModes;

function modeSystemPrompt(mode: keyof DefaultModes["modes"]): string {
  return readFileSync(join(cwd, "resources", "modes", `${mode}.md`), {
    encoding: "utf-8",
  });
}
