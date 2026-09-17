import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { z } from "zod";

import {
  createAgentInputSchema,
  type WorkOwner,
  type WorkService,
} from "./work-service.js";

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

/** Opaque MCP capability binding. Project id is absent for unregistered Git roots. */
export interface CapabilityBinding {
  canonicalRoot: string;
  paseoProjectId?: string;
  paseoWorkspaceId?: string;
}

const UNREGISTERED_PROJECT_MESSAGE =
  "This CubeSandbox capability is not associated with a registered Paseo project. Open or create this agent inside a registered project to manage Work Sandboxes.";

type ToolServerLifecycle = "accepting" | "closing" | "closed";

function createRepositoryToolServer(
  binding: CapabilityBinding,
  works: WorkService,
): McpServer {
  const owner: WorkOwner | null = binding.paseoProjectId
    ? {
        paseoProjectId: binding.paseoProjectId,
        ...(binding.paseoWorkspaceId
          ? { paseoWorkspaceId: binding.paseoWorkspaceId }
          : {}),
        canonicalRoot: binding.canonicalRoot,
      }
    : null;
  const requireOwner = (): WorkOwner => {
    if (!owner) throw new Error(UNREGISTERED_PROJECT_MESSAGE);
    return owner;
  };
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
            requireOwner(),
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
          path: await works.initializeConfig(binding.canonicalRoot),
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
          await works.sendPrompt(requireOwner(), sendPromptSchema.parse(input)),
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
        return toolResult(await works.getStatus(requireOwner(), workId));
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
          activity: await works.getActivity(requireOwner(), workId, limit),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  server.registerTool(
    "cube_list_work",
    {
      description: "List Work Sandboxes owned by this project capability.",
      inputSchema: {},
    },
    async () => toolResult({ works: await works.list(requireOwner(), false) }),
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
        const work = await works.getStatus(requireOwner(), workId);
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
        return toolResult(await works.pause(requireOwner(), workId));
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
        await works.destroy(requireOwner(), workId);
        return toolResult({ workId, destroyed: true });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  return server;
}

export class CubeToolServer {
  private readonly capabilities = new Map<string, CapabilityBinding>();
  private readonly inFlightRequests = new Set<Promise<void>>();
  private httpServer: Server | undefined;
  private port: number | undefined;
  private lifecycle: ToolServerLifecycle = "accepting";
  private closePromise: Promise<void> | undefined;

  constructor(private readonly works: WorkService) {}

  async start(): Promise<void> {
    if (this.lifecycle !== "accepting") {
      throw new Error(`CubeSandbox MCP server is ${this.lifecycle}`);
    }
    if (this.httpServer) return;
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.post("/mcp/:token", (request, response) => {
      if (this.lifecycle !== "accepting") {
        response
          .status(503)
          .json({ error: "CubeSandbox MCP server is closing" });
        return;
      }
      const operation = this.handleRequest(request, response);
      this.inFlightRequests.add(operation);
      void operation.then(
        () => this.inFlightRequests.delete(operation),
        () => this.inFlightRequests.delete(operation),
      );
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

  createCapability(binding: CapabilityBinding): string {
    if (this.lifecycle !== "accepting") {
      throw new Error(`CubeSandbox MCP server is ${this.lifecycle}`);
    }
    if (!this.port) throw new Error("CubeSandbox MCP server is not started");
    const token = randomBytes(32).toString("base64url");
    this.capabilities.set(token, binding);
    return `http://127.0.0.1:${this.port}/mcp/${token}`;
  }

  capabilityForToken(token: string): CapabilityBinding | undefined {
    return this.capabilities.get(token);
  }

  stopAccepting(): void {
    if (this.lifecycle === "accepting") this.lifecycle = "closing";
    this.capabilities.clear();
  }

  close(): Promise<void> {
    this.stopAccepting();
    this.closePromise ??= this.closeResources().finally(() => {
      this.lifecycle = "closed";
    });
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = undefined;
    this.port = undefined;
    const closeServer = server
      ? new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
      : Promise.resolve();
    const results = await Promise.allSettled([
      closeServer,
      ...this.inFlightRequests,
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Failed to close CubeSandbox MCP server cleanly",
      );
    }
  }

  private async handleRequest(
    request: Request,
    response: Response,
  ): Promise<void> {
    const token = z.string().min(1).safeParse(request.params.token);
    const binding = token.success
      ? this.capabilities.get(token.data)
      : undefined;
    if (!binding) {
      response.status(404).json({ error: "Unknown CubeSandbox capability" });
      return;
    }
    const server = createRepositoryToolServer(binding, this.works);
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
