import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { resolveModeSpec, type ModeSpec } from "../mode-utils.js";
import { normalizeToolNamesForModel, shouldUsePatch } from "../extensions/patch.js";

export type ResolvedSubagentMode = {
  modeName: string;
  spec: ModeSpec;
  tools: string[];
  autoExit: boolean;
  autoExitTimeoutMs?: number;
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

function resolveModeCwd(ctx: ExtensionContext, value: string | undefined): string {
  return value !== undefined && value.length > 0 ? path.resolve(ctx.cwd, value) : ctx.cwd;
}

function resolveRequestedModeName(mode: string | undefined): string {
  const trimmedModeName = mode?.trim();
  return trimmedModeName !== undefined && trimmedModeName.length > 0 ? trimmedModeName : "worker";
}

async function resolveRequestedSpec(
  modeName: string,
  mode: string | undefined,
): Promise<ModeSpec | undefined> {
  const trimmedModeName = mode?.trim();
  const resolved =
    trimmedModeName !== undefined && trimmedModeName.length > 0
      ? await resolveModeSpec(modeName)
      : syntheticWorkerMode;
  if (resolved === undefined && modeName === "worker") {
    return syntheticWorkerMode;
  }
  return resolved;
}

export async function resolveSubagentMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: { mode?: string; cwd?: string; autoExit?: boolean; model?: string },
): Promise<{ value?: ResolvedSubagentMode; error?: string }> {
  const availableToolNames = getAvailableToolNames(pi);
  const cwd = resolveModeCwd(ctx, options.cwd);
  const modeName = resolveRequestedModeName(options.mode);
  const spec = await resolveRequestedSpec(modeName, options.mode);

  if (!spec) {
    return { error: `Unknown mode "${modeName}"` };
  }

  const modelId = extractRequestedModelId(options.model) ?? spec.modelId ?? ctx.model?.id;
  const defaultToolNames = getDefaultToolNames(availableToolNames, modelId);
  const tools = normalizeToolNamesForModel(
    resolveModeTools(spec.tools, defaultToolNames, availableToolNames),
    modelId,
    availableToolNames,
  );
  const model =
    spec.provider !== undefined &&
    spec.provider.length > 0 &&
    spec.modelId !== undefined &&
    spec.modelId.length > 0
      ? `${spec.provider}/${spec.modelId}`
      : undefined;
  const autoExit = options.autoExit ?? spec.autoExit ?? true;

  return {
    value: {
      modeName,
      spec,
      tools,
      autoExit,
      autoExitTimeoutMs: autoExit ? (spec.autoExitTimeoutMs ?? 30_000) : undefined,
      tmuxTarget: spec.tmuxTarget ?? "pane",
      model,
      thinkingLevel: spec.thinkingLevel,
      cwd,
      systemPrompt: spec.systemPrompt,
      systemPromptMode: spec.systemPromptMode ?? "append",
    },
  };
}

function extractRequestedModelId(modelSpec: string | undefined): string | undefined {
  if (modelSpec === undefined) return undefined;
  const slashIndex = modelSpec.indexOf("/");
  if (slashIndex <= 0 || slashIndex === modelSpec.length - 1) return undefined;
  return modelSpec.slice(slashIndex + 1);
}

function compareToolNames(left: string, right: string): number {
  return left.localeCompare(right);
}

function getAvailableToolNames(pi: ExtensionAPI): string[] {
  return pi
    .getAllTools()
    .map((tool) => tool.name)
    .filter((toolName) => !["grep", "find", "ls"].includes(toolName))
    .toSorted(compareToolNames);
}

function getDefaultToolNames(availableToolNames: string[], modelId: string | undefined): string[] {
  const tools = new Set(availableToolNames);
  if (shouldUsePatch(modelId)) {
    tools.delete("edit");
    tools.delete("write");
    if (tools.has("apply_patch")) tools.add("apply_patch");
  } else {
    tools.delete("apply_patch");
  }
  return Array.from(tools).toSorted(compareToolNames);
}

export function resolveModeTools(
  toolRules: string[] | undefined,
  defaultToolNames: string[],
  availableToolNames: string[],
): string[] {
  const available = new Set(availableToolNames);
  const resolved = new Set<string>();
  const rules = toolRules && toolRules.length > 0 ? toolRules : ["*", "!subagent"];

  for (const rule of rules) {
    if (rule === "*") {
      for (const toolName of defaultToolNames) {
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
  return Array.from(resolved).toSorted((left, right) => left.localeCompare(right));
}
