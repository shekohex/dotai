import { Type } from "@sinclair/typebox";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
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
  return toToolResult(outcome, {
    baseUrl: endpoint.mcpUrl,
    scopeId: endpoint.scope.id,
    durationMs: Date.now() - startedAt,
  });
};

export const createExecuteToolDefinition = (pi: ExtensionAPI, description: string) =>
  defineTool<typeof executeToolParams, ExecuteToolDetails, ExecuteRenderState>({
    name: "execute",
    label: "Execute",
    renderShell: "self",
    description,
    promptSnippet: "Execute TypeScript in Executor's sandboxed runtime with configured API tools.",
    promptGuidelines: [
      "Search inside execute before calling Executor tools directly in code.",
      "Use execute instead of top-level helper tools for Executor discovery and invocation.",
      "load the `executor` skill first before using this tool, it will explain it in details and how to use it",
    ],
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
    description,
    promptSnippet:
      "Resume a paused Executor execution after the user has completed the required interaction.",
    promptGuidelines: ["Use the exact executionId returned by execute."],
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
        scopeId: endpoint.scope.id,
        durationMs: Date.now() - startedAt,
      });
    },
  });

export const loadExecutorPrompt = async (cwd: string, hasUI: boolean): Promise<string> => {
  const { executeDescription } = await loadExecutorDescriptions(cwd, hasUI);
  return buildExecutorSystemPrompt(executeDescription, !hasUI);
};

export const isExecutorToolDetails = (value: object | null): value is ExecuteToolDetails => {
  if (!value || !("baseUrl" in value) || !("scopeId" in value) || !("isError" in value)) {
    return false;
  }

  return (
    typeof value.baseUrl === "string" &&
    typeof value.scopeId === "string" &&
    typeof value.isError === "boolean"
  );
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
