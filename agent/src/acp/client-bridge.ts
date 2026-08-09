import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type BashOperations,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { CoreUIToolOverrides } from "../extensions/coreui/tool-overrides.js";
import { WorkspaceRoots } from "./roots.js";

interface ClientRequester {
  request<Response>(method: string, params: unknown): Promise<Response>;
}

export interface V1ClientCapabilities {
  readTextFile: boolean;
  writeTextFile: boolean;
  terminal: boolean;
}

export interface AcpClientToolOverrides {
  coreUi: CoreUIToolOverrides;
}

export interface AcpClientBridge {
  createToolOverrides(cwd: string): Promise<AcpClientToolOverrides>;
}

export function createV1ClientBridge(
  client: ClientRequester,
  sessionId: string,
  capabilities: V1ClientCapabilities,
): AcpClientBridge {
  return {
    async createToolOverrides(cwd) {
      const roots = await WorkspaceRoots.create(cwd, []);
      const coreUi: CoreUIToolOverrides = {};
      if (capabilities.readTextFile) {
        const operations = createReadOperations(client, sessionId, roots);
        coreUi.read = (toolCwd) => createReadToolDefinition(toolCwd, { operations });
      }
      if (capabilities.writeTextFile) {
        const operations = createWriteOperations(client, sessionId, roots);
        coreUi.write = (toolCwd) => createWriteToolDefinition(toolCwd, { operations });
      }
      if (capabilities.readTextFile && capabilities.writeTextFile) {
        const operations = createEditOperations(client, sessionId, roots);
        coreUi.edit = (toolCwd) => createEditToolDefinition(toolCwd, { operations });
      }
      if (capabilities.terminal) {
        const operations = createTerminalOperations(client, sessionId);
        coreUi.bash = (toolCwd) => createBashToolDefinition(toolCwd, { operations });
      }
      return { coreUi };
    },
  };
}

function createReadOperations(
  client: ClientRequester,
  sessionId: string,
  roots: WorkspaceRoots,
): ReadOperations {
  const readFile = async (path: string): Promise<Buffer> => {
    await roots.assertExistingPath(path);
    const response = await client.request<{ content: string }>("fs/read_text_file", {
      sessionId,
      path,
    });
    return Buffer.from(response.content);
  };
  return { readFile, access: async (path) => void (await readFile(path)) };
}

function createWriteOperations(
  client: ClientRequester,
  sessionId: string,
  roots: WorkspaceRoots,
): WriteOperations {
  return {
    async writeFile(path, content) {
      await roots.assertCreatablePath(path);
      await client.request("fs/write_text_file", { sessionId, path, content });
    },
    async mkdir(path) {
      await roots.assertCreatablePath(`${path}/.acp-write`);
    },
  };
}

function createEditOperations(
  client: ClientRequester,
  sessionId: string,
  roots: WorkspaceRoots,
): EditOperations {
  const read = createReadOperations(client, sessionId, roots);
  const write = createWriteOperations(client, sessionId, roots);
  return {
    readFile: read.readFile,
    writeFile: write.writeFile,
    access: async (path) => void (await read.readFile(path)),
  };
}

function createTerminalOperations(client: ClientRequester, sessionId: string): BashOperations {
  return {
    async exec(command, cwd, options) {
      const shell = process.env.SHELL ?? "/bin/sh";
      const created = await client.request<{ terminalId: string }>("terminal/create", {
        sessionId,
        command: shell,
        args: ["-lc", command],
        cwd,
        env: Object.entries(options.env ?? {}).flatMap(([name, value]) =>
          value === undefined ? [] : [{ name, value }],
        ),
      });
      let released = false;
      let outputLength = 0;
      const kill = (): void => {
        void client.request("terminal/kill", { sessionId, terminalId: created.terminalId });
      };
      options.signal?.addEventListener("abort", kill, { once: true });
      const timeout =
        options.timeout === undefined
          ? undefined
          : setTimeout(() => {
              kill();
            }, options.timeout);
      try {
        outputLength = await streamTerminalOutput(
          client,
          sessionId,
          created.terminalId,
          outputLength,
          options.onData,
        );
        const exit = await client.request<{ exitCode?: number | null }>("terminal/wait_for_exit", {
          sessionId,
          terminalId: created.terminalId,
        });
        await streamTerminalOutput(
          client,
          sessionId,
          created.terminalId,
          outputLength,
          options.onData,
        );
        return { exitCode: exit.exitCode ?? null };
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", kill);
        if (!released) {
          released = true;
          await client.request("terminal/release", {
            sessionId,
            terminalId: created.terminalId,
          });
        }
      }
    },
  };
}

async function streamTerminalOutput(
  client: ClientRequester,
  sessionId: string,
  terminalId: string,
  previousLength: number,
  onData: (data: Buffer) => void,
): Promise<number> {
  const response = await client.request<{ output: string }>("terminal/output", {
    sessionId,
    terminalId,
  });
  if (response.output.length > previousLength) {
    onData(Buffer.from(response.output.slice(previousLength)));
  }
  return response.output.length;
}
