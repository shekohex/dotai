import { afterEach, expect, test, vi } from "vitest";

vi.mock("../src/subagent-sdk/index.js", () => ({
  isChildSession: () => false,
  readChildState: () => undefined,
}));

import piOscExtension, { piOscRuntime } from "../src/extensions/pi-osc/extension.js";
import { terminalNotifyRuntime } from "../src/extensions/terminal-notify.js";

const originalTmux = process.env.TMUX;
const originalSshConnection = process.env.SSH_CONNECTION;
const originalSshClient = process.env.SSH_CLIENT;
const originalSshTty = process.env.SSH_TTY;

type Handler = (event: Record<string, unknown>, ctx: ReturnType<typeof createContext>) => void;

const createPi = () => {
  const handlers = new Map<string, Handler>();
  return {
    on: (eventName: string, handler: Handler) => {
      handlers.set(eventName, handler);
    },
    emit: (eventName: string, event: Record<string, unknown>, ctx = createContext()) => {
      const handler = handlers.get(eventName);
      if (handler === undefined) {
        throw new Error(`Missing handler: ${eventName}`);
      }
      handler(event, ctx);
    },
  };
};

const createContext = () => ({
  cwd: "/workspace",
  sessionManager: {
    getSessionId: () => "session-1",
  },
});

const decodeSequence = (sequence: string) => {
  const frame = sequence.startsWith("\u001bPtmux;")
    ? sequence.slice(8, -2).replaceAll("\u001b\u001b", "\u001b")
    : sequence;
  const body = frame.slice(2, -2);
  const [command, namespace, version, eventName, payload] = body.split(";");
  return {
    command,
    namespace,
    version,
    eventName,
    envelope: JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")),
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
  if (originalSshConnection === undefined) delete process.env.SSH_CONNECTION;
  else process.env.SSH_CONNECTION = originalSshConnection;
  if (originalSshClient === undefined) delete process.env.SSH_CLIENT;
  else process.env.SSH_CLIENT = originalSshClient;
  if (originalSshTty === undefined) delete process.env.SSH_TTY;
  else process.env.SSH_TTY = originalSshTty;
});

test("session_start emits hello and session events to stdout", () => {
  const pi = createPi();
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);
  vi.spyOn(piOscRuntime, "now").mockReturnValue(1779200000000);
  vi.spyOn(piOscRuntime, "randomId").mockReturnValue("evt-1");
  piOscExtension(pi);

  pi.emit("session_start", { type: "session_start", reason: "startup" });

  expect(stdoutSpy).toHaveBeenCalledTimes(2);
  expect(stdoutSpy.mock.calls[0]?.[0]).toBe(
    "\u001b]6767;pi;1;hello;eyJpZCI6ImV2dC0xIiwidHMiOjE3NzkyMDAwMDAwMDAsInNvdXJjZSI6ImFnZW50Iiwic2Vzc2lvbklkIjoic2Vzc2lvbi0xIiwiY3dkIjoiL3dvcmtzcGFjZSIsInNlcSI6MSwiZGF0YSI6eyJwcm90b2NvbCI6MSwiZXh0ZW5zaW9uIjoicGktb3NjIiwidmVyc2lvbiI6MX19\u001b\\",
  );
  const session = decodeSequence(stdoutSpy.mock.calls[1]?.[0] ?? "");
  expect(session.eventName).toBe("agent.session");
  expect(session.envelope.data).toEqual({ state: "started", reason: "startup" });
});

test("lifecycle events emit every V1 event", () => {
  const pi = createPi();
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);
  vi.spyOn(piOscRuntime, "now").mockReturnValue(1);
  vi.spyOn(piOscRuntime, "randomId").mockReturnValue("evt");
  piOscExtension(pi);

  pi.emit("session_start", { type: "session_start", reason: "startup" });
  pi.emit("agent_start", { type: "agent_start" });
  pi.emit("turn_start", { type: "turn_start", turnIndex: 2, timestamp: 1 });
  pi.emit("tool_execution_start", {
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "bash",
    args: { command: "secret" },
  });
  pi.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "bash",
    result: "secret",
    isError: false,
  });
  pi.emit("turn_end", { type: "turn_end", turnIndex: 2, message: {}, toolResults: [] });
  pi.emit("session_before_compact", { type: "session_before_compact" });
  pi.emit("session_compact", { type: "session_compact", fromExtension: false });
  pi.emit("after_provider_response", { type: "after_provider_response", status: 429, headers: {} });
  pi.emit("agent_end", { type: "agent_end", messages: [] });

  const decoded = stdoutSpy.mock.calls.map((call) => decodeSequence(call[0]));
  expect(decoded.map((item) => item.eventName)).toEqual([
    "hello",
    "agent.session",
    "agent.run",
    "agent.progress",
    "agent.turn",
    "agent.tool",
    "agent.tool",
    "agent.turn",
    "agent.compaction",
    "agent.compaction",
    "agent.alert",
    "agent.run",
    "agent.progress",
  ]);
  expect(decoded.find((item) => item.eventName === "agent.tool")?.envelope.data).toEqual({
    toolCallId: "tool-1",
    toolName: "bash",
    state: "running",
  });
  expect(JSON.stringify(decoded)).not.toContain("secret");
});

test("non-429 provider responses do not emit alerts", () => {
  const pi = createPi();
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);
  piOscExtension(pi);

  pi.emit("after_provider_response", { type: "after_provider_response", status: 500, headers: {} });

  expect(stdoutSpy).not.toHaveBeenCalled();
});

test("tool fields are bounded before emission", () => {
  const pi = createPi();
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);
  vi.spyOn(piOscRuntime, "now").mockReturnValue(1);
  vi.spyOn(piOscRuntime, "randomId").mockReturnValue("evt");
  piOscExtension(pi);

  pi.emit("tool_execution_start", {
    type: "tool_execution_start",
    toolCallId: "i".repeat(200),
    toolName: "n".repeat(200),
    args: {},
  });

  const decoded = decodeSequence(stdoutSpy.mock.calls[0]?.[0] ?? "");
  expect(decoded.envelope.data.toolCallId).toHaveLength(128);
  expect(decoded.envelope.data.toolName).toHaveLength(128);
});

test("tmux writes passthrough sequence to pane tty", () => {
  process.env.TMUX = "/tmp/tmux-1000/default,123,0";
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_CLIENT;
  delete process.env.SSH_TTY;
  const pi = createPi();
  vi.spyOn(terminalNotifyRuntime, "execFileSync").mockReturnValue("/dev/ttys009\n");
  const writeFileSyncSpy = vi
    .spyOn(terminalNotifyRuntime, "writeFileSync")
    .mockImplementation(() => undefined);
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);
  vi.spyOn(piOscRuntime, "now").mockReturnValue(1);
  vi.spyOn(piOscRuntime, "randomId").mockReturnValue("evt");
  piOscExtension(pi);

  pi.emit("agent_start", { type: "agent_start" });

  expect(writeFileSyncSpy).toHaveBeenCalledWith(
    "/dev/ttys009",
    expect.stringContaining("\u001bPtmux;\u001b\u001b\u001b]6767;pi;1;agent.run;"),
    { encoding: "utf8" },
  );
  expect(stdoutSpy).not.toHaveBeenCalled();
});
