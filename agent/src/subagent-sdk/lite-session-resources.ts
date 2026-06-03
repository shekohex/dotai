import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { installBundledResourcePaths } from "../extensions/bundled-resources.js";
import { getLiteBundledExtensionFactories } from "../extensions/lite-bundled-extensions.js";
import { applyModeSystemPrompt } from "../mode-system-prompt.js";
import { createStructuredOutputTool } from "./bootstrap.js";
import { STRUCTURED_OUTPUT_TOOL_NAME } from "./bootstrap-core.js";
import type { ResolvedSubagentMode } from "./modes.js";
import {
  SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
  serializeSubagentStructuredOutputEntry,
  type OutputFormat,
  type TSchemaBase,
} from "./types.js";

const UNAVAILABLE_LITE_TOOL_NAMES = new Set(["context_tree_query", "context_prune"]);

export async function createLiteSessionResources(input: {
  cwd: string;
  agentDir: string;
  mode: ResolvedSubagentMode;
  params: {
    customTools?: ToolDefinition[];
    toolNames?: string[];
    outputFormat?: OutputFormat<TSchemaBase>;
  };
  sessionManager: SessionManager;
  structuredCapture: { value?: unknown };
}) {
  const settingsManager = SettingsManager.create(input.cwd, input.agentDir);
  installBundledResourcePaths();
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager,
    extensionFactories: createLiteExtensionFactories(input.mode),
  });
  await resourceLoader.reload();
  return {
    settingsManager,
    resourceLoader,
    customTools: createLiteCustomTools(input.params, input.structuredCapture, input.sessionManager),
    sessionTools: createLiteSessionTools(input.mode, input.params),
  };
}

function createLiteExtensionFactories(mode: ResolvedSubagentMode): ExtensionFactory[] {
  return [
    ...getLiteBundledExtensionFactories({ excludeIds: ["context-prune", "modes"] }),
    createLiteModePromptExtension(mode),
  ];
}

function createLiteModePromptExtension(mode: ResolvedSubagentMode): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", (event) => {
      const systemPrompt = applyModeSystemPrompt(event.systemPrompt, mode);
      return systemPrompt === undefined ? undefined : { systemPrompt };
    });
  };
}

function createLiteCustomTools(
  params: { customTools?: ToolDefinition[]; outputFormat?: OutputFormat<TSchemaBase> },
  structuredCapture: { value?: unknown },
  sessionManager: SessionManager,
): ToolDefinition[] {
  const outputFormat = params.outputFormat;
  if (outputFormat?.type !== "json_schema") return params.customTools ?? [];
  return [
    ...(params.customTools ?? []),
    createStructuredOutputTool(outputFormat.schema, (structuredParams, toolCtx) => {
      structuredCapture.value = structuredParams;
      sessionManager.appendCustomEntry(
        SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
        serializeSubagentStructuredOutputEntry({
          status: "captured",
          attempts: 0,
          retryCount: outputFormat.retryCount ?? 3,
          structured: structuredParams,
          updatedAt: Date.now(),
        }),
      );
      toolCtx.shutdown();
    }),
  ];
}

function createLiteSessionTools(
  mode: ResolvedSubagentMode,
  params: { toolNames?: string[]; outputFormat?: OutputFormat<TSchemaBase> },
): string[] {
  const structuredToolNames =
    params.outputFormat?.type === "json_schema" ? [STRUCTURED_OUTPUT_TOOL_NAME] : [];
  return Array.from(new Set([...mode.tools, ...(params.toolNames ?? []), ...structuredToolNames]))
    .filter((toolName) => toolName !== "subagent")
    .filter((toolName) => !UNAVAILABLE_LITE_TOOL_NAMES.has(toolName))
    .toSorted((left, right) => left.localeCompare(right));
}
