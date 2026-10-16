import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hashText } from "../shared/hash";
import { OPENUI_MCP_SERVER, RENDER_TOOL, renderInputSchema } from "../shared/render";
import { componentsText, checkUi, guideText } from "./guide";
import { defineEntry } from "./define";
import { type Library, projectRootOf } from "./library";
import type { Waiters } from "./waiters";

const STATE_DIR = path.join(homedir(), ".paseo", "openui");
const PORT_FILE = path.join(STATE_DIR, "port.json");

const WAIT_LIMIT_MS = 10 * 60 * 1000;

const TOOL_DESCRIPTION = [
  "Show the user a rich, interactive UI (cards, tables, charts, steps, diffs, forms) in the Paseo app instead of text or markdown.",
  "`ui` is a program in OpenUI Lang. Before your first render, call this tool once with guide=true (no ui) to get the syntax and component reference.",
  'Tiny example: root = Stack([Heading("Done"), Callout("All checks passed", "success")])',
  "Set wait=true to block until the user answers a Form or Button, and get their answer as the result. Otherwise the answer arrives later as a message.",
  "Alternative without a tool call: put the program in a ```openui fenced block in your reply text and the app draws it the same way, in line with your prose.",
].join(" ");

const INSTRUCTIONS = [
  "Paseo can render rich interactive UI for the user with the render tool.",
  "Prefer it over long markdown when explaining architecture or flows, comparing options, reporting status or plans, showing data or diffs, or asking the user a structured question.",
  "Call render with guide=true once to learn the component set.",
  "You can also write a program in a ```openui fenced block inside your reply text; the app draws it as the same UI, in line with your prose.",
  "Taps and form answers come back wrapped in <openui-answer>: its <message> says what was tapped and <values> holds the form fields as JSON.",
  "Keep plain text for short answers.",
].join(" ");

const GUIDE_URI = "openui://guide";

function createMcp(waiters: Waiters, library: Library, projectRoot: string | undefined): McpServer {
  const mcp = new McpServer(
    { name: OPENUI_MCP_SERVER, version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  );
  mcp.registerTool(
    RENDER_TOOL,
    {
      title: "Render UI",
      description: TOOL_DESCRIPTION,
      inputSchema: renderInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, extra) => {
      if (input.guide) return textResult(`${guideText()}\n\n${componentsText(await library.snapshot(projectRoot), true)}`);
      if (input.define) {
        const outcome = await defineEntry(library, projectRoot, input.define);
        return textResult(outcome.text, outcome.isError);
      }
      if (!input.ui) {
        return textResult("Pass `ui` (an OpenUI Lang program), or guide=true for the reference.", true);
      }
      const expanded = await library.expand(input.ui, projectRoot);
      if (expanded.errors.length > 0) {
        return textResult(`Fix these component problems and call render again:\n- ${expanded.errors.join("\n- ")}`, true);
      }
      const report = checkUi(expanded.ui);
      const notes = report.warnings.length ? `\nWarnings:\n- ${report.warnings.join("\n- ")}` : "";
      if (report.errors.length > 0) {
        return textResult(
          `The UI has problems and part of it was dropped. Fix these and call render again:\n- ${report.errors.join("\n- ")}${notes}`,
          true,
        );
      }
      if (!input.wait) {
        return textResult(`Rendered for the user.${notes}\nTheir taps and form answers reach you as a later <openui-answer> message.`);
      }
      const answer = await waiters.wait(hashText(input.ui), WAIT_LIMIT_MS, extra.signal);
      return textResult(
        answer ??
          "The user has not answered yet. The UI stays on screen and their answer will reach you as a message.",
      );
    },
  );
  mcp.registerResource(
    "guide",
    GUIDE_URI,
    { title: "OpenUI guide", description: "Syntax and component reference for render", mimeType: "text/markdown" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: `${guideText()}\n\n${componentsText(await library.snapshot(projectRoot), true)}` }],
    }),
  );
  return mcp;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

/**
 * One stateless HTTP MCP endpoint shared by every agent. Rendering needs no agent identity: the
 * timeline renderer already knows its own agent. The port persists so URLs stored in agent
 * configs survive plugin reloads.
 */
export class RenderToolServer {
  private httpServer: Server | undefined;
  private port = 0;

  constructor(
    private readonly waiters: Waiters,
    private readonly library: Library,
  ) {}

  get url(): string {
    if (!this.port) throw new Error("OpenUI MCP server is not running");
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  async start(): Promise<void> {
    const saved = await readFile(PORT_FILE, "utf8")
      .then((raw) => (JSON.parse(raw) as { port?: number }).port)
      .catch(() => undefined);
    const server = createServer((request, response) => {
      if (new URL(request.url ?? "/", "http://localhost").pathname !== "/mcp") {
        response.writeHead(404).end();
      } else if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" }).end();
      } else {
        void this.handle(request, response);
      }
    });
    const listen = (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("OpenUI MCP server failed to bind"));
            return;
          }
          resolve(address.port);
        });
      });
    this.port = await listen(saved ?? 0).catch(() => listen(0));
    this.httpServer = server;
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(PORT_FILE, JSON.stringify({ port: this.port }));
  }

  async close(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const cwd = new URL(request.url ?? "/", "http://localhost").searchParams.get("cwd");
    const mcp = createMcp(this.waiters, this.library, cwd ? await projectRootOf(cwd) : undefined);
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
      await transport.handleRequest(request, response);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
          }),
        );
      }
    }
  }
}
