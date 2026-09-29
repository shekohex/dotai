import { createCodemodeToolDefinition } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/tool.js";
import { createToolSearchToolDefinition } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/tool-search/tool.js";
import { createMcpToolDefinition } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/tools.js";
import { styleNativeToolDefinition } from "../src/extensions/coreui/tools-native.js";
import type { ToolPreviewScenario } from "./tool-preview-scenarios.js";

export function getNativeToolPreviewScenarios(cwd: string): ToolPreviewScenario[] {
  const code =
    'const results = await Promise.allSettled([\n  tools.mcp__executor__list_projects({}),\n  tools.read({ path: "README.md" }),\n]);\ntext(results);';
  const calls = [
    {
      id: "script/1",
      name: "mcp__executor__list_projects",
      args: "{}",
      status: "ok",
      durationMs: 180,
    },
    { id: "script/2", name: "read", args: '{"path":"README.md"}', status: "ok", durationMs: 12 },
    { id: "script/3", name: "models.classify", args: "{}", status: "ok", cost: 0.002 },
    { id: "script/4", name: "models.classify", args: "{}", status: "ok", cost: 0.003 },
  ];
  const output = Array.from({ length: 9 }, (_, index) => `Project ${index + 1}`).join("\n");
  return [
    {
      id: "codemode:native",
      title: "Codemode",
      toolName: "codemode",
      cwd,
      toolDefinition: styleNativeToolDefinition(createCodemodeToolDefinition(), "codemode"),
      args: { code },
      successResult: {
        content: [
          { type: "text", text: "Script completed\nWall time 0.192 seconds\nOutput:\n" },
          { type: "text", text: output },
        ],
        details: { calls, fullOutputPath: "/tmp/pi-codemode-full.txt" },
      },
      partialResult: { content: [], details: { calls: [{ ...calls[0], status: "running" }] } },
      errorResult: {
        content: [{ type: "text", text: "Script error: permission denied" }],
        details: { calls: [{ ...calls[0], status: "error", error: "permission denied" }] },
      },
    },
    {
      id: "tool-search:native",
      title: "Tool search",
      toolName: "tool_search",
      cwd,
      toolDefinition: styleNativeToolDefinition(createToolSearchToolDefinition(), "tool-search"),
      args: { query: "projects", limit: 8 },
      successResult: {
        content: [
          {
            type: "text",
            text: "Loaded 1 tool. They are available from your next call:\n- mcp__executor__list_projects: List projects",
          },
        ],
        details: { loaded: ["mcp__executor__list_projects"] },
      },
      errorResult: { content: [{ type: "text", text: "query must not be empty" }] },
    },
    {
      id: "mcp:native",
      title: "MCP",
      toolName: "mcp__executor__list_projects",
      cwd,
      toolDefinition: styleNativeToolDefinition(
        createMcpToolDefinition({
          server: "executor",
          name: "mcp__executor__list_projects",
          exposure: "direct",
          namespace: { name: "executor" },
          timeoutMs: 1000,
          tool: {
            name: "list_projects",
            inputSchema: { type: "object", properties: { owner: { type: "string" } } },
          },
          getClient: async () => {
            throw new Error("Preview must not execute MCP calls");
          },
        }),
        "mcp",
      ),
      args: { owner: "team" },
      successResult: {
        content: [{ type: "text", text: output }],
        details: { server: "executor", tool: "list_projects" },
      },
      partialResult: { content: [{ type: "text", text: "Loading projects 2/9" }] },
      errorResult: { content: [{ type: "text", text: "MCP connection failed" }] },
    },
  ];
}
