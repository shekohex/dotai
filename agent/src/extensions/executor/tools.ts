import { Type } from "typebox";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ResumeAction } from "./mcp-client.js";
import { withExecutorMcpClient } from "./mcp-client.js";
import {
  buildExecutorSystemPrompt,
  parseJsonContent,
  toToolResult,
  type ExecuteToolDetails,
  type ExecuteToolResult,
} from "./executor-adapter.js";
import { connectExecutor } from "./status.js";
import { promptForInteraction } from "./tools-interaction.js";
import { executeToolParams, jsonStringSchema, type ExecuteRenderState } from "./tools-shared.js";
import { renderExecuteToolCall, renderExecuteToolResult } from "./tools-render.js";
import { clearExecutorInspectionCache, loadExecutorDescriptions } from "./tools-descriptions.js";

const runExecuteTool = async (
  pi: ExtensionAPI,
  params: { code: string },
  ctx: ExtensionContext,
): Promise<ExecuteToolResult> => {
  const endpoint = await connectExecutor(pi, ctx);
  const startedAt = Date.now();
  const outcome = await withExecutorMcpClient(
    endpoint.mcpUrl,
    {
      hasUI: ctx.hasUI,
      onElicitation: ctx.hasUI
        ? (interaction) =>
            promptForInteraction(
              interaction.mode === "url"
                ? {
                    mode: "url",
                    message: interaction.message,
                    url: interaction.url,
                  }
                : {
                    mode: "form",
                    message: interaction.message,
                    requestedSchema: interaction.requestedSchema,
                  },
              ctx,
            )
        : undefined,
    },
    (client) => client.execute(params.code),
  );
  const result = toToolResult(outcome, {
    baseUrl: endpoint.mcpUrl,
    durationMs: Date.now() - startedAt,
  });
  activateResumeToolForPausedExecution(pi, result);
  return result;
};

export function activateResumeToolForPausedExecution(
  pi: ExtensionAPI,
  result: ExecuteToolResult,
): void {
  if (result.details.executionId === undefined) return;
  if (!pi.getAllTools().some((tool) => tool.name === "resume")) return;
  const activeTools = pi.getActiveTools();
  if (activeTools.includes("resume")) return;
  pi.setActiveTools([...activeTools, "resume"]);
}

export const createExecuteToolDefinition = (pi: ExtensionAPI, description: string) =>
  defineTool<typeof executeToolParams, ExecuteToolDetails, ExecuteRenderState>({
    name: "execute",
    label: "Execute",
    renderShell: "self",
    description: [
      description,
      "Load the executor skill before use. Inside execute, discover tools with tools.search({ query, limit }), inspect unfamiliar tools with tools.describe.tool({ path }), then call exact paths with tools[path](args).",
    ].join(" "),
    parameters: executeToolParams,
    renderCall: renderExecuteToolCall,
    renderResult: renderExecuteToolResult,
    execute: (_toolCallId, params, _signal, _onUpdate, ctx): Promise<ExecuteToolResult> =>
      runExecuteTool(pi, params, ctx),
  });

const buildResumeTool = (pi: ExtensionAPI, description: string) =>
  defineTool({
    name: "resume",
    label: "Resume",
    description: `${description} Use the exact executionId returned by execute.`,
    parameters: Type.Object({
      executionId: Type.String({ description: "The execution ID from the paused result" }),
      action: Type.Union([Type.Literal("accept"), Type.Literal("decline"), Type.Literal("cancel")]),
      content: Type.Optional(jsonStringSchema),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ExecuteToolResult> {
      const endpoint = await connectExecutor(pi, ctx);
      const startedAt = Date.now();

      const outcome = await withExecutorMcpClient(endpoint.mcpUrl, { hasUI: false }, (client) =>
        client.resume(
          params.executionId,
          params.action as ResumeAction,
          parseJsonContent(params.content),
        ),
      );

      return toToolResult(outcome, {
        baseUrl: endpoint.mcpUrl,
        durationMs: Date.now() - startedAt,
      });
    },
  });

export const loadExecutorPrompt = async (cwd: string, hasUI: boolean): Promise<string> => {
  const { executeDescription } = await loadExecutorDescriptions(cwd, hasUI);
  return buildExecutorSystemPrompt(executeDescription, !hasUI);
};

export const isExecutorToolDetails = (value: object | null): value is ExecuteToolDetails => {
  if (!value || !("baseUrl" in value) || !("isError" in value)) {
    return false;
  }

  return typeof value.baseUrl === "string" && typeof value.isError === "boolean";
};

export const createExecutorTools = async (
  pi: ExtensionAPI,
  cwd: string,
  hasUI: boolean,
): Promise<ToolDefinition[]> => {
  const { executeDescription, resumeDescription } = await loadExecutorDescriptions(cwd, hasUI);
  if (hasUI) {
    return [createExecuteToolDefinition(pi, executeDescription)];
  }

  return [
    createExecuteToolDefinition(pi, executeDescription),
    buildResumeTool(pi, resumeDescription),
  ];
};

export const registerExecutorTools = async (
  pi: ExtensionAPI,
  cwd: string,
  hasUI: boolean,
): Promise<void> => {
  for (const tool of await createExecutorTools(pi, cwd, hasUI)) {
    pi.registerTool(tool);
  }
};

export { clearExecutorInspectionCache };
