import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Static } from "typebox";

import { ModesFileSchema } from "./mode-definitions.js";

const cwd = import.meta.dirname;

export type DefaultModes = Static<typeof ModesFileSchema>;

export const defaultModesSchema = ModesFileSchema;

export const defaultModes: DefaultModes = {
  version: 1,
  currentMode: "build",
  modes: {
    rush: {
      provider: "codex-openai",
      modelId: "gpt-5.4-mini",
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
      tools: ["read", "bash", "edit", "write", "websearch"],
      description:
        "Use me when you want a cheap, fast agent for technical writing, including docs, issues, PR descriptions, changelogs, and release notes.",
    },
    build: {
      provider: "codex-openai",
      modelId: "gpt-5.5",
      thinkingLevel: "low",
      color: "warning",
      tmuxTarget: "window",
      tools: ["*", "!subagent"],
      description:
        "Use me when you want fast, capable model for day to day coding tasks, I'm the default mode.",
    },
    deep: {
      provider: "codex-openai",
      modelId: "gpt-5.5",
      thinkingLevel: "high",
      color: "warning",
      tmuxTarget: "window",
      tools: ["*", "!subagent"],
      description:
        "Use me when you want the highest-quality help for complex implementation, debugging, and code review.",
    },
    review: {
      provider: "codex-openai",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
      color: "muted",
      tmuxTarget: "window",
      tools: ["read", "bash", "websearch", "execute"],
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
      provider: "opencode-go",
      modelId: "glm-5.1",
      thinkingLevel: "high",
      color: "bashMode",
      tmuxTarget: "window",
      tools: ["read", "bash", "edit", "write", "websearch", "execute"],
      description:
        "Use me when you want frontend and UI work, UX exploration, or product-facing implementation that should look polished and feel good to use.",
    },
    ask: {
      provider: "opencode-go",
      modelId: "deepseek-v4-flash",
      tmuxTarget: "window",
      tools: ["read", "bash", "websearch", "execute"],
      autoExit: true,
      description:
        "Use me when you want to do QA and chat with your codebase, explore options",
    },
    worker: {
      tools: ["*", "!subagent"],
      autoExit: true,
      description: "Use me when you want a general-purpose worker for a focused task.",
    },
  },
};

function modeSystemPrompt(mode: keyof DefaultModes["modes"]): string {
  return readFileSync(join(cwd, "resources", "modes", `${mode}.md`), {
    encoding: "utf-8",
  });
}
