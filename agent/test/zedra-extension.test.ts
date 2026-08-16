import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";

import { groupedExtensionsC } from "../src/extensions/definitions-group-c.js";
import {
  ASK_USER_QUESTION_ANSWERED_EVENT,
  ASK_USER_QUESTION_CANCELLED_EVENT,
  ASK_USER_QUESTION_PROMPT_EVENT,
} from "../src/extensions/ask-user-question/index.js";
import { GOAL_BLOCKED_EVENT } from "../src/extensions/goal/types.js";
import {
  createZedraExtension,
  defaultZedraExtensionRuntime,
  zedraHookRuntime,
  type ZedraExtensionRuntime,
  type ZedraHookPayload,
  type ZedraHookProcess,
} from "../src/extensions/zedra/index.js";

interface Ctx {
  cwd: string;
  hasUI: boolean;
  sessionManager: { getSessionId: () => string; getSessionFile: () => string | undefined };
}

type Handler = (event: Record<string, unknown>, ctx: Ctx) => unknown;

const originalChildState = process.env.PI_SUBAGENT_CHILD_STATE;
const originalZedraCli = process.env.ZEDRA_CLI;
const originalZedraTerminalId = process.env.ZEDRA_TERMINAL_ID;

const createPi = () => {
  const handlers = new Map<string, Handler>();
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  return {
    events: {
      on: (eventName: string, handler: (data: unknown) => void) => {
        eventHandlers.set(eventName, [...(eventHandlers.get(eventName) ?? []), handler]);
        return () => {};
      },
      emit: (eventName: string, data: unknown) => {
        for (const handler of eventHandlers.get(eventName) ?? []) {
          handler(data);
        }
      },
    },
    on: (eventName: string, handler: Handler) => {
      handlers.set(eventName, handler);
    },
    emit: (eventName: string, event: Record<string, unknown>, ctx = createContext()) => {
      // agent_end is intentionally not subscribed; missing handlers are a no-op.
      handlers.get(eventName)?.(event, ctx);
    },
  };
};

const createContext = (overrides: Partial<Ctx> = {}): Ctx => ({
  cwd: "/workspace/project",
  hasUI: true,
  sessionManager: {
    getSessionId: () => "session-1",
    getSessionFile: () => "/workspace/.pi/session.jsonl",
  },
  ...overrides,
});

const createZedraRuntimeWithId = (terminalId: string | undefined) => {
  const sent: Array<{ cli: string; payload: ZedraHookPayload }> = [];
  const runtime: ZedraExtensionRuntime = {
    readTerminalId: () => terminalId,
    readCli: () => "/usr/local/bin/zedra",
    sendHook: (cli, payload) => {
      sent.push({ cli, payload });
    },
  };
  return { runtime, sent };
};

// An explicit undefined must stay undefined (JS default parameters coerce it
// back to "term-1"), so the outside-Zedra test bypasses the defaulted helper.
const createZedraRuntime = (terminalId: string | undefined = "term-1") =>
  createZedraRuntimeWithId(terminalId);

const createZedraRuntimeNeverActive = () => createZedraRuntimeWithId(undefined);

const childStateFor = (sessionId: string) =>
  JSON.stringify({
    sessionId,
    parentSessionId: "parent-session",
    name: "worker",
    prompt: "do work",
    autoExit: true,
    handoff: false,
    persisted: false,
    tools: [],
    startedAt: 1,
  });

const createFakeChild = (): ZedraHookProcess => ({
  on: vi.fn(),
  stdin: { on: vi.fn(), end: vi.fn() },
  unref: vi.fn(),
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalChildState === undefined) delete process.env.PI_SUBAGENT_CHILD_STATE;
  else process.env.PI_SUBAGENT_CHILD_STATE = originalChildState;
  if (originalZedraCli === undefined) delete process.env.ZEDRA_CLI;
  else process.env.ZEDRA_CLI = originalZedraCli;
  if (originalZedraTerminalId === undefined) delete process.env.ZEDRA_TERMINAL_ID;
  else process.env.ZEDRA_TERMINAL_ID = originalZedraTerminalId;
});

