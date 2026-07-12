import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { HerdrClient } from "../src/herdr/client.js";
import { HerdrAdapter } from "../src/subagent-sdk/herdr.js";

type ExecCall = {
  command: string;
  args: string[];
  options?: ExecOptions;
};

function execResult(stdout = "", stderr = "", code = 0): ExecResult {
  return { stdout, stderr, code, killed: false };
}

function createExecRecorder() {
  const calls: ExecCall[] = [];
  const exec = (command: string, args: string[], options?: ExecOptions): Promise<ExecResult> => {
    calls.push({ command, args, options });
    if (args[0] === "tab" && args[1] === "create") {
      return Promise.resolve(execResult('{"result":{"root_pane":{"pane_id":"w1:p2"}}}'));
    }
    if (args[0] === "pane" && args[1] === "split") {
      return Promise.resolve(execResult('{"result":{"pane":{"pane_id":"w1:p3"}}}'));
    }
    return Promise.resolve(execResult());
  };
  return { calls, exec };
}

describe("HerdrAdapter", () => {
  const originalHerdrEnv = process.env.HERDR_ENV;
  const originalHerdrPaneId = process.env.HERDR_PANE_ID;
  const originalHerdrSocketPath = process.env.HERDR_SOCKET_PATH;
  const originalHerdrWorkspaceId = process.env.HERDR_WORKSPACE_ID;

  afterEach(() => {
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
    if (originalHerdrPaneId === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = originalHerdrPaneId;
    if (originalHerdrSocketPath === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = originalHerdrSocketPath;
    if (originalHerdrWorkspaceId === undefined) delete process.env.HERDR_WORKSPACE_ID;
    else process.env.HERDR_WORKSPACE_ID = originalHerdrWorkspaceId;
  });

  test("uses herdr tab create for window targets", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    const recorder = createExecRecorder();
    const adapter = new HerdrAdapter(recorder.exec, "/repo");

    const pane = await adapter.createPane({
      command: "pi child",
      cwd: "/repo",
      target: "window",
      title: "child",
    });

    expect(pane.paneId).toBe("w1:p2");
    expect(recorder.calls[0]?.args).toEqual([
      "tab",
      "create",
      "--workspace",
      "w1",
      "--cwd",
      "/repo",
      "--label",
      "child",
      "--no-focus",
    ]);
    expect(recorder.calls.at(-1)?.args).toEqual([
      "pane",
      "run",
      "w1:p2",
      " { pi child; }; __pi_subagent_status=$?; herdr pane close 'w1:p2'; exit $__pi_subagent_status",
    ]);
  });

  test("checks availability with bounded Herdr status command", async () => {
    process.env.HERDR_ENV = "1";
    const recorder = createExecRecorder();
    const adapter = new HerdrAdapter(recorder.exec, "/repo");

    await expect(adapter.isAvailable()).resolves.toBe(true);

    expect(recorder.calls[0]).toEqual({
      command: "herdr",
      args: ["status", "server"],
      options: { cwd: "/repo", timeout: 2000 },
    });
  });

  test("passes current Herdr pane when splitting pane targets", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    const recorder = createExecRecorder();
    const adapter = new HerdrAdapter(recorder.exec, "/repo");

    await adapter.createPane({
      command: "pi child",
      cwd: "/repo",
      target: "pane",
      title: "child",
    });

    expect(recorder.calls[0]?.args).toEqual([
      "pane",
      "split",
      "w1:p1",
      "--direction",
      "right",
      "--cwd",
      "/repo",
      "--no-focus",
    ]);
  });

  test("falls back to --current when HERDR_PANE_ID is unavailable", async () => {
    process.env.HERDR_ENV = "1";
    delete process.env.HERDR_PANE_ID;
    const recorder = createExecRecorder();
    const adapter = new HerdrAdapter(recorder.exec, "/repo");

    await adapter.createPane({
      command: "pi child",
      cwd: "/repo",
      target: "pane",
      title: "child",
    });

    expect(recorder.calls[0]?.args[2]).toBe("--current");
  });

  test("submits steer messages atomically with pane run", async () => {
    process.env.HERDR_ENV = "1";
    const recorder = createExecRecorder();
    const adapter = new HerdrAdapter(recorder.exec, "/repo");

    await adapter.sendText("w1:p1", "Review this", "steer");

    expect(recorder.calls).toEqual([
      {
        command: "herdr",
        args: ["pane", "run", "w1:p1", "Review this"],
        options: { cwd: "/repo" },
      },
    ]);
  });

  test("submits follow-up text and key in one socket request", async () => {
    process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
    const commandCalls: string[][] = [];
    const socketCalls: Array<{ socketPath: string; request: unknown; timeoutMs: number }> = [];
    const client = new HerdrClient(
      async (args) => {
        commandCalls.push(args);
        return execResult();
      },
      async (socketPath, request, timeoutMs) => {
        socketCalls.push({ socketPath, request, timeoutMs });
      },
    );

    await client.sendInput("w3:pN", "Queue this", "alt+enter", { timeout: 2500 });

    expect(commandCalls).toHaveLength(0);
    expect(socketCalls).toEqual([
      {
        socketPath: "/tmp/herdr.sock",
        timeoutMs: 2500,
        request: {
          id: expect.stringMatching(/^pi:pane-send-input:/),
          method: "pane.send_input",
          params: { pane_id: "w3:pN", text: "Queue this", keys: ["alt+enter"] },
        },
      },
    ]);
  });

  test("validates a successful Herdr socket response", async () => {
    const requests: Array<{ id: string; method: string }> = [];
    await withHerdrSocket(
      (request, socket) => {
        requests.push(request);
        socket.end(`${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n`);
      },
      async (client) => {
        await client.sendInput("w3:pN", "Queue this", "alt+enter");
        expect(requests).toEqual([expect.objectContaining({ method: "pane.send_input" })]);
      },
    );
  });

  test.each([
    {
      name: "invalid JSON",
      response: () => "not-json",
      expectedError: /invalid JSON/,
    },
    {
      name: "schema-mismatched",
      response: (request: HerdrSocketTestRequest) =>
        JSON.stringify({ id: request.id, result: null }),
      expectedError: /invalid response/,
    },
    {
      name: "ambiguous malformed",
      response: (request: HerdrSocketTestRequest) =>
        JSON.stringify({ id: request.id, result: {}, error: null }),
      expectedError: /invalid response/,
    },
    {
      name: "mismatched-ID",
      response: () => JSON.stringify({ id: "different", result: { type: "ok" } }),
      expectedError: /unexpected response id/,
    },
    {
      name: "API error",
      response: (request: HerdrSocketTestRequest) =>
        JSON.stringify({
          id: request.id,
          error: { code: "pane_send_failed", message: "denied" },
        }),
      expectedError: /pane send input failed: denied/,
    },
  ])("rejects $name Herdr socket responses", async ({ response, expectedError }) => {
    await withHerdrSocket(
      (request, socket) => {
        socket.end(`${response(request)}\n`);
      },
      async (client) => {
        await expect(
          client.sendInput("w3:pN", "Queue this", "alt+enter", { timeout: 100 }),
        ).rejects.toThrow(expectedError);
      },
    );
  });

  test.each([
    { name: "empty", response: "" },
    { name: "partial", response: '{"id":' },
  ])("rejects $name socket responses closed before a full line", async ({ response }) => {
    await withHerdrSocket(
      (_request, socket) => {
        socket.end(response);
      },
      async (client) => {
        await expect(
          client.sendInput("w3:pN", "Queue this", "alt+enter", { timeout: 100 }),
        ).rejects.toThrow("herdr pane send input connection closed");
      },
    );
  });

  test("rejects Herdr socket response timeouts", async () => {
    await withHerdrSocket(
      () => undefined,
      async (client) => {
        await expect(
          client.sendInput("w3:pN", "Queue this", "alt+enter", { timeout: 25 }),
        ).rejects.toThrow("herdr pane send input timed out after 25ms");
      },
    );
  });

  test("rejects unavailable Herdr sockets", async () => {
    const socketDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-herdr-input-"));
    process.env.HERDR_SOCKET_PATH = path.join(socketDirectory, "missing.sock");
    try {
      const client = new HerdrClient(async () => execResult());
      await expect(
        client.sendInput("w3:pN", "Queue this", "alt+enter", { timeout: 100 }),
      ).rejects.toThrow(/ENOENT|ECONNREFUSED/);
    } finally {
      await rm(socketDirectory, { recursive: true, force: true });
    }
  });

  test("resolves Herdr socket path through status outside a managed pane", async () => {
    delete process.env.HERDR_SOCKET_PATH;
    const commandCalls: string[][] = [];
    const socketPaths: string[] = [];
    const client = new HerdrClient(
      async (args) => {
        commandCalls.push(args);
        return execResult("status: running\nsocket: /tmp/resolved-herdr.sock\n");
      },
      async (socketPath) => {
        socketPaths.push(socketPath);
      },
    );

    await client.sendInput("w3:pN", "Queue this", "alt+enter");

    expect(commandCalls).toEqual([["status", "server"]]);
    expect(socketPaths).toEqual(["/tmp/resolved-herdr.sock"]);
  });
});

type HerdrSocketTestRequest = {
  id: string;
  method: string;
};

async function withHerdrSocket(
  handleRequest: (request: HerdrSocketTestRequest, socket: Socket) => void,
  run: (client: HerdrClient) => Promise<void>,
): Promise<void> {
  const socketDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-herdr-input-"));
  const socketPath = path.join(socketDirectory, "herdr.sock");
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      handleRequest(JSON.parse(buffer.slice(0, newlineIndex)) as HerdrSocketTestRequest, socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  process.env.HERDR_SOCKET_PATH = socketPath;

  try {
    await run(new HerdrClient(async () => execResult()));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(socketDirectory, { recursive: true, force: true });
  }
}
