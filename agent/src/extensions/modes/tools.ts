import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ModeSpec } from "../../mode-utils.js";
import { shouldUsePatch } from "../patch.js";

function compareToolNames(left: string, right: string): number {
  return left.localeCompare(right);
}

export function sameToolSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) {
      return false;
    }
  }

  return true;
}

function getAvailableToolNames(pi: ExtensionAPI): string[] {
  return pi
    .getAllTools()
    .map((tool) => tool.name)
    .filter((toolName) => !["grep", "find", "ls"].includes(toolName))
    .toSorted(compareToolNames);
}

function getDefaultToolNames(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  availableToolNames: string[],
): string[] {
  const tools = new Set(availableToolNames);

  if (shouldUsePatch(ctx.model?.id)) {
    tools.delete("edit");
    tools.delete("write");
    if (tools.has("apply_patch")) {
      tools.add("apply_patch");
    }
  } else {
    tools.delete("apply_patch");
  }

  return Array.from(tools).toSorted(compareToolNames);
}

function resolveModeToolNames(
  toolRules: string[] | undefined,
  defaultToolNames: string[],
  availableToolNames: string[],
): string[] {
  if (toolRules === undefined) {
    return defaultToolNames;
  }

  const available = new Set(availableToolNames);
  const resolved = new Set<string>();

  for (const rule of toolRules) {
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

  return Array.from(resolved).toSorted(compareToolNames);
}

export function syncModeTools(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  spec: ModeSpec | undefined,
): void {
  const availableToolNames = getAvailableToolNames(pi);
  const defaultToolNames = getDefaultToolNames(pi, ctx, availableToolNames);
  const nextTools = resolveModeToolNames(spec?.tools, defaultToolNames, availableToolNames);
  const activeTools = pi.getActiveTools().slice().toSorted(compareToolNames);

  if (!sameToolSet(activeTools, nextTools)) {
    pi.setActiveTools(nextTools);
  }
}
