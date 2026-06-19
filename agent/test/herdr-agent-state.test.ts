import { afterEach, beforeEach, expect, test } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import herdrAgentStateExtension from "../src/extensions/herdr-agent-state.js";
import { ASK_USER_QUESTION_PROMPT_EVENT } from "../src/extensions/ask-user-question/index.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type EventHandler = (event: unknown) => unknown;

class FakePi {
  readonly handlers = new Map<string, Handler[]>();
  readonly eventHandlers = new Map<string, EventHandler[]>();
  readonly events = {
    on: (eventName: string, handler: EventHandler) => {
      const handlers = this.eventHandlers.get(eventName) ?? [];
      handlers.push(handler);
      this.eventHandlers.set(eventName, handlers);
    },
  };

  on(eventName: string, handler: Handler): void {
    const handlers = this.handlers.get(eventName) ?? [];
    handlers.push(handler);
    this.handlers.set(eventName, handlers);
  }
}

const previousEnv = {
  HERDR_ENV: process.env.HERDR_ENV,
  HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
  PI_HERDR_AGENT_STATE: process.env.PI_HERDR_AGENT_STATE,
  PI_SUBAGENT_CHILD_STATE: process.env.PI_SUBAGENT_CHILD_STATE,
};

let socketDir: string | undefined;
let server: Server | undefined;

beforeEach(async () => {
  socketDir = await mkdtemp(path.join(os.tmpdir(), "pi-herdr-agent-state-"));
});

afterEach(async () => {
  server?.close();
  server = undefined;
  if (socketDir !== undefined) {
    await rm(socketDir, { recursive: true, force: true });
    socketDir = undefined;
  }
  restoreEnv();
});

test("reports title metadata and custom status to Herdr", async () => {
  const { requests, waitForRequests } = await startSocketServer();
  const fakePi = new FakePi();
  herdrAgentStateExtension(fakePi as unknown as ExtensionAPI);
  const ctx = createContext();

  await emit(fakePi, "session_start", {}, ctx);
  await emit(fakePi, "agent_start", {}, ctx);
  await waitForRequests(4);

  expect(requests).toContainEqual(
    expect.objectContaining({
      method: "pane.report_metadata",
      params: expect.objectContaining({
        pane_id: "w1:p1",
        title: "π - Test Session - agent",
        display_agent: "π",
      }),
    }),
  );
  expect(requests).toContainEqual(
    expect.objectContaining({
      method: "client.window_title.set",
      params: { title: "π - Test Session - agent" },
    }),
  );
  expect(requests).toContainEqual(
    expect.objectContaining({
      method: "pane.report_agent",
      params: expect.objectContaining({ state: "working", custom_status: "working" }),
    }),
  );
});

test("sends Herdr notifications for input requests and completion", async () => {
  const { requests, waitForRequest } = await startSocketServer();
  const fakePi = new FakePi();
  herdrAgentStateExtension(fakePi as unknown as ExtensionAPI);
  const ctx = createContext();

  await emit(fakePi, "session_start", {}, ctx);
  await emit(fakePi, "agent_start", {}, ctx);
  emitEvent(fakePi, ASK_USER_QUESTION_PROMPT_EVENT, {
    type: "prompt",
    toolCallId: "tool-call-1",
    cwd: "/tmp/agent",
    questions: [{ header: "Approve", question: "Approve?", multiSelect: false, options: [] }],
  });
  await emit(
    fakePi,
    "agent_end",
    {
      messages: [{ role: "assistant", content: "All done" }],
    },
    ctx,
  );
  await waitForRequest(
    (request) =>
      request.method === "notification.show" && asParams(request.params).body === "All done",
  );

  expect(requests).toContainEqual(
    expect.objectContaining({
      method: "notification.show",
      params: { title: "π needs input", body: "question: Approve", sound: "request" },
    }),
  );
  expect(requests).toContainEqual(
    expect.objectContaining({
      method: "notification.show",
      params: { title: "π", body: "All done", sound: "done" },
    }),
  );
});

