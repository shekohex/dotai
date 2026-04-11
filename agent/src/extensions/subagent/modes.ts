import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { resolveModeSpec, type ModeSpec } from "../../mode-utils.js";

export type ResolvedSubagentMode = {
  modeName: string;
  spec: ModeSpec;
  tools: string[];
  autoExit: boolean;
  tmuxTarget: NonNullable<ModeSpec["tmuxTarget"]>;
  model?: string;
  thinkingLevel?: NonNullable<ModeSpec["thinkingLevel"]>;
  cwd: string;
  systemPrompt?: string;
  systemPromptMode: "append" | "replace";
};

const syntheticWorkerMode: ModeSpec = {
  tools: ["*", "!subagent"],
  autoExit: true,
};

export async function resolveSubagentMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: { mode?: string; cwd?: string; autoExit?: boolean },
): Promise<{ value?: ResolvedSubagentMode; error?: string }> {
  const availableToolNames = pi.getAllTools().map((tool) => tool.name);
  const parentActiveTools = pi.getActiveTools();
  const cwd = options.cwd ? path.resolve(ctx.cwd, options.cwd) : ctx.cwd;

  let modeName = options.mode?.trim() || "worker";
  let spec = options.mode ? await resolveModeSpec(cwd, modeName) : syntheticWorkerMode;
  if (!spec && modeName === "worker") {
    spec = syntheticWorkerMode;
  }

  if (!spec) {
    return { error: `Unknown mode "${modeName}"` };
  }

  const tools = resolveModeTools(spec.tools, parentActiveTools, availableToolNames);
  const model = spec.provider && spec.modelId ? `${spec.provider}/${spec.modelId}` : undefined;

  return {
    value: {
      modeName,
      spec,
      tools,
      autoExit: options.autoExit ?? spec.autoExit ?? true,
      tmuxTarget: spec.tmuxTarget ?? "pane",
      model,
      thinkingLevel: spec.thinkingLevel,
      cwd,
      systemPrompt: spec.systemPrompt,
      systemPromptMode: spec.systemPromptMode ?? "append",
    },
  };
}

export function resolveModeTools(
  toolRules: string[] | undefined,
  parentActiveTools: string[],
  availableToolNames: string[],
): string[] {
  const available = new Set(availableToolNames);
  const parentActive = new Set(parentActiveTools.filter((toolName) => available.has(toolName)));
  const resolved = new Set<string>();
  const rules = toolRules && toolRules.length > 0 ? toolRules : ["*", "!subagent"];

  for (const rule of rules) {
    if (rule === "*") {
      for (const toolName of parentActive) {
        resolved.add(toolName);
      }
      continue;
    }

    if (rule.startsWith("!")) {
      resolved.delete(rule.slice(1));
      continue;
    }

    if (available.has(rule)) {
      resolved.add(rule);
    }
  }

  resolved.delete("subagent");
  return Array.from(resolved).sort((left, right) => left.localeCompare(right));
}
