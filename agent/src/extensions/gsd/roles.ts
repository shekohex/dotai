import type { ModeSpec } from "../../mode-utils.js";

export type GsdRole =
  | "planner"
  | "phase-researcher"
  | "project-researcher"
  | "roadmapper"
  | "executor"
  | "verifier"
  | "plan-checker"
  | "debugger"
  | "codebase-mapper";

type GsdRoleConfig = {
  modeName: string;
  bundledPromptPath: string;
  fallbackMode: string;
  builtInModeSpec: Omit<ModeSpec, "systemPrompt">;
};

const registry: Record<GsdRole, GsdRoleConfig> = {
  planner: {
    modeName: "gsd-planner",
    bundledPromptPath: "resources/gsd/agents/gsd-planner.md",
    fallbackMode: "worker",
    builtInModeSpec: {
      description: "Built-in GSD planner",
      provider: "codex-openai",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
      tools: ["read", "bash", "websearch", "interview"],
      systemPromptMode: "replace",
      autoExit: true,
    },
  },
  executor: {
    modeName: "gsd-executor",
    bundledPromptPath: "resources/gsd/agents/gsd-executor.md",
    fallbackMode: "worker",
    builtInModeSpec: {
      description: "Built-in GSD executor",
      provider: "codex-openai",
      modelId: "gpt-5.5",
      thinkingLevel: "low",
      tools: ["read", "bash", "edit", "write", "websearch", "execute"],
      systemPromptMode: "replace",
      autoExit: true,
    },
  },
  verifier: {
    modeName: "gsd-verifier",
    bundledPromptPath: "resources/gsd/agents/gsd-verifier.md",
    fallbackMode: "review",
    builtInModeSpec: {
      description: "Built-in GSD verifier",
      provider: "codex-openai",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
      tools: ["read", "bash", "websearch"],
      systemPromptMode: "replace",
      autoExit: true,
    },
  },
  "codebase-mapper": {
    modeName: "gsd-codebase-mapper",
    bundledPromptPath: "resources/gsd/agents/gsd-codebase-mapper.md",
    fallbackMode: "search",
    builtInModeSpec: {
      description: "Built-in GSD codebase mapper",
      provider: "codex-openai",
      modelId: "gpt-5.4-mini",
      thinkingLevel: "high",
      tools: ["read", "bash", "edit", "write"],
      systemPromptMode: "replace",
      autoExit: true,
      tmuxTarget: "window",
    },
  },
  "phase-researcher": {
    modeName: "gsd-phase-researcher",
    bundledPromptPath: "resources/gsd/agents/gsd-phase-researcher.md",
    fallbackMode: "search",
    builtInModeSpec: {
      description: "Built-in GSD phase researcher",
      provider: "codex-openai",
      modelId: "gpt-5.4-mini",
      thinkingLevel: "high",
      tools: ["read", "bash", "websearch"],
      systemPromptMode: "replace",
      autoExit: true,
    },
  },
  "project-researcher": {
    modeName: "gsd-project-researcher",
    bundledPromptPath: "resources/gsd/agents/gsd-project-researcher.md",
    fallbackMode: "search",
    builtInModeSpec: {
      description: "Built-in GSD project researcher",
      provider: "codex-openai",
      modelId: "gpt-5.4-mini",
      thinkingLevel: "high",
      tools: ["read", "bash", "websearch"],
      systemPromptMode: "replace",
      autoExit: true,
    },
  },
  roadmapper: {
    modeName: "gsd-roadmapper",
    bundledPromptPath: "resources/gsd/agents/gsd-roadmapper.md",
    fallbackMode: "worker",
    builtInModeSpec: {
      description: "Built-in GSD roadmapper",
      provider: "codex-openai",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
      tools: ["read", "bash", "websearch", "interview"],
      systemPromptMode: "replace",
      autoExit: true,
    },
  },
  "plan-checker": {
    modeName: "gsd-plan-checker",
    bundledPromptPath: "resources/gsd/agents/gsd-plan-checker.md",
    fallbackMode: "review",
    builtInModeSpec: {
      description: "Built-in GSD plan checker",
      provider: "codex-openai",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
      tools: ["read", "bash", "websearch"],
      systemPromptMode: "replace",
      autoExit: true,
    },
  },
  debugger: {
    modeName: "gsd-debugger",
    bundledPromptPath: "resources/gsd/agents/gsd-debugger.md",
    fallbackMode: "worker",
    builtInModeSpec: {
      description: "Built-in GSD debugger",
      provider: "codex-openai",
      modelId: "gpt-5.5",
      thinkingLevel: "low",
      tools: ["read", "bash", "edit", "write", "websearch", "execute"],
      systemPromptMode: "replace",
      autoExit: true,
    },
  },
};

export function getGsdRoleConfig(role: GsdRole): GsdRoleConfig {
  return registry[role];
}

export function resolveRoleModeName(role: GsdRole): string {
  return getGsdRoleConfig(role).modeName;
}

export function resolveRoleFallbackMode(role: GsdRole): string {
  return getGsdRoleConfig(role).fallbackMode;
}

export function resolveRolePromptPath(role: GsdRole): string {
  return getGsdRoleConfig(role).bundledPromptPath;
}

export function resolveRoleBuiltInModeSpec(role: GsdRole): Omit<ModeSpec, "systemPrompt"> {
  return getGsdRoleConfig(role).builtInModeSpec;
}

export function listGsdRoles(): GsdRole[] {
  return [
    "planner",
    "phase-researcher",
    "project-researcher",
    "roadmapper",
    "executor",
    "verifier",
    "plan-checker",
    "debugger",
    "codebase-mapper",
  ];
}
