import type { ModeSpec } from "../../mode-utils.js";

export type GsdRole =
  | "planner"
  | "phase-researcher"
  | "pattern-mapper"
  | "assumptions-analyzer"
  | "project-researcher"
  | "roadmapper"
  | "executor"
  | "verifier"
  | "plan-checker"
  | "debugger"
  | "debug-session-manager"
  | "codebase-mapper"
  | "intel-updater";

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
      thinkingLevel: "xhigh",
      tools: ["read", "grep", "find", "bash", "write", "websearch", "ask_user_question"],
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
      thinkingLevel: "medium",
      tools: ["*", "!ask_user_question"],
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
      tools: ["read", "grep", "find", "bash", "write", "websearch", "!ask_user_question"],
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
      tools: ["read", "grep", "find", "bash", "edit", "write", "!ask_user_question"],
      systemPromptMode: "replace",
      autoExit: true,
      tmuxTarget: "window",
    },
  },
  "intel-updater": {
    modeName: "gsd-intel-updater",
    bundledPromptPath: "resources/gsd/agents/gsd-intel-updater.md",
    fallbackMode: "search",
    builtInModeSpec: {
      description: "Built-in GSD intel updater",
      provider: "codex-openai",
      modelId: "gpt-5.4-mini",
      thinkingLevel: "high",
      tools: ["read", "grep", "find", "bash", "edit", "write", "!ask_user_question"],
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
      tools: ["read", "grep", "find", "bash", "write", "websearch", "!ask_user_question"],
      systemPromptMode: "replace",
      autoExit: true,
    },
  },
  "pattern-mapper": {
    modeName: "gsd-pattern-mapper",
    bundledPromptPath: "resources/gsd/agents/gsd-pattern-mapper.md",
    fallbackMode: "search",
    builtInModeSpec: {
      description: "Built-in GSD pattern mapper",
      provider: "codex-openai",
      modelId: "gpt-5.4-mini",
      thinkingLevel: "high",
      tools: ["read", "grep", "find", "bash", "write", "!ask_user_question"],
      systemPromptMode: "replace",
      autoExit: true,
    },
  },
  "assumptions-analyzer": {
    modeName: "gsd-assumptions-analyzer",
    bundledPromptPath: "resources/gsd/agents/gsd-assumptions-analyzer.md",
    fallbackMode: "search",
    builtInModeSpec: {
      description: "Built-in GSD assumptions analyzer",
      provider: "codex-openai",
      modelId: "gpt-5.4-mini",
      thinkingLevel: "high",
      tools: ["read", "grep", "find", "bash", "!ask_user_question"],
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
      tools: ["read", "grep", "find", "bash", "write", "websearch", "ask_user_question"],
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
      tools: ["read", "grep", "find", "bash", "write", "websearch", "!ask_user_question"],
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
      tools: ["read", "grep", "find", "bash", "websearch", "!ask_user_question"],
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
      tools: [
        "read",
        "grep",
        "find",
        "bash",
        "edit",
        "write",
        "websearch",
        "execute",
        "ask_user_question",
      ],
      systemPromptMode: "replace",
      autoExit: true,
    },
  },
  "debug-session-manager": {
    modeName: "gsd-debug-session-manager",
    bundledPromptPath: "resources/gsd/agents/gsd-debug-session-manager.md",
    fallbackMode: "worker",
    builtInModeSpec: {
      description: "Built-in GSD debug session manager",
      provider: "codex-openai",
      modelId: "gpt-5.5",
      thinkingLevel: "low",
      tools: [
        "read",
        "grep",
        "find",
        "bash",
        "edit",
        "write",
        "websearch",
        "subagent",
        "execute",
        "ask_user_question",
      ],
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
    "pattern-mapper",
    "assumptions-analyzer",
    "project-researcher",
    "roadmapper",
    "executor",
    "verifier",
    "plan-checker",
    "debugger",
    "debug-session-manager",
    "codebase-mapper",
    "intel-updater",
  ];
}
