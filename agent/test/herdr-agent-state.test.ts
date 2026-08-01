import { afterEach, beforeEach, expect, test } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import herdrAgentStateExtension from "../src/extensions/herdr-agent-state.js";
import { ASK_USER_QUESTION_PROMPT_EVENT } from "../src/extensions/ask-user-question/index.js";
import { HERDR_WINDOW_TITLE_EVENT } from "../src/extensions/herdr-window-title-events.js";

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
    emit: (eventName: string, event: unknown) => {
      for (const handler of this.eventHandlers.get(eventName) ?? []) {
        handler(event);
      }
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
  HERDR_TAB_ID: process.env.HERDR_TAB_ID,
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
  const { requests, waitForRequest } = await startSocketServer();
  const fakePi = new FakePi();
  herdrAgentStateExtension(fakePi as unknown as ExtensionAPI);
  const ctx = createContext();

  await emit(fakePi, "session_start", {}, ctx);
  await emit(fakePi, "agent_start", {}, ctx);
  await waitForRequest(
    (request) =>
      request.method === "pane.report_agent" && asParams(request.params).state === "working",
  );

  expect(requests).toContainEqual(
    expect.objectContaining({
      method: "pane.report_metadata",
      params: expect.objectContaining({
        pane_id: "w1:p1",
        title: "π - Test Session - agent",
        display_agent: "π",
        tokens: {
          context: "42% ctx",
          model: "Claude Sonnet",
          summary: "Ready",
          tool: null,
        },
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
      method: "tab.rename",
      params: { tab_id: "w1:t1", label: "Test Session" },
    }),
  );
  expect(requests).toContainEqual(
    expect.objectContaining({
      method: "pane.report_agent",
      params: expect.objectContaining({ state: "working", custom_status: "working" }),
    }),
  );
});

test("reports live activity and current tool as Herdr metadata", async () => {
  const { requests, waitForRequest } = await startSocketServer();
  const fakePi = new FakePi();
  herdrAgentStateExtension(fakePi as unknown as ExtensionAPI);
  const ctx = createContext();

  await emit(fakePi, "session_start", {}, ctx);
  await emit(
    fakePi,
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "tool-read",
      toolName: "read",
      input: { file_path: "/tmp/agent/src/auth.ts" },
    },
    ctx,
  );
  await waitForRequest(
    (request) =>
      request.method === "pane.report_metadata" &&
      asParams(asParams(request.params).tokens).summary === "Reading auth.ts",
  );

  expect(requests).toContainEqual(
    expect.objectContaining({
      method: "pane.report_metadata",
      params: expect.objectContaining({
        tokens: expect.objectContaining({
          summary: "Reading auth.ts",
          tool: "read",
        }),
      }),
    }),
  );
});

test("refreshes context metadata when an agent turn ends", async () => {
  let contextPercent = 42;
  const { requests, waitForRequest } = await startSocketServer();
  const fakePi = new FakePi();
  herdrAgentStateExtension(fakePi as unknown as ExtensionAPI);
  const ctx = createContext({
    getContextUsage: () => ({ tokens: 640, contextWindow: 1000, percent: contextPercent }),
  });

  await emit(fakePi, "session_start", {}, ctx);
  await emit(fakePi, "agent_start", {}, ctx);
  contextPercent = 64;
  await emit(fakePi, "agent_end", { messages: [] }, ctx);
  await waitForRequest(
    (request) =>
      request.method === "pane.report_metadata" &&
      asParams(asParams(request.params).tokens).context === "64% ctx",
  );

  expect(requests).toContainEqual(
    expect.objectContaining({
      method: "pane.report_metadata",
      params: expect.objectContaining({
        tokens: expect.objectContaining({
          context: "64% ctx",
          summary: "Ready",
          tool: null,
        }),
      }),
    }),
  );
});

test("updates Herdr presentation when the Pi session name changes", async () => {
  let sessionName = "Initial Session";
  const { requests, waitForRequest } = await startSocketServer();
  const fakePi = new FakePi();
  herdrAgentStateExtension(fakePi as unknown as ExtensionAPI);
  const ctx = createContext({
    sessionManager: {
      getSessionName: () => sessionName,
      getSessionFile: () => "/tmp/session.jsonl",
      getSessionId: () => "session-id",
    } as ExtensionContext["sessionManager"],
  });

  await emit(fakePi, "session_start", {}, ctx);
  sessionName = "Renamed Conversation";
  await emit(
    fakePi,
    "session_info_changed",
    { type: "session_info_changed", name: sessionName },
    ctx,
  );
  await waitForRequest(
    (request) =>
      request.method === "tab.rename" && asParams(request.params).label === "Renamed Conversation",
  );

  expect(requests).toContainEqual(
    expect.objectContaining({
      method: "pane.report_metadata",
      params: expect.objectContaining({ title: "π - Renamed Conversation - agent" }),
    }),
  );
  expect(requests).toContainEqual(
    expect.objectContaining({
      method: "client.window_title.set",
      params: { title: "π - Renamed Conversation - agent" },
    }),
  );
});