describe("zedra extension", () => {
  test("is bundled in group C", () => {
    expect(groupedExtensionsC.some((definition) => definition.id === "zedra")).toBe(true);
  });

  test("is silent outside a Zedra terminal", () => {
    const { runtime, sent } = createZedraRuntimeNeverActive();
    const pi = createPi();
    createZedraExtension(runtime)(pi as unknown as ExtensionAPI);

    pi.emit("before_agent_start", {});
    pi.emit("agent_settled", {});

    expect(sent).toEqual([]);
  });

  test("maps lifecycle events and includes session id from context", () => {
    const { runtime, sent } = createZedraRuntime();
    const pi = createPi();
    createZedraExtension(runtime)(pi as unknown as ExtensionAPI);

    pi.emit("before_agent_start", {});
    pi.emit("tool_execution_end", { toolName: "bash" });
    pi.emit("agent_settled", {});

    expect(sent.map(({ payload }) => payload)).toEqual([
      { hook_event_name: "UserPromptSubmit", session_id: "session-1" },
      { hook_event_name: "PostToolUse", session_id: "session-1" },
      { hook_event_name: "Stop", session_id: "session-1" },
    ]);
    expect(sent.every((entry) => entry.cli === "/usr/local/bin/zedra")).toBe(true);
  });

  test("agent_end alone does not fire Stop; settled fires it once", () => {
    const { runtime, sent } = createZedraRuntime();
    const pi = createPi();
    createZedraExtension(runtime)(pi as unknown as ExtensionAPI);

    pi.emit("before_agent_start", {});
    pi.emit("agent_end", { messages: [] });
    pi.emit("before_agent_start", {});
    pi.emit("agent_end", { messages: [] });
    pi.emit("agent_settled", {});

    expect(sent.filter(({ payload }) => payload.hook_event_name === "Stop")).toHaveLength(1);
  });

  test("mid-turn shutdown clears running state; idle shutdown stays silent", () => {
    const { runtime, sent } = createZedraRuntime();
    const pi = createPi();
    createZedraExtension(runtime)(pi as unknown as ExtensionAPI);

    pi.emit("session_shutdown", { reason: "resume" });
    expect(sent).toEqual([]);

    pi.emit("before_agent_start", {});
    pi.emit("session_shutdown", { reason: "quit" });
    pi.emit("session_shutdown", { reason: "quit" });

    const stops = sent.filter(({ payload }) => payload.hook_event_name === "Stop");
    expect(stops).toHaveLength(1);
  });

  test("skips non-interactive runs", () => {
    const { runtime, sent } = createZedraRuntime();
    const pi = createPi();
    createZedraExtension(runtime)(pi as unknown as ExtensionAPI);
    const ctx = createContext({ hasUI: false });

    pi.emit("before_agent_start", {}, ctx);
    pi.emit("tool_execution_end", {}, ctx);
    pi.emit("agent_settled", {}, ctx);
    pi.emit("session_shutdown", {}, ctx);

    expect(sent).toEqual([]);
  });

  test("is silent for subagent child sessions", () => {
    process.env.PI_SUBAGENT_CHILD_STATE = childStateFor("session-1");
    const { runtime, sent } = createZedraRuntime();
    const pi = createPi();
    createZedraExtension(runtime)(pi as unknown as ExtensionAPI);

    pi.emit("before_agent_start", {});
    pi.emit("tool_execution_end", {});
    pi.emit("agent_settled", {});

    expect(sent).toEqual([]);
  });

  test("allows parent session with leaked ephemeral child state", () => {
    process.env.PI_SUBAGENT_CHILD_STATE = childStateFor("child-session");
    const { runtime, sent } = createZedraRuntime();
    const pi = createPi();
    createZedraExtension(runtime)(pi as unknown as ExtensionAPI);

    pi.emit("before_agent_start", {});
    pi.emit("agent_settled", {});

    expect(sent.map(({ payload }) => payload.hook_event_name)).toEqual([
      "UserPromptSubmit",
      "Stop",
    ]);
  });

  test("sendHook failures are swallowed", () => {
    const { runtime } = createZedraRuntime();
    const pi = createPi();
    createZedraExtension({
      ...runtime,
      sendHook: () => {
        throw new Error("ENOENT");
      },
    })(pi as unknown as ExtensionAPI);

    expect(() => pi.emit("before_agent_start", {})).not.toThrow();
  });

  test("default runtime reads env overrides", () => {
    delete process.env.ZEDRA_CLI;
    delete process.env.ZEDRA_TERMINAL_ID;
    expect(defaultZedraExtensionRuntime.readCli()).toBe("zedra");
    expect(defaultZedraExtensionRuntime.readTerminalId()).toBeUndefined();

    process.env.ZEDRA_CLI = "/opt/zedra/bin/zedra";
    process.env.ZEDRA_TERMINAL_ID = "term-9";
    expect(defaultZedraExtensionRuntime.readCli()).toBe("/opt/zedra/bin/zedra");
    expect(defaultZedraExtensionRuntime.readTerminalId()).toBe("term-9");
  });

  test("default runtime drives full lifecycle through the spawn seam", () => {
    process.env.ZEDRA_TERMINAL_ID = "term-9";
    process.env.ZEDRA_CLI = "/opt/zedra/bin/zedra";
    const spawnSpy = vi
      .spyOn(zedraHookRuntime, "spawn")
      .mockImplementation(() => createFakeChild());
    const pi = createPi();
    createZedraExtension()(pi as unknown as ExtensionAPI);

    pi.emit("before_agent_start", {});
    pi.emit("agent_settled", {});

    expect(spawnSpy).toHaveBeenCalledTimes(2);
    expect(spawnSpy).toHaveBeenNthCalledWith(
      1,
      "/opt/zedra/bin/zedra",
      ["agent", "hook", "receive", "--agent", "pi", "--quiet"],
      { stdio: ["pipe", "ignore", "ignore"], detached: true },
    );
  });

  test("default runtime sends hook payload as JSON stdin and detaches", () => {
    const child = createFakeChild();
    const spawnSpy = vi.spyOn(zedraHookRuntime, "spawn").mockReturnValue(child);

    defaultZedraExtensionRuntime.sendHook("/usr/bin/zedra", {
      hook_event_name: "Stop",
      session_id: "session-1",
    });

    expect(spawnSpy).toHaveBeenCalledWith(
      "/usr/bin/zedra",
      ["agent", "hook", "receive", "--agent", "pi", "--quiet"],
      { stdio: ["pipe", "ignore", "ignore"], detached: true },
    );
    expect(child.stdin?.end).toHaveBeenCalledWith(
      '{"hook_event_name":"Stop","session_id":"session-1"}',
    );
    expect(child.unref).toHaveBeenCalled();
  });

  test("default runtime swallows synchronous spawn errors", () => {
    process.env.ZEDRA_TERMINAL_ID = "term-9";
    vi.spyOn(zedraHookRuntime, "spawn").mockImplementation(() => {
      throw new Error("EACCES");
    });
    const pi = createPi();
    createZedraExtension()(pi as unknown as ExtensionAPI);

    expect(() => pi.emit("before_agent_start", {})).not.toThrow();
  });

  const questionEvent = {
    type: "prompt" as const,
    toolCallId: "tool-question",
    sessionId: "session-1",
    cwd: "/workspace/project",
    questions: [
      {
        question: "Which path?",
        header: "Path",
        multiSelect: false,
        options: [{ label: "Fast", description: "Ship it", hasPreview: false }],
      },
    ],
  };

  test("ask-user-question lifecycle maps to PermissionRequest and PostToolUse", () => {
    const { runtime, sent } = createZedraRuntime();
    const pi = createPi();
    createZedraExtension(runtime)(pi as unknown as ExtensionAPI);

    pi.emit("before_agent_start", {});
    pi.events.emit(ASK_USER_QUESTION_PROMPT_EVENT, questionEvent);
    pi.events.emit(ASK_USER_QUESTION_ANSWERED_EVENT, {
      ...questionEvent,
      type: "answered",
      answers: [{ questionIndex: 0, question: "Which path?", kind: "option", answer: "Fast" }],
    });
    pi.events.emit(ASK_USER_QUESTION_CANCELLED_EVENT, {
      ...questionEvent,
      type: "cancelled",
      answers: [],
    });

    expect(sent.map(({ payload }) => payload.hook_event_name)).toEqual([
      "UserPromptSubmit",
      "PermissionRequest",
      "PostToolUse",
      "PostToolUse",
    ]);
  });

  test("goal blocked maps to PermissionRequest", () => {
    const { runtime, sent } = createZedraRuntime();
    const pi = createPi();
    createZedraExtension(runtime)(pi as unknown as ExtensionAPI);

    pi.emit("before_agent_start", {});
    pi.events.emit(GOAL_BLOCKED_EVENT, {
      sessionId: "session-1",
      cwd: "/workspace/project",
      goalId: "goal-1",
      objective: "Ship Zedra integration",
      blockedReason: "Need user feedback.",
    });

    expect(sent.map(({ payload }) => payload.hook_event_name)).toEqual([
      "UserPromptSubmit",
      "PermissionRequest",
    ]);
  });

  test("blocked-state events before any turn context are ignored", () => {
    const { runtime, sent } = createZedraRuntime();
    const pi = createPi();
    createZedraExtension(runtime)(pi as unknown as ExtensionAPI);

    pi.events.emit(ASK_USER_QUESTION_PROMPT_EVENT, questionEvent);
    pi.events.emit(GOAL_BLOCKED_EVENT, {
      sessionId: "session-1",
      cwd: "/workspace/project",
      goalId: "goal-1",
      objective: "Ship",
      blockedReason: "Need user feedback.",
    });

    expect(sent).toEqual([]);
  });

  test("invalid blocked-state payloads are ignored", () => {
    const { runtime, sent } = createZedraRuntime();
    const pi = createPi();
    createZedraExtension(runtime)(pi as unknown as ExtensionAPI);

    pi.emit("before_agent_start", {});
    pi.events.emit(ASK_USER_QUESTION_PROMPT_EVENT, { type: "prompt" });
    pi.events.emit(GOAL_BLOCKED_EVENT, { sessionId: "session-1" });

    expect(sent.map(({ payload }) => payload.hook_event_name)).toEqual(["UserPromptSubmit"]);
  });
});
