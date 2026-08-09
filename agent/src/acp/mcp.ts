import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  defineTool,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { isRecord } from "../utils/unknown-data.js";

export interface AcpMcpServer {
  type: string;
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface AcpMcpManager {
  readonly extensionFactories: InlineExtension[];
  readonly toolDefinitions: ToolDefinition[];
  dispose(): Promise<void>;
}

export async function createAcpMcpManager(
  servers: readonly AcpMcpServer[],
  cwd: string,
): Promise<AcpMcpManager> {
  const clients: Client[] = [];
  const definitionsByServer: Array<{ serverName: string; definitions: ToolDefinition[] }> = [];
  try {
    for (const server of servers) {
      if (server.type !== "stdio")
        throw new TypeError(`Unsupported ACP MCP transport: ${server.type}`);
      if (server.command === undefined)
        throw new TypeError(`ACP MCP stdio server lacks command: ${server.name}`);
      const client = new Client({ name: "pi-acp", version: "0.84.1" });
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        cwd,
        env: { ...getDefaultEnvironment(), ...server.env },
        stderr: "pipe",
      });
      await client.connect(transport);
      clients.push(client);
      const listed = await client.listTools();
      definitionsByServer.push({
        serverName: server.name,
        definitions: listed.tools.map((tool) => createMcpToolDefinition(client, tool)),
      });
    }
  } catch (error) {
    await Promise.allSettled(clients.map((client) => client.close()));
    throw error;
  }

  const extensionFactories: InlineExtension[] = definitionsByServer.map(
    ({ serverName, definitions }) =>
      (pi) => {
        const occupiedNames = new Set(pi.getAllTools().map((tool) => tool.name));
        for (const definition of definitions) {
          const name = resolveMcpToolName(definition.name, serverName, occupiedNames);
          pi.registerTool({ ...definition, name, label: name });
          occupiedNames.add(name);
        }
      },
  );
  return {
    extensionFactories,
    toolDefinitions: definitionsByServer.flatMap((entry) => entry.definitions),
    async dispose() {
      await Promise.allSettled(clients.map((client) => client.close()));
    },
  };
}

export function resolveMcpToolName(
  toolName: string,
  serverName: string,
  occupiedNames: ReadonlySet<string>,
): string {
  if (!occupiedNames.has(toolName)) return toolName;
  const prefix = serverName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_|_$/g, "");
  const base = `${prefix || "mcp"}__${toolName}`;
  let candidate = base;
  let suffix = 2;
  while (occupiedNames.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function createMcpToolDefinition(
  client: Client,
  tool: Awaited<ReturnType<Client["listTools"]>>["tools"][number],
): ToolDefinition {
  const parameters = Type.Unsafe<Record<string, unknown>>(tool.inputSchema);
  return defineTool<typeof parameters>({
    name: tool.name,
    label: tool.annotations?.title ?? tool.name,
    description: tool.description ?? `MCP tool ${tool.name}`,
    parameters,
    async execute(_toolCallId, params, signal) {
      const result = await client.callTool({ name: tool.name, arguments: params }, undefined, {
        signal,
      });
      if (!("content" in result) || !Array.isArray(result.content)) {
        return {
          content: [{ type: "text", text: JSON.stringify(result.toolResult) }],
          details: result,
        };
      }
      const content: Array<TextContent | ImageContent> = [];
      for (const block of result.content) {
        if (!isRecord(block) || typeof block.type !== "string") continue;
        if (block.type === "text" && typeof block.text === "string") {
          content.push({ type: "text", text: block.text });
          continue;
        }
        if (
          block.type === "image" &&
          typeof block.data === "string" &&
          typeof block.mimeType === "string"
        ) {
          content.push({ type: "image", data: block.data, mimeType: block.mimeType });
          continue;
        }
        if (
          block.type === "resource_link" &&
          typeof block.name === "string" &&
          typeof block.uri === "string"
        ) {
          content.push({ type: "text", text: `[Resource: ${block.name}] ${block.uri}` });
          continue;
        }
        if (block.type === "resource" && isRecord(block.resource)) {
          const resource = block.resource;
          content.push({
            type: "text",
            text:
              typeof resource.text === "string" && typeof resource.uri === "string"
                ? `<resource uri="${resource.uri}">\n${resource.text}\n</resource>`
                : `[Binary resource: ${String(resource.uri)}]`,
          });
          continue;
        }
        content.push({ type: "text", text: `[Unsupported MCP content: ${block.type}]` });
      }
      if (result.isError === true) {
        throw new TypeError(
          content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n"),
        );
      }
      return { content, details: result };
    },
  });
}
