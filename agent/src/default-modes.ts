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
        "Use for cheap exploration, parallel scenario probes, and disposable implementation passes.",
      fallbacks: [
        { provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "high" },
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
      description:
        "Use for technical writing, docs, GitHub issues/PRs, release notes, and human-readable refinement.",
      fallbacks: [
        { provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "high" },
        { provider: "zai", modelId: "glm-5.2", thinkingLevel: "xhigh" },
        { provider: "zai-coding-plan", modelId: "glm-5.2", thinkingLevel: "xhigh" },
      ],
    },
    openwiki: {
      provider: "zai",
      modelId: "glm-5.2",
      thinkingLevel: "xhigh",
      color: "success",
      tmuxTarget: "window",
      tools: ["*"],
      description:
        "Use for OpenWiki-style repository documentation init, update, and chat workflows.",
      systemPrompt: modeSystemPrompt("openwiki"),
      systemPromptMode: "replace",
      fallbacks: [
        { provider: "zai-coding-plan", modelId: "glm-5.2", thinkingLevel: "xhigh" },
        { provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "high" },
        { provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "high" },
      ],
    },
    build: {
      provider: "codex-openai",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
      color: "warning",
      tmuxTarget: "window",
      tools: ["*"],
      description:
        "Use for normal coding tasks: implementation, fixes, refactors, tests, and verification.",
    },
    deep: {
      provider: "codex-openai",
      modelId: "gpt-5.5",
      thinkingLevel: "xhigh",
      color: "warning",
      tmuxTarget: "window",
      tools: ["*"],
      description:
        "Use for build-style work that needs deeper reasoning, higher cost, and more correct code.",
    },
    review: {
      provider: "codex-openai",
      modelId: "gpt-5.5",
      thinkingLevel: "xhigh",
      color: "muted",
      tmuxTarget: "window",
      tools: ["read", "grep", "find", "bash", "websearch"],
      autoExit: true,
      description:
        "Use after cheap-review/fast-review find no issues or when explicitly requested; expensive correctness review, no fixes.",
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
      description:
        "Use first for cheap correctness review; run many in parallel before escalating to review.",
      systemPrompt: modeSystemPrompt("review"),
      systemPromptMode: "replace",
      fallbacks: [{ provider: "zai-coding-plan", modelId: "glm-5.2", thinkingLevel: "xhigh" }],
    },
    "fast-review": {
      provider: "opencode-go",
      modelId: "deepseek-v4-pro",
      thinkingLevel: "high",
      color: "muted",
      tmuxTarget: "window",
      tools: ["read", "grep", "find", "bash", "websearch"],
      autoExit: true,
      description:
        "Use first for fast correctness review; run many in parallel before escalating to review.",
      systemPrompt: modeSystemPrompt("review"),
      systemPromptMode: "replace",
      fallbacks: [
        { provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "high" },
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
      description:
        "Use to inspect changes, stage explicit files, and create atomic conventional commits.",
      systemPrompt: modeSystemPrompt("commiter"),
      systemPromptMode: "append",
    },
    search: {
      provider: "opencode-go",
      modelId: "deepseek-v4-flash",
      color: "borderMuted",
      thinkingLevel: "high",
      tmuxTarget: "window",
      tools: ["read", "grep", "find", "bash"],
      autoExit: true,
      description:
        "Use first for codebase exploration: locate files, trace symbols, map references, and answer where/how.",
      systemPrompt: modeSystemPrompt("search"),
      systemPromptMode: "replace",
      fallbacks: [
        { provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "high" },
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
      description:
        "Use for frontend, UI, UX polish, design-system fidelity, accessibility, and visual verification.",
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
      description:
        "Use for Q&A, debugging analysis, code explanation, architecture discussion, and grounded recommendations.",
      systemPrompt: modeSystemPrompt("ask"),
      systemPromptMode: "append",
    },
    worker: {
      tools: ["*", "!subagent"],
      autoExit: true,
      description:
        "Use for delegated implementation work with scoped changes, validation, and coordinator-facing summary.",
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
      description:
        "Use for web search, current docs, external APIs, release notes, and cited research.",
      fallbacks: [{ provider: "zai-coding-plan", modelId: "glm-5.2", thinkingLevel: "xhigh" }],
    },
    poke: {
      provider: "opencode-go",
      modelId: "deepseek-v4-flash",
      thinkingLevel: "high",
      tmuxTarget: "window",
      tools: ["*"],
      autoExit: true,
      description: "Use for personal assistant and chat workflows outside focused coding modes.",
      systemPrompt: modeSystemPrompt("poke"),
      systemPromptMode: "replace",
      fallbacks: [
        { provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "high" },
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
