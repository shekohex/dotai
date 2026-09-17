import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { z } from "zod";

import { createAgentInputSchema, type WorkService } from "./work-service.js";

const workIdSchema = z.object({ workId: z.string().uuid() }).strict();
const sendPromptSchema = z
  .object({
    workId: z.string().uuid(),
    prompt: z.string().min(1),
    agentId: z.string().min(1).optional(),
  })
  .strict();
const activitySchema = z
  .object({
    workId: z.string().uuid(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function createRepositoryToolServer(
  repositoryRoot: string,
  works: WorkService,
): McpServer {
  const server = new McpServer({ name: "cubesandbox-paseo", version: "0.1.0" });

  server.registerTool(
    "cube_create_agent",
    {
      description:
        "Create a Work Sandbox and first remote Paseo worktree agent, or add another isolated worktree agent to an existing workId.",
      inputSchema: createAgentInputSchema.shape,
    },
    async (input) => {
      try {
        return toolResult(
          await works.createAgent(
            repositoryRoot,
            createAgentInputSchema.parse(input),
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  server.registerTool(
    "cube_init_config",
    {
      description:
        "Create only .cube/config.json for this Git repository. Refuses to overwrite existing configuration.",
      inputSchema: {},
    },
    async () => {
      try {
        return toolResult({
          path: await works.initializeRepository(repositoryRoot),
          created: true,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  server.registerTool(
    "cube_send_prompt",
    {
      description:
        "Auto-resume a managed Work Sandbox and send a prompt to one of its remote agents.",
      inputSchema: sendPromptSchema.shape,
    },
    async (input) => {
      try {
        return toolResult(
          await works.sendPrompt(repositoryRoot, sendPromptSchema.parse(input)),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  server.registerTool(
    "cube_get_status",
    {
      description: "Get lifecycle and agent status for a managed Work Sandbox.",
      inputSchema: workIdSchema.shape,
    },
    async (input) => {
      try {
        const { workId } = workIdSchema.parse(input);
        return toolResult(await works.getStatus(repositoryRoot, workId));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  server.registerTool(
    "cube_get_activity",
    {
      description:
        "Get recent local lifecycle activity for a managed Work Sandbox.",
      inputSchema: activitySchema.shape,
    },
    async (input) => {
      try {
        const { workId, limit } = activitySchema.parse(input);
        return toolResult({
          activity: await works.getActivity(repositoryRoot, workId, limit),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  server.registerTool(
    "cube_list_work",
    {
      description: "List Work Sandboxes owned by this repository capability.",
      inputSchema: {},
    },
    async () => toolResult({ works: await works.list(repositoryRoot, false) }),
  );
  server.registerTool(
    "cube_get_ports",
    {
      description: "Get configured preview URLs for a managed Work Sandbox.",
      inputSchema: workIdSchema.shape,
    },
    async (input) => {
      try {
        const { workId } = workIdSchema.parse(input);
        const work = await works.getStatus(repositoryRoot, workId);
        return toolResult({ workId, previewUrls: work.previewUrls });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  server.registerTool(
    "cube_pause_work",
    {
      description: "Immediately pause a managed Work Sandbox.",
      inputSchema: workIdSchema.shape,
    },
    async (input) => {
      try {
        const { workId } = workIdSchema.parse(input);
        return toolResult(await works.pause(repositoryRoot, workId));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  server.registerTool(
    "cube_destroy_work",
    {
      description:
        "Immediately and permanently destroy a managed Work Sandbox without confirmation.",
      inputSchema: workIdSchema.shape,
    },
    async (input) => {
      try {
        const { workId } = workIdSchema.parse(input);
        await works.destroy(repositoryRoot, workId);
        return toolResult({ workId, destroyed: true });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  return server;
}

export class CubeToolServer {
  private readonly capabilities = new Map<string, string>();
  private httpServer: Server | undefined;
  private port: number | undefined;

  constructor(private readonly works: WorkService) {}

  async start(): Promise<void> {
    if (this.httpServer) return;
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.post("/mcp/:token", (request, response) => {
      void this.handleRequest(request, response);
    });
    const httpServer = createServer(app);
    const port = await new Promise<number>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => {
        const address = httpServer.address();
        if (!address || typeof address === "string") {
          reject(new Error("CubeSandbox MCP server failed to bind a TCP port"));
          return;
        }
        resolve(address.port);
      });
    });
    this.httpServer = httpServer;
    this.port = port;
  }

  createCapability(repositoryRoot: string): string {
    if (!this.port) throw new Error("CubeSandbox MCP server is not started");
    const token = randomBytes(32).toString("base64url");
    this.capabilities.set(token, repositoryRoot);
    this.works.bindRepositoryRoot(repositoryRoot);
    return `http://127.0.0.1:${this.port}/mcp/${token}`;
  }

  repositoryRootForToken(token: string): string | undefined {
    return this.capabilities.get(token);
  }

  async close(): Promise<void> {
    this.capabilities.clear();
    const server = this.httpServer;
    this.httpServer = undefined;
    this.port = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handleRequest(
    request: Request,
    response: Response,
  ): Promise<void> {
    const token = z.string().min(1).safeParse(request.params.token);
    const repositoryRoot = token.success
      ? this.capabilities.get(token.data)
      : undefined;
    if (!repositoryRoot) {
      response.status(404).json({ error: "Unknown CubeSandbox capability" });
      return;
    }
    const server = createRepositoryToolServer(repositoryRoot, this.works);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: false,
    });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }
}
