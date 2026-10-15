import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";

import type { PaseoApi } from "@getpaseo/client";
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { z } from "zod";

import {
  isConductor,
  MAX_PARENT_HOPS,
  PARENT_AGENT_LABEL,
} from "../shared/labels.js";
import { progressGuide } from "../shared/progress-guide.js";
import {
  PROGRESS_MCP_SERVER,
  PROGRESS_TOOL,
  progressInputSchema,
} from "../shared/progress.js";
import type { ConductorPaths } from "./paths.js";
import type { ProgressStore } from "./progress-store.js";

const TOOL_DESCRIPTION =
  "Record or read the shared progress dashboard of the conductor you work under; one call per change. " +
  "op=start(title,text); op=ticket(id|title,status,stage,estimate,percent,labels,agent,waitsFor[],parent,related[],note,body,kind); " +
  "op=ticker(text,ticket,percent); op=ask(title,text,options,recommend,ticket,files,multi); op=answer(id,choice,words); " +
  "op=withdraw(id); op=deliver(title,target,ticket); op=stuck(text,ticket)/unstuck(id); op=finish(title=outcome); " +
  "op=show returns the state; op=help prints the guide, call it before first use.";

export const GUIDE_URI = "conductor://progress/guide";
export const STATE_URI = "conductor://progress/state";

export const CAPABILITY_URL_ENV = "CONDUCTOR_PROGRESS_URL";

type Lifecycle = "accepting" | "closing" | "closed";

/** Finds the conductor an agent works for: itself, or the nearest conductor ancestor. */
export async function resolveConductorId(
  paseo: PaseoApi,
  agentId: string,
): Promise<string | null> {
  let current = agentId;
  for (let hop = 0; hop < MAX_PARENT_HOPS; hop += 1) {
    const snapshot = (await paseo.agents.ref(current).refresh())?.agent;
    if (!snapshot) return null;
    const labels = snapshot.labels ?? {};
    if (isConductor(labels)) return current;
    const parent = labels[PARENT_AGENT_LABEL];
    if (!parent) return null;
    current = parent;
  }
  return null;
}

interface RegistryFile {
  port?: number;
  tokens: Record<string, string>;
  /** agentId -> conductorId; parent labels never change, so a resolved link stays valid. */
  conductors?: Record<string, string>;
}

function toolResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError } : {}),
  };
}

/**
 * Local MCP server that gives every agent a `progress` tool bound to its own agent id.
 * Tokens and the port persist so URLs stored in agent configs survive plugin restarts.
 */
export class ProgressToolServer {
  private readonly pending = new Set<string>();
  private tokens = new Map<string, string>();
  private conductors = new Map<string, string>();
  private httpServer: Server | undefined;
  private port = 0;
  private lifecycle: Lifecycle = "accepting";
  private paseo: PaseoApi | undefined;

  constructor(
    private readonly paths: ConductorPaths,
    private readonly store: ProgressStore,
  ) {}

  private get registryFile(): string {
    return path.join(this.paths.root, "progress-tools.json");
  }

  attach(paseo: PaseoApi): void {
    this.paseo ??= paseo;
  }

