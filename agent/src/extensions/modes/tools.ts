import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModeSpec } from "../../mode-utils.js";
import { getContextPruneAPI } from "../context-prune/public-api.js";
import { CONTEXT_PRUNE_TOOL_NAME, CONTEXT_TREE_QUERY_TOOL_NAME } from "../context-prune/types.js";
import { getWorkflowModeState, WORKFLOW_TOOL_NAME } from "../dynamic-workflows/workflow-editor.js";
import { GOAL_TOOL_NAME, isGoalToolEnabled } from "../goal/state.js";
import { getOpenAIBetterSettings } from "../openai-better/settings.js";
import { normalizeToolNamesForModel, shouldUsePatch } from "../patch.js";
import { isSessionQueryToolEnabled, SESSION_QUERY_TOOL_NAME } from "../session-query/state.js";
import { DEFERRED_TOOL_NAMES } from "../search-tools.js";
import { isSubagentToolEnabled, SUBAGENT_TOOL_NAME } from "../subagent/state.js";
import { readChildState } from "../../subagent-sdk/launch.js";

const STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput";

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

function getAvailableToolNames(pi: ExtensionAPI, ctx: ExtensionContext): string[] {
  const contextPruneConfig = getContextPruneAPI(ctx)?.config;

  return pi
    .getAllTools()
    .map((tool) => tool.name)
    .filter((toolName) => {
      if (toolName === "ls") return false;
      if (contextPruneConfig === undefined) return true;
      if (toolName === CONTEXT_PRUNE_TOOL_NAME) {
        return (
          contextPruneConfig.enabled &&
          contextPruneConfig.tools.contextPrune &&
          contextPruneConfig.tools.contextTreeQuery &&
          contextPruneConfig.pruneOn === "agentic-auto"
        );
      }
      if (toolName === CONTEXT_TREE_QUERY_TOOL_NAME) {
        return contextPruneConfig.enabled && contextPruneConfig.tools.contextTreeQuery;
      }
      return true;
    })
    .toSorted(compareToolNames);
}

function getDefaultToolNames(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  availableToolNames: string[],
  preserveActiveDeferredTools: boolean,
): string[] {
  const tools = new Set(availableToolNames);
  const activeToolNames = preserveActiveDeferredTools ? new Set(pi.getActiveTools()) : new Set();

  for (const toolName of DEFERRED_TOOL_NAMES) {
    if (!activeToolNames.has(toolName) && !isDeferredToolDefaultEnabled(toolName)) {
      tools.delete(toolName);
    }
  }

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

function isDeferredToolDefaultEnabled(toolName: string): boolean {
  if (toolName === WORKFLOW_TOOL_NAME) return getWorkflowModeState().toolEnabled;
  if (toolName === GOAL_TOOL_NAME) return isGoalToolEnabled();
  if (toolName === SESSION_QUERY_TOOL_NAME) return isSessionQueryToolEnabled();
  if (toolName === SUBAGENT_TOOL_NAME) return isSubagentToolEnabled();
  if (toolName === "generate_image") return getOpenAIBetterSettings().image.enabled;
  return false;
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
  options: { preserveActiveDeferredTools?: boolean } = {},
): void {
  const availableToolNames = getAvailableToolNames(pi, ctx);
  const defaultToolNames = getDefaultToolNames(
    pi,
    ctx,
    availableToolNames,
    options.preserveActiveDeferredTools ?? true,
  );
  const nextTools = normalizeToolNamesForModel(
    resolveModeToolNames(spec?.tools, defaultToolNames, availableToolNames),
    ctx.model?.id,
    availableToolNames,
  );
  const childState = readChildState();
  if (
    childState?.outputFormat?.type === "json_schema" &&
    availableToolNames.includes(STRUCTURED_OUTPUT_TOOL_NAME) &&
    !nextTools.includes(STRUCTURED_OUTPUT_TOOL_NAME)
  ) {
    nextTools.push(STRUCTURED_OUTPUT_TOOL_NAME);
    nextTools.sort(compareToolNames);
  }
  const activeTools = pi.getActiveTools().slice().toSorted(compareToolNames);

  if (!sameToolSet(activeTools, nextTools)) {
    pi.setActiveTools(nextTools);
  }
}
