import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createWarpCliAgentPayload,
  createWarpCliAgentSequence,
  negotiateWarpCliAgentProtocolVersion,
} from "../src/extensions/warp/encoder.js";
import { createWarpExtension, type WarpExtensionRuntime } from "../src/extensions/warp/index.js";
import { writeWarpCliAgentSequence } from "../src/extensions/warp/runtime.js";
import { terminalNotifyRuntime } from "../src/extensions/terminal-notify.js";
import type { WarpCliAgentPayload } from "../src/extensions/warp/types.js";

type Handler = (event: Record<string, unknown>, ctx: ReturnType<typeof createContext>) => unknown;

const originalTmux = process.env.TMUX;
const originalChildState = process.env.PI_SUBAGENT_CHILD_STATE;
const createWarpRuntime = (protocolVersion: string | undefined) => {
  const payloads: WarpCliAgentPayload[] = [];
  const runtime: WarpExtensionRuntime = {
    readProtocolVersion: () => protocolVersion,
    emitPayload: (payload) => {
      payloads.push(payload);
    },
  };
  return { runtime, payloads };
};

const createPi = () => {
  const handlers = new Map<string, Handler>();
  const eventHandlers = new Map<string, (data: unknown) => void>();
  return {
    events: {
      on: (eventName: string, handler: (data: unknown) => void) => {
        eventHandlers.set(eventName, handler);
        return () => eventHandlers.delete(eventName);
      },
      emit: (eventName: string, data: unknown) => {
        eventHandlers.get(eventName)?.(data);
      },
    },
    getSessionName: () => "Warp Integration",
    on: (eventName: string, handler: Handler) => {
      handlers.set(eventName, handler);
    },
    emit: (eventName: string, event: Record<string, unknown>, ctx = createContext()) => {
      const handler = handlers.get(eventName);
      if (handler === undefined) {
        throw new Error(`Missing handler: ${eventName}`);
      }
      return handler(event, ctx);
    },
  };
};

const createContext = () => ({
  cwd: "/workspace/project",
  sessionManager: {
    getSessionId: () => "session-1",
  },
});

const decodeSequence = (sequence: string) => {
  const frame = sequence.startsWith("\u001bPtmux;")
    ? sequence.slice("\u001bPtmux;".length, -2).replaceAll("\u001b\u001b", "\u001b")
    : sequence;
  const body = frame.slice(2, -1);
  const [_command, _action, title, payload] = body.split(";", 4);
  return { title, payload: JSON.parse(payload ?? "{}") };
};

beforeEach(() => {
  vi.spyOn(terminalNotifyRuntime, "execFileSync").mockImplementation(() => {
    throw new Error("tmux not available");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
  if (originalChildState === undefined) delete process.env.PI_SUBAGENT_CHILD_STATE;
  else process.env.PI_SUBAGENT_CHILD_STATE = originalChildState;
});

test("negotiateWarpCliAgentProtocolVersion clamps to supported version", () => {
  expect(negotiateWarpCliAgentProtocolVersion(undefined)).toBeNull();
  expect(negotiateWarpCliAgentProtocolVersion("0")).toBeNull();
  expect(negotiateWarpCliAgentProtocolVersion("1")).toBe(1);
  expect(negotiateWarpCliAgentProtocolVersion("3")).toBe(1);
});

test("createWarpCliAgentSequence emits Warp OSC 777 payload with pi agent", () => {
  const payload = createWarpCliAgentPayload("session_start", createContext(), 1, {
    plugin_version: "builtin",
  });
  const sequence = createWarpCliAgentSequence(payload);
  const decoded = decodeSequence(sequence);
  expect(decoded.title).toBe("warp://cli-agent");
  expect(decoded.payload).toEqual({
    v: 1,
    agent: "pi",
    event: "session_start",
    session_id: "session-1",
    cwd: "/workspace/project",
    project: "project",
    plugin_version: "builtin",
  });
});

test("warp extension is silent outside Warp", () => {
  const { runtime, payloads } = createWarpRuntime(undefined);
  const pi = createPi();
  createWarpExtension(runtime)(pi as unknown as ExtensionAPI);
  pi.emit("session_start", {});
  expect(payloads).toEqual([]);
});

test("warp extension maps Pi events to Warp events", () => {
  const { runtime, payloads } = createWarpRuntime("1");
  const pi = createPi();
  createWarpExtension(runtime)(pi as unknown as ExtensionAPI);
  pi.emit("session_start", {});
  pi.emit("input", { text: "hello warp" });
  pi.emit("agent_end", {
    messages: [
      { role: "user", content: "hello warp", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    ],
  });
  pi.emit("tool_execution_end", { toolName: "bash" });
  pi.emit("tool_execution_update", { toolName: "interview" });
  pi.events.emit("goal:blocked", {
    sessionId: "session-1",
    cwd: "/workspace/project",
    goalId: "goal-1",
    objective: "Ship Warp integration",
    blockedReason:
      "Need user feedback on whether Warp renders question_asked notifications for blocked goals before continuing.",
  });
  const events = payloads.map((payload) => payload.event);
  expect(events).toEqual([
    "session_start",
    "prompt_submit",
    "stop",
    "tool_complete",
    "question_asked",
    "question_asked",
  ]);
  expect(payloads[1]).toMatchObject({ query: "hello warp" });
  expect(payloads[2]).toMatchObject({ query: "Warp Integration", response: "done" });
  expect(payloads[3]).toMatchObject({ tool_name: "bash" });
  expect(payloads[5]).toMatchObject({
    summary:
      "Goal blocked: Need user feedback on whether Warp renders question_asked notifications for blocked goals before continuing.",
  });
});

test("warp extension is silent for subagent sessions", () => {
  process.env.PI_SUBAGENT_CHILD_STATE = JSON.stringify({
    sessionId: "session-1",
    parentSessionId: "parent-session",
    name: "worker",
    prompt: "do work",
    autoExit: true,
    handoff: false,
    tools: [],
    startedAt: 1,
  });
  const { runtime, payloads } = createWarpRuntime("1");
  const pi = createPi();
  createWarpExtension(runtime)(pi as unknown as ExtensionAPI);

  pi.emit("session_start", {});
  pi.emit("input", { text: "hello warp" });
  pi.emit("agent_end", { messages: [{ role: "assistant", content: "done" }] });
  pi.emit("tool_execution_end", { toolName: "bash" });
  pi.emit("tool_execution_update", { toolName: "interview" });
  pi.events.emit("goal:blocked", {
    sessionId: "session-1",
    cwd: "/workspace/project",
    goalId: "goal-1",
    objective: "Ship Warp integration",
    blockedReason: "Need user feedback.",
  });

  expect(payloads).toEqual([]);
});

test("warp extension wraps OSC for tmux fallback", () => {
  process.env.TMUX = "/tmp/tmux,1,0";
  vi.spyOn(terminalNotifyRuntime, "execFileSync").mockReturnValue("/dev/ttys009\n");
  const writeSpy = vi.spyOn(terminalNotifyRuntime, "writeFileSync").mockImplementation(() => {
    throw new Error("write failed");
  });
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);
  const payload = createWarpCliAgentPayload("session_start", createContext(), 1, {
    plugin_version: "builtin",
  });
  writeWarpCliAgentSequence(createWarpCliAgentSequence(payload));
  expect(writeSpy.mock.calls.some(([, sequence]) => sequence.includes("\u001bPtmux;"))).toBe(true);
  expect(decodeSequence(stdoutSpy.mock.calls[0]?.[0] ?? "").payload.agent).toBe("pi");
});