test("forwards live spinner titles to the foreground Herdr client", async () => {
  const { requests, waitForRequest } = await startSocketServer();
  const fakePi = new FakePi();
  herdrAgentStateExtension(fakePi as unknown as ExtensionAPI);
  const ctx = createContext();

  await emit(fakePi, "session_start", {}, ctx);
  fakePi.events.emit(HERDR_WINDOW_TITLE_EVENT, { title: "⠋ π - Test Session - agent" });
  await waitForRequest(
    (request) =>
      request.method === "client.window_title.set" &&
      asParams(request.params).title === "⠋ π - Test Session - agent",
  );

  expect(requests).toContainEqual(
    expect.objectContaining({
      method: "client.window_title.set",
      params: { title: "⠋ π - Test Session - agent" },
    }),
  );
});

test("does not replace the outer title from a background pane", async () => {
  const { requests } = await startSocketServer({ focused: false });
  const fakePi = new FakePi();
  herdrAgentStateExtension(fakePi as unknown as ExtensionAPI);
  const ctx = createContext();

  await emit(fakePi, "session_start", {}, ctx);
  fakePi.events.emit(HERDR_WINDOW_TITLE_EVENT, { title: "⠋ background" });
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(requests.some((request) => request.method === "client.window_title.set")).toBe(false);
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
  setChildSessionEnv();
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

test("retries a state report when the first socket attempt gets no response", async () => {
  setChildSessionEnv();
  const { requests } = await startSocketServer({ ignoredResponses: 1 });
  const fakePi = new FakePi();
  herdrAgentStateExtension(fakePi as unknown as ExtensionAPI);
  const ctx = createContext({
    sessionManager: {
      getSessionName: () => "Test Session",
      getSessionFile: () => undefined,
      getSessionId: () => "",
    } as ExtensionContext["sessionManager"],
  });

  await emit(fakePi, "session_start", {}, ctx);

  await expect
    .poll(() => requests.filter((request) => request.method === "pane.report_agent").length, {
      timeout: 2500,
    })
    .toBe(2);
});

test("retries a state report when the first socket attempt returns an API error", async () => {
  setChildSessionEnv();
  const { requests } = await startSocketServer({ errorResponses: 1 });
  const fakePi = new FakePi();
  herdrAgentStateExtension(fakePi as unknown as ExtensionAPI);
  const ctx = createContext({
    sessionManager: {
      getSessionName: () => "Test Session",
      getSessionFile: () => undefined,
      getSessionId: () => "",
    } as ExtensionContext["sessionManager"],
  });

  await emit(fakePi, "session_start", {}, ctx);

  await expect
    .poll(() => requests.filter((request) => request.method === "pane.report_agent").length, {
      timeout: 1500,
    })
    .toBe(2);
});

test("keeps Herdr authority and presentation across internal session reloads", async () => {
  const { requests } = await startSocketServer();
  const fakePi = new FakePi();
  herdrAgentStateExtension(fakePi as unknown as ExtensionAPI);
  const ctx = createContext();

  await emit(fakePi, "session_start", {}, ctx);
  await emit(fakePi, "session_shutdown", { reason: "reload" }, ctx);

  expect(requests.some((request) => request.method === "pane.release_agent")).toBe(false);
  expect(
    requests.some(
      (request) =>
        request.method === "pane.report_metadata" && asParams(request.params).clear_title === true,
    ),
  ).toBe(false);
  expect(requests.some((request) => request.method === "client.window_title.clear")).toBe(false);
});

test("preserves working state when extension reloads during an active turn", async () => {
  const { waitForRequest } = await startSocketServer();
  const fakePi = new FakePi();
  herdrAgentStateExtension(fakePi as unknown as ExtensionAPI);
  const ctx = createContext({ isIdle: () => false });

  await emit(fakePi, "session_start", { reason: "reload" }, ctx);
  await waitForRequest(
    (request) =>
      request.method === "pane.report_agent" && asParams(request.params).state === "working",
  );
});

test("refreshes native session reference when an agent turn starts", async () => {
  let sessionPath = "/tmp/session-a.jsonl";
  const { requests, waitForRequest } = await startSocketServer();
  const fakePi = new FakePi();
  herdrAgentStateExtension(fakePi as unknown as ExtensionAPI);
  const ctx = createContext({
    sessionManager: {
      getSessionName: () => "Test Session",
      getSessionFile: () => sessionPath,
      getSessionId: () => "session-id",
    } as ExtensionContext["sessionManager"],
  });

  await emit(fakePi, "session_start", {}, ctx);
  sessionPath = "/tmp/session-b.jsonl";
  await emit(fakePi, "agent_start", {}, ctx);
  await waitForRequest(
    (request) =>
      request.method === "pane.report_agent_session" &&
      asParams(request.params).agent_session_path === "/tmp/session-b.jsonl",
  );
  await waitForRequest(
    (request) =>
      request.method === "pane.report_agent" &&
      asParams(request.params).state === "working" &&
      asParams(request.params).agent_session_path === "/tmp/session-b.jsonl",
  );

  expect(requests).toContainEqual(
    expect.objectContaining({
      method: "pane.report_agent_session",
      params: expect.objectContaining({ agent_session_path: "/tmp/session-b.jsonl" }),
    }),
  );
  expect(requests).toContainEqual(
    expect.objectContaining({
      method: "pane.report_agent",
      params: expect.objectContaining({
        state: "working",
        agent_session_path: "/tmp/session-b.jsonl",
      }),
    }),
  );
});

test("does not claim Herdr lifecycle authority for headless sessions", async () => {
  const { requests } = await startSocketServer();
  const fakePi = new FakePi();
  herdrAgentStateExtension(fakePi as unknown as ExtensionAPI);
  const ctx = createContext({ hasUI: false });

  await emit(fakePi, "session_start", {}, ctx);
  await emit(fakePi, "agent_start", {}, ctx);
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(requests).toHaveLength(0);
});

async function startSocketServer(
  options: { errorResponses?: number; focused?: boolean; ignoredResponses?: number } = {},
): Promise<{
  requests: Array<{ id?: string; method?: string; params?: unknown }>;
  waitForRequests: (count: number) => Promise<void>;
  waitForRequest: (
    predicate: (request: { method?: string; params?: unknown }) => boolean,
  ) => Promise<void>;
}> {
  if (socketDir === undefined) throw new Error("missing socket dir");
  const socketPath = path.join(socketDir, "herdr.sock");
  const requests: Array<{ id?: string; method?: string; params?: unknown }> = [];
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
        const request = JSON.parse(line) as { id?: string; method?: string; params?: unknown };
        requests.push(request);
        const ignoredResponses = options.ignoredResponses ?? 0;
        if (requests.length <= ignoredResponses) {
          waiters.splice(0).forEach((resolve) => resolve());
          continue;
        }
        if (requests.length <= ignoredResponses + (options.errorResponses ?? 0)) {
          socket.end(
            `${JSON.stringify({
              id: request.id,
              error: { code: "pane_report_failed", message: "retry" },
            })}\n`,
          );
        } else if (request.method === "pane.current") {
          socket.end(
            `${JSON.stringify({
              id: request.id,
              result: {
                type: "pane_current",
                pane: {
                  pane_id: "w1:p1",
                  tab_id: "w1:t1",
                  focused: options.focused ?? true,
                },
              },
            })}\n`,
          );
        } else {
          socket.end(`${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n`);
        }
        waiters.splice(0).forEach((resolve) => resolve());
      }
    });
  });
  await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.HERDR_SOCKET_PATH = socketPath;
  process.env.HERDR_TAB_ID = "w1:t1";
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

function createContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    cwd: "/tmp/agent",
    getContextUsage: () => ({ tokens: 420, contextWindow: 1000, percent: 42 }),
    hasUI: true,
    isIdle: () => true,
    model: { id: "claude-sonnet", name: "Claude Sonnet" },
    sessionManager: {
      getSessionName: () => "Test Session",
      getSessionFile: () => "/tmp/session.jsonl",
      getSessionId: () => "session-id",
    },
    ...overrides,
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
  restoreEnvValue("HERDR_TAB_ID", previousEnv.HERDR_TAB_ID);
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

function setChildSessionEnv(): void {
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
}
