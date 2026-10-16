import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";

import type { PaseoApi } from "@getpaseo/client";
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

/**
 * The conductor an agent works for (itself or the nearest conductor ancestor), or why there is
 * none. "unregistered": Paseo has no record of the agent yet. Pi connects its MCP servers inside
 * session creation, before Paseo registers the agent with its parent, so this is not "no".
 */
export type Resolution =
  | { conductorId: string }
  | {
      conductorId: null;
      reason: "unregistered" | "no conductor" | "paseo not attached";
    };

export async function resolveConductorId(
  paseo: PaseoApi,
  agentId: string,
): Promise<Resolution> {
  let current = agentId;
  for (let hop = 0; hop < MAX_PARENT_HOPS; hop += 1) {
    const snapshot = (await paseo.agents.ref(current).refresh())?.agent;
    if (!snapshot)
      return {
        conductorId: null,
        reason: hop === 0 ? "unregistered" : "no conductor",
      };
    const labels = snapshot.labels ?? {};
    if (isConductor(labels)) return { conductorId: current };
    const parent = labels[PARENT_AGENT_LABEL];
    if (!parent) return { conductorId: null, reason: "no conductor" };
    current = parent;
  }
  return { conductorId: null, reason: "no conductor" };
}

interface RegistryFile {
  port?: number;
  tokens: Record<string, string>;
  /** agentId -> conductorId; parents never change, so a link stays valid until an archive. */
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

    const server = createServer((request, response) => {
      const [root, token, extra] = new URL(request.url ?? "/", "http://localhost")
        .pathname.split("/")
        .filter(Boolean);
      if (root !== "mcp" || !token || extra !== undefined) {
        response.writeHead(404).end();
      } else if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" }).end();
      } else {
        void this.handle(request, response, token);
      }
    });
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

  /** Caches the agent's conductor once Paseo has registered it, so reloads keep its tool. */
  async warm(agentId: string): Promise<void> {
    await this.resolve(agentId);
  }

  /** Drops links to or from an archived agent; anything still live resolves again on use. */
  async forget(agentId: string): Promise<void> {
    let changed = false;
    for (const [agent, conductor] of this.conductors)
      if (agent === agentId || conductor === agentId) {
        this.conductors.delete(agent);
        changed = true;
      }
    if (changed) await this.persist();
  }

  /** Cached links only; "no" is never cached, since the answer can still change to yes. */
  private async resolve(agentId: string): Promise<Resolution> {
    const cached = this.conductors.get(agentId);
    if (cached) return { conductorId: cached };
    if (!this.paseo) return { conductorId: null, reason: "paseo not attached" };
    const resolution = await resolveConductorId(this.paseo, agentId).catch(
      (): Resolution => ({ conductorId: null, reason: "unregistered" }),
    );
    if (resolution.conductorId) {
      this.conductors.set(agentId, resolution.conductorId);
      await this.persist();
    }
    return resolution;
  }

  private async conductorOf(agentId: string): Promise<string | null> {
    return (await this.resolve(agentId)).conductorId;
  }

  /**
   * Agents known to be outside any conductor get an empty tool list, so they pay no schema
   * tokens. When we can't tell yet (the agent isn't registered, or Paseo isn't attached after a
   * reload) the tool is listed and gated per call instead: clients like Pi list tools once, while
   * the agent is still being created, and keep that list for the whole session.
   */
  private createMcp(agentId: string, resolution: Resolution): McpServer {
    const conductorId = resolution.conductorId;
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
    if (
      resolution.conductorId === null &&
      resolution.reason === "no conductor"
    ) {
      mcp.server.setRequestHandler(ListToolsRequestSchema, async () => {
        console.log(
          `Conductor progress tool hidden from ${agentId}: no conductor in its parent chain`,
        );
        return { tools: [] };
      });
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

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
    rawToken: string,
  ): Promise<void> {
    const token = z.string().min(1).safeParse(rawToken);
    const agentId = token.success ? this.tokens.get(token.data) : undefined;
    if (this.lifecycle !== "accepting" || !agentId) {
      if (this.lifecycle === "accepting")
        console.log(
          `Conductor progress tool: unknown token ${token.success ? `${token.data.slice(0, 6)}…` : "(none)"}, its agent was created before this registry or never opened a session`,
        );
      sendJson(response, this.lifecycle === "accepting" ? 404 : 503, {
        error: "Unknown progress capability",
      });
      return;
    }
    const body = await readJsonBody(request);
    if (body === BAD_BODY) {
      sendJson(response, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: invalid or oversized JSON" },
      });
      return;
    }
    const resolution = await this.resolve(agentId);
    if (
      resolution.conductorId === null &&
      resolution.reason !== "no conductor" &&
      (body as { method?: unknown } | undefined)?.method === "tools/list"
    )
      console.log(
        `Conductor progress tool served gated to ${agentId}: ${resolution.reason}, checked again per call`,
      );
    const mcp = this.createMcp(agentId, resolution);
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
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 500, {
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

const BODY_LIMIT_BYTES = 1024 * 1024;
const BAD_BODY = Symbol("bad body");

/** The request's JSON body, or BAD_BODY when it is malformed or over the limit. */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > BODY_LIMIT_BYTES) return BAD_BODY;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return BAD_BODY;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));
}