test("does not update Herdr titles or notifications for child sessions", async () => {
  process.env.PI_SUBAGENT_CHILD_STATE = JSON.stringify({
    sessionId: "session-id",
    parentSessionId: "parent-session-id",
    name: "worker-one",
    prompt: "Do work",
    autoExit: true,
    autoExitTimeoutMs: 30_000,
    handoff: false,
    persisted: false,
    tools: [],
    outputFormat: { type: "text" },
    startedAt: Date.now(),
  });
  const { requests, waitForRequest } = await startSocketServer();
  const fakePi = new FakePi();
  herdrAgentStateExtension(fakePi as unknown as ExtensionAPI);
  const ctx = createContext();

  await emit(fakePi, "session_start", {}, ctx);
  await emit(fakePi, "agent_start", {}, ctx);
  emitEvent(fakePi, ASK_USER_QUESTION_PROMPT_EVENT, {
    type: "prompt",
    toolCallId: "tool-call-1",
    cwd: "/tmp/agent",
    questions: [{ header: "Approve", question: "Approve?", multiSelect: false, options: [] }],
  });
  await emit(fakePi, "agent_end", { messages: [{ role: "assistant", content: "Done" }] }, ctx);
  await waitForRequest(
    (request) =>
      request.method === "pane.report_agent" && asParams(request.params).state === "blocked",
  );

  expect(requests.some((request) => request.method === "pane.report_metadata")).toBe(false);
  expect(requests.some((request) => request.method === "client.window_title.set")).toBe(false);
  expect(requests.some((request) => request.method === "notification.show")).toBe(false);
});

async function startSocketServer(): Promise<{
  requests: Array<{ method?: string; params?: unknown }>;
  waitForRequests: (count: number) => Promise<void>;
  waitForRequest: (
    predicate: (request: { method?: string; params?: unknown }) => boolean,
  ) => Promise<void>;
}> {
  if (socketDir === undefined) throw new Error("missing socket dir");
  const socketPath = path.join(socketDir, "herdr.sock");
  const requests: Array<{ method?: string; params?: unknown }> = [];
  const waiters: Array<() => void> = [];
  server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        requests.push(JSON.parse(line) as { method?: string; params?: unknown });
        socket.end('{"result":{"type":"ok"}}\n');
        waiters.splice(0).forEach((resolve) => resolve());
      }
    });
  });
  await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.HERDR_SOCKET_PATH = socketPath;
  delete process.env.PI_HERDR_AGENT_STATE;
  return {
    requests,
    waitForRequests: async (count: number) => {
      while (requests.length < count) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
    waitForRequest: async (predicate) => {
      while (!requests.some(predicate)) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

function asParams(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function createContext(): ExtensionContext {
  return {
    cwd: "/tmp/agent",
    sessionManager: {
      getSessionName: () => "Test Session",
      getSessionFile: () => "/tmp/session.jsonl",
      getSessionId: () => "session-id",
    },
  } as unknown as ExtensionContext;
}

async function emit(
  pi: FakePi,
  eventName: string,
  event: unknown,
  ctx: ExtensionContext,
): Promise<void> {
  for (const handler of pi.handlers.get(eventName) ?? []) {
    await handler(event, ctx);
  }
}

function emitEvent(pi: FakePi, eventName: string, event: unknown): void {
  for (const handler of pi.eventHandlers.get(eventName) ?? []) {
    handler(event);
  }
}

function restoreEnv(): void {
  restoreEnvValue("HERDR_ENV", previousEnv.HERDR_ENV);
  restoreEnvValue("HERDR_PANE_ID", previousEnv.HERDR_PANE_ID);
  restoreEnvValue("HERDR_SOCKET_PATH", previousEnv.HERDR_SOCKET_PATH);
  restoreEnvValue("PI_HERDR_AGENT_STATE", previousEnv.PI_HERDR_AGENT_STATE);
  restoreEnvValue("PI_SUBAGENT_CHILD_STATE", previousEnv.PI_SUBAGENT_CHILD_STATE);
}

function restoreEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