  async start(): Promise<void> {
    const saved = await readFile(this.registryFile, "utf8")
      .then((raw) => JSON.parse(raw) as RegistryFile)
      .catch((): RegistryFile => ({ tokens: {} }));
    this.tokens = new Map(Object.entries(saved.tokens));
    this.conductors = new Map(Object.entries(saved.conductors ?? {}));

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.post("/mcp/:token", (request, response) => {
      void this.handle(request, response);
    });
    const server = createServer(app);
    const listen = (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Progress MCP server failed to bind"));
            return;
          }
          resolve(address.port);
        });
      });
    this.port = await listen(saved.port ?? 0).catch(() => listen(0));
    this.httpServer = server;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(this.paths.root, { recursive: true });
    const file: RegistryFile = {
      port: this.port,
      tokens: Object.fromEntries(this.tokens),
      conductors: Object.fromEntries(this.conductors),
    };
    await writeFile(this.registryFile, JSON.stringify(file));
  }

  /** Reserves a URL for an agent that has no id yet; `bind` completes it once the id is known. */
  reserve(): string {
    if (this.lifecycle !== "accepting" || !this.port) {
      throw new Error("Progress MCP server is not running");
    }
    const token = randomBytes(24).toString("base64url");
    this.pending.add(token);
    return `http://127.0.0.1:${this.port}/mcp/${token}`;
  }

  /** Binds a reserved URL, or binds directly when the agent id is already known. */
  async bind(url: string, agentId: string): Promise<void> {
    const token = new URL(url).pathname.split("/").at(-1);
    if (!token || !(this.pending.delete(token) || this.tokens.has(token)))
      return;
    this.tokens.set(token, agentId);
    await this.persist();
  }

  async close(): Promise<void> {
    this.lifecycle = "closing";
    const server = this.httpServer;
    this.httpServer = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.lifecycle = "closed";
  }

  /** Caches the agent's conductor early so its tool keeps working across plugin reloads. */
  async warm(agentId: string): Promise<void> {
    await this.conductorOf(agentId);
  }

  /** The agent's conductor: cached, else walked up the parent chain once Paseo is attached. */
  private async conductorOf(agentId: string): Promise<string | null> {
    const cached = this.conductors.get(agentId);
    if (cached) return cached;
    if (!this.paseo) return null;
    const conductorId = await resolveConductorId(this.paseo, agentId).catch(
      () => null,
    );
    if (conductorId) {
      this.conductors.set(agentId, conductorId);
      await this.persist();
    }
    return conductorId;
  }

  /**
   * Agents outside any conductor get an empty tool list, so they pay no schema tokens.
   * Paseo's create hooks cannot see a parent, so this is the earliest point we can decide.
   * Calls are still served: right after a plugin reload Paseo may not be attached yet, and an
   * agent that listed the tool earlier should get a clear error rather than "Method not found".
   */
  private createMcp(agentId: string, conductorId: string | null): McpServer {
    const mcp = new McpServer(
      { name: PROGRESS_MCP_SERVER, version: "0.1.0" },
      { capabilities: { tools: {}, resources: {} } },
    );
    mcp.registerTool(
      PROGRESS_TOOL,
      {
        title: "Conductor progress",
        description: TOOL_DESCRIPTION,
        inputSchema: progressInputSchema.shape,
        // Records to a local log only; most ops append, so none of the stronger hints hold.
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (input) => {
        const target = conductorId ?? (await this.conductorOf(agentId));
        if (!target) {
          return toolResult(
            "You are not working under a conductor, so there is no progress dashboard. If you are, retry in a few seconds.",
            true,
          );
        }
        try {
          return toolResult(
            await this.store.record(
              target,
              progressInputSchema.parse(input),
              agentId,
            ),
          );
        } catch (error) {
          return toolResult(
            error instanceof Error ? error.message : String(error),
            true,
          );
        }
      },
    );
    // The guide and live state as resources too, for clients that read resources on their own.
    mcp.registerResource(
      "guide",
      GUIDE_URI,
      {
        title: "Progress guide",
        description: "How to use the progress tool (same as op=help)",
        mimeType: "text/markdown",
      },
      async (uri) => {
        const target = conductorId ?? (await this.conductorOf(agentId));
        const text = target
          ? await this.store.record(target, { op: "help" }, agentId)
          : progressGuide(this.paths.templatesDir);
        return {
          contents: [{ uri: uri.href, mimeType: "text/markdown", text }],
        };
      },
    );
    mcp.registerResource(
      "state",
      STATE_URI,
      {
        title: "Progress state",
        description: "The current run (same as op=show)",
        mimeType: "text/plain",
      },
      async (uri) => {
        const target = conductorId ?? (await this.conductorOf(agentId));
        const text = target
          ? await this.store.record(target, { op: "show" }, agentId)
          : "You are not working under a conductor.";
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
      },
    );
    if (!conductorId) {
      mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [],
      }));
      mcp.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: [],
      }));
      mcp.server.setRequestHandler(
        ListResourceTemplatesRequestSchema,
        async () => ({ resourceTemplates: [] }),
      );
    }
    return mcp;
  }

  private async handle(request: Request, response: Response): Promise<void> {
    const token = z.string().min(1).safeParse(request.params.token);
    const agentId = token.success ? this.tokens.get(token.data) : undefined;
    if (this.lifecycle !== "accepting" || !agentId) {
      response
        .status(this.lifecycle === "accepting" ? 404 : 503)
        .json({ error: "Unknown progress capability" });
      return;
    }
    const conductorId = await this.conductorOf(agentId);
    const mcp = this.createMcp(agentId, conductorId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: false,
    });
    response.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
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
