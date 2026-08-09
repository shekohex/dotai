import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

interface AcpProcessResult {
  stdoutLines: unknown[];
  stderr: string;
  exitCode: number | null;
}

describe("ACP stdio", () => {
  test("pi acp initializes stable ACP v1", async () => {
    const result = await runAcpProcess(["acp"], {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "stdio-test", version: "1.0.0" },
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdoutLines).toEqual([
      expect.objectContaining({
        jsonrpc: "2.0",
        id: 1,
        result: expect.objectContaining({ protocolVersion: 1 }),
      }),
    ]);
  }, 20_000);

  test("pi acp downgrades a v2 client to stable v1 by default", async () => {
    const result = await runAcpProcess(["acp"], createV2InitializeMessage());

    expect(result.exitCode).toBe(0);
    expect(result.stdoutLines).toEqual([
      expect.objectContaining({
        jsonrpc: "2.0",
        id: 1,
        result: expect.objectContaining({ protocolVersion: 1 }),
      }),
    ]);
  }, 20_000);

  test("experimental flag negotiates ACP v2", async () => {
    const result = await runAcpProcess(
      ["acp", "--experimental-acp-v2"],
      createV2InitializeMessage(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdoutLines).toEqual([
      expect.objectContaining({
        jsonrpc: "2.0",
        id: 1,
        result: expect.objectContaining({ protocolVersion: 2 }),
      }),
    ]);
  }, 20_000);

  test("--mode acp remains an alias", async () => {
    const result = await runAcpProcess(["--mode", "acp"], createV2InitializeMessage());

    expect(result.exitCode).toBe(0);
    expect(result.stdoutLines[0]).toEqual(
      expect.objectContaining({ result: expect.objectContaining({ protocolVersion: 1 }) }),
    );
  }, 20_000);

  test("conflicting startup flags fail on stderr without protocol output", async () => {
    const result = await runAcpProcess(["acp", "--json"], createV2InitializeMessage());

    expect(result.exitCode).toBe(1);
    expect(result.stdoutLines).toEqual([]);
    expect(result.stderr).toContain("ACP mode cannot be combined with --json");
  }, 20_000);

  test("session creation and slash commands keep stdout limited to JSON-RPC frames", async () => {
    const result = await runAcpSessionCreation();

    expect(result.exitCode).toBe(0);
    expect(result.stdoutLines.every(isJsonRpcLine)).toBe(true);
    const messages = result.stdoutLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 2 }),
        expect.objectContaining({ id: 3 }),
        expect.objectContaining({ id: 4 }),
      ]),
    );
    expect(result.stdoutLines.some((line) => line.includes("Unknown mode"))).toBe(true);
    expect(result.stdoutLines.findIndex((line) => line.includes('"id":2'))).toBeLessThan(
      result.stdoutLines.findIndex((line) => line.includes("available_commands_update")),
    );
    expect(
      result.stdoutLines.find(
        (line) => line.includes("available_commands_update") && line.includes('"name":"fast"'),
      ),
    ).toBeDefined();
  }, 30_000);
});

function createV2InitializeMessage(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 2,
      capabilities: {},
      info: { name: "stdio-test", version: "1.0.0" },
    },
  };
}

async function runAcpProcess(
  args: string[],
  firstMessage: Record<string, unknown>,
): Promise<AcpProcessResult> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.includes("\n")) {
      child.stdin.end();
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.write(`${JSON.stringify(firstMessage)}\n`);

  const [exitCode] = (await once(child, "exit")) as [number | null];
  const stdoutLines = stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
  return { stdoutLines, stderr, exitCode };
}

async function runAcpSessionCreation(): Promise<{
  stdoutLines: string[];
  stderr: string;
  exitCode: number | null;
}> {
  const agentDir = await mkdtemp(join(tmpdir(), "acp-stdio-agent-"));
  await mkdir(join(agentDir, "prompts"));
  await writeFile(
    join(agentDir, "prompts", "fast.md"),
    "---\ndescription: Fast response\n---\n\nAnswer quickly: $ARGUMENTS\n",
  );
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "acp"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SKIP_VERSION_CHECK: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let sentSessionNew = false;
  let sentBuiltinCommand = false;
  let sentExtensionCommand = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (!sentSessionNew && stdout.includes('"id":1')) {
      sentSessionNew = true;
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: { cwd: process.cwd(), mcpServers: [] },
        })}\n`,
      );
    }
    if (!sentBuiltinCommand && stdout.includes('"id":2')) {
      const sessionId = stdout.match(/"sessionId":"([^"]+)"/)?.[1];
      if (sessionId !== undefined) {
        sentBuiltinCommand = true;
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "session/prompt",
            params: {
              sessionId,
              prompt: [{ type: "text", text: "/settings" }],
            },
          })}\n`,
        );
      }
    }
    if (!sentExtensionCommand && stdout.includes('"id":3')) {
      const sessionId = stdout.match(/"sessionId":"([^"]+)"/)?.[1];
      if (sessionId !== undefined) {
        sentExtensionCommand = true;
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 4,
            method: "session/prompt",
            params: {
              sessionId,
              prompt: [{ type: "text", text: "/mode definitely-missing" }],
            },
          })}\n`,
        );
      }
    }
    if (sentExtensionCommand && stdout.includes('"id":4')) child.stdin.end();
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "stdio-session-test", version: "1.0.0" },
      },
    })}\n`,
  );

  try {
    const [exitCode] = (await once(child, "exit")) as [number | null];
    return {
      stdoutLines: stdout.split("\n").filter((line) => line.length > 0),
      stderr,
      exitCode,
    };
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

function isJsonRpcLine(line: string): boolean {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && "jsonrpc" in value;
  } catch {
    return false;
  }
}
