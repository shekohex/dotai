import { afterEach, beforeEach, expect, test, vi } from "vitest";

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
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  return {
    events: {
      emit: (eventName: string, data: unknown) => {
        for (const handler of eventHandlers.get(eventName) ?? []) {
          handler(data);
        }
      },
      on: (eventName: string, handler: (data: unknown) => void) => {
        eventHandlers.set(eventName, [...(eventHandlers.get(eventName) ?? []), handler]);
        return () => {};
      },
    },
    on: (eventName: string, handler: Handler) => {
      handlers.set(eventName, handler);
    },
    getSessionName: () => undefined,
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
  hasUI: true,
  ui: {
    setTitle: vi.fn(),
  },
  sessionManager: {
    getSessionId: () => "session-1",
  },
});

const decodeSequence = (sequence: string) => {
  const frame = sequence.startsWith("\u001bPtmux;")
    ? sequence.slice("\u001bPtmux;".length, -2).replaceAll("\u001b\u001b", "\u001b")
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

beforeEach(() => {
  vi.spyOn(terminalNotifyRuntime, "execFileSync").mockImplementation(() => {
    throw new Error("tmux not available");
  });
});

afterEach(() => {
  vi.useRealTimers();
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

test("agent lifecycle animates terminal title spinner", () => {
  vi.useFakeTimers();
  const pi = createPi();
  vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);
  piOscExtension(pi);
  const ctx = createContext();

  pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  pi.emit("agent_start", { type: "agent_start" }, ctx);
  vi.advanceTimersByTime(100);
  pi.emit(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "tool-read",
      toolName: "read",
      input: { file_path: "/workspace/src/foo.ts" },
    },
    ctx,
  );
  pi.emit(
    "tool_execution_start",
    {
      type: "tool_execution_start",
      toolCallId: "tool-read",
      toolName: "read",
      args: { file_path: "/workspace/src/foo.ts" },
    },
    ctx,
  );
  vi.advanceTimersByTime(100);
  pi.emit(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "tool-edit",
      toolName: "edit",
      input: { file_path: "/workspace/src/foo.ts" },
    },
    ctx,
  );
  pi.emit(
    "tool_execution_start",
    {
      type: "tool_execution_start",
      toolCallId: "tool-edit",
      toolName: "edit",
      args: { file_path: "/workspace/src/foo.ts" },
    },
    ctx,
  );
  pi.emit(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "tool-bash",
      toolName: "bash",
      input: { command: "npm test" },
    },
    ctx,
  );
  pi.emit(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "tool-git",
      toolName: "bash",
      input: { command: "git commit -m fix" },
    },
    ctx,
  );
  pi.emit(
    "tool_execution_start",
    {
      type: "tool_execution_start",
      toolCallId: "tool-bash",
      toolName: "bash",
      args: { command: "npm test" },
    },
    ctx,
  );
  pi.emit("agent_end", { type: "agent_end", messages: [] }, ctx);

  expect(ctx.ui.setTitle).toHaveBeenNthCalledWith(1, "π - workspace");
  expect(ctx.ui.setTitle).toHaveBeenNthCalledWith(2, "π - workspace");
  expect(ctx.ui.setTitle).toHaveBeenNthCalledWith(3, "· π - workspace");
  expect(ctx.ui.setTitle).toHaveBeenNthCalledWith(4, "✻ π - workspace");
  expect(ctx.ui.setTitle).toHaveBeenCalledWith("⣾ π - workspace");
  expect(ctx.ui.setTitle).toHaveBeenCalledWith("⠋ π - workspace");
  expect(ctx.ui.setTitle).toHaveBeenCalledWith("- π - workspace");
  expect(ctx.ui.setTitle).toHaveBeenCalledWith("✶ π - workspace");
  expect(ctx.ui.setTitle).toHaveBeenLastCalledWith("π - workspace");
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
  pi.emit("tool_call", {
    type: "tool_call",
    toolCallId: "tool-1",
    toolName: "bash",
    input: { command: "secret" },
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
    label: "Bashing",
  });
  expect(JSON.stringify(decoded)).not.toContain("secret");
});

test.each([
  ["rg TODO src", "Searching files", "Search finished"],
  ["fd kt app/src", "Exploring files", "Exploration finished"],
  ["find app -name '*.kt'", "Exploring files", "Exploration finished"],
  ["git commit -m fix", "Committing changes", "Git commit finished"],
  ["git push origin main", "Pushing changes", "Git push finished"],
  ["./gradlew assembleRelease", "Building project", "Build finished"],
  ["npm test", "Running tests", "Tests finished"],
  ["echo hello", "Bashing", "Shell command finished"],
])("classifies bash command notifications for %s", (command, label, summary) => {
  const pi = createPi();
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);
  vi.spyOn(piOscRuntime, "now").mockReturnValue(1);
  vi.spyOn(piOscRuntime, "randomId").mockReturnValue("evt");
  piOscExtension(pi);

  pi.emit("tool_call", {
    type: "tool_call",
    toolCallId: "tool-bash",
    toolName: "bash",
    input: { command, description: "contains secret" },
  });
  pi.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "tool-bash",
    toolName: "bash",
    result: "secret output",
    isError: false,
  });

  const decoded = stdoutSpy.mock.calls.map((call) => decodeSequence(call[0]));
  expect(decoded[0]?.envelope.data).toMatchObject({ label });
  expect(decoded[1]?.envelope.data).toMatchObject({ summary });
  expect(JSON.stringify(decoded)).not.toContain("secret");
});

test.each([
  ["websearch", "Searching web", "Web search complete"],
  ["webfetch", "Fetching page", "Fetched page"],
  ["execute", "Executing tool code", "Tool code finished"],
  ["resume", "Resuming executor", "Executor resumed"],
  ["goal", "Updating goal", "Goal updated"],
  ["interview", "Preparing interview", "Interview ready"],
  ["subagent", "Working with subagent", "Subagent task finished"],
  ["notify", "Sending notification", "Notification sent"],
  ["generate_image", "Generating image", "Image generated"],
  ["session_query", "Querying session", "Session query finished"],
  ["submit_plan", "Submitting plan", "Plan submitted"],
])("classifies built-in tool notifications for %s", (toolName, label, summary) => {
  const pi = createPi();
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);
  vi.spyOn(piOscRuntime, "now").mockReturnValue(1);
  vi.spyOn(piOscRuntime, "randomId").mockReturnValue("evt");
  piOscExtension(pi);

  pi.emit("tool_call", {
    type: "tool_call",
    toolCallId: "tool-1",
    toolName,
    input: {},
  });
  pi.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName,
    result: "secret output",
    isError: false,
  });

  const decoded = stdoutSpy.mock.calls.map((call) => decodeSequence(call[0]));
  expect(decoded[0]?.envelope.data).toMatchObject({ label });
  expect(decoded[1]?.envelope.data).toMatchObject({ summary });
  expect(JSON.stringify(decoded)).not.toContain("secret");
});

test("tool progress includes safe file labels and summaries", () => {
  const pi = createPi();
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);
  vi.spyOn(piOscRuntime, "now").mockReturnValue(1);
  vi.spyOn(piOscRuntime, "randomId").mockReturnValue("evt");
  piOscExtension(pi);

  pi.emit("tool_call", {
    type: "tool_call",
    toolCallId: "tool-read",
    toolName: "read",
    input: { file_path: "/workspace/src/foo.ts" },
  });
  pi.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "tool-read",
    toolName: "read",
    args: { file_path: "/workspace/src/foo.ts" },
    result: "one\ntwo\nthree",
    isError: false,
  });

  const decoded = stdoutSpy.mock.calls.map((call) => decodeSequence(call[0]));
  expect(decoded[0]?.envelope.data).toMatchObject({
    state: "running",
    label: "Reading foo.ts",
  });
  expect(decoded[1]?.envelope.data).toMatchObject({
    state: "complete",
    label: "Reading foo.ts",
    summary: "Read foo.ts (3 lines)",
  });
});

test("tool execution start does not duplicate pre-execution tool call event", () => {
  const pi = createPi();
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);
  vi.spyOn(piOscRuntime, "now").mockReturnValue(1);
  vi.spyOn(piOscRuntime, "randomId").mockReturnValue("evt");
  piOscExtension(pi);

  pi.emit("tool_call", {
    type: "tool_call",
    toolCallId: "tool-1",
    toolName: "edit",
    input: { file_path: "/workspace/src/foo.ts" },
  });
  pi.emit("tool_execution_start", {
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "edit",
    args: { file_path: "/workspace/src/foo.ts" },
  });

  const decoded = stdoutSpy.mock.calls.map((call) => decodeSequence(call[0]));
  expect(decoded).toHaveLength(1);
  expect(decoded[0]?.envelope.data).toMatchObject({
    state: "running",
    label: "Editing foo.ts",
  });
});

test("tool completion clears tool-specific title activity", () => {
  vi.useFakeTimers();
  const pi = createPi();
  vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);
  vi.spyOn(piOscRuntime, "now").mockReturnValue(1);
  vi.spyOn(piOscRuntime, "randomId").mockReturnValue("evt");
  piOscExtension(pi);
  const ctx = createContext();

  pi.emit("agent_start", { type: "agent_start" }, ctx);
  pi.emit(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "tool-1",
      toolName: "edit",
      input: { file_path: "/workspace/src/foo.ts" },
    },
    ctx,
  );
  pi.emit(
    "tool_execution_end",
    {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "edit",
      result: "ok",
      isError: false,
    },
    ctx,
  );

  expect(ctx.ui.setTitle).toHaveBeenCalledWith("⠋ π - workspace");
  expect(ctx.ui.setTitle).toHaveBeenLastCalledWith("· π - workspace");
});

test("tool completion carries cached safe label from matching pre-execution tool call id", () => {
  const pi = createPi();
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);
  vi.spyOn(piOscRuntime, "now").mockReturnValue(1);
  vi.spyOn(piOscRuntime, "randomId").mockReturnValue("evt");
  piOscExtension(pi);

  pi.emit("tool_call", {
    type: "tool_call",
    toolCallId: "tool-a",
    toolName: "read",
    input: { file_path: "/workspace/a.ts" },
  });
  pi.emit("tool_call", {
    type: "tool_call",
    toolCallId: "tool-b",
    toolName: "read",
    input: { file_path: "/workspace/b.ts" },
  });
  pi.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "tool-a",
    toolName: "read",
    result: "one",
    isError: false,
  });

  const decoded = stdoutSpy.mock.calls.map((call) => decodeSequence(call[0]));
  expect(decoded.at(-1)?.envelope.data).toMatchObject({
    toolCallId: "tool-a",
    label: "Reading a.ts",
    summary: "Read a.ts (1 lines)",
  });
});

test("message updates emit debounced thinking progress", () => {
  const pi = createPi();
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);
  vi.spyOn(piOscRuntime, "randomId").mockReturnValue("evt");
  const timestamps = [1_000, 1_000, 1_200, 2_000, 2_000];
  vi.spyOn(piOscRuntime, "now").mockImplementation(() => timestamps.shift() ?? 2_000);
  piOscExtension(pi);

  pi.emit("message_update", {
    type: "message_update",
    message: {},
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "a", partial: {} },
  });
  pi.emit("message_update", {
    type: "message_update",
    message: {},
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "b", partial: {} },
  });
  pi.emit("message_update", {
    type: "message_update",
    message: {},
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "c", partial: {} },
  });

  const decoded = stdoutSpy.mock.calls.map((call) => decodeSequence(call[0]));
  expect(decoded).toHaveLength(2);
  expect(decoded.map((item) => item.envelope.data)).toEqual([
    { state: "active", label: "Thinking" },
    { state: "active", label: "Thinking" },
  ]);
});

test("message updates classify text and toolcall progress from metadata", () => {
  const pi = createPi();
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);
  vi.spyOn(piOscRuntime, "randomId").mockReturnValue("evt");
  const timestamps = [1_000, 2_000];
  vi.spyOn(piOscRuntime, "now").mockImplementation(() => timestamps.shift() ?? 2_000);
  piOscExtension(pi);

  pi.emit("message_update", {
    type: "message_update",
    message: {},
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial: {} },
  });
  pi.emit("message_update", {
    type: "message_update",
    message: {},
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: {} },
  });

  const decoded = stdoutSpy.mock.calls.map((call) => decodeSequence(call[0]));
  expect(decoded.map((item) => item.envelope.data)).toEqual([
    { state: "active", label: "Writing" },
    { state: "active", label: "Preparing tool" },
  ]);
});

test("agent end emits final assistant message as success alert", () => {
  const pi = createPi();
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);
  vi.spyOn(piOscRuntime, "now").mockReturnValue(1);
  vi.spyOn(piOscRuntime, "randomId").mockReturnValue("evt");
  piOscExtension(pi);

  pi.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", content: "Done **now**" }],
  });

  const decoded = stdoutSpy.mock.calls.map((call) => decodeSequence(call[0]));
  expect(decoded.at(-1)?.eventName).toBe("agent.alert");
  expect(decoded.at(-1)?.envelope.data).toMatchObject({
    kind: "runtime",
    severity: "success",
    title: "π",
    body: "Done now",
  });
});

test("aborted turn emits operation aborted event once", () => {
  const pi = createPi();
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);
  vi.spyOn(piOscRuntime, "now").mockReturnValue(1);
  vi.spyOn(piOscRuntime, "randomId").mockReturnValue("evt");
  piOscExtension(pi);

  const message = { role: "assistant", stopReason: "aborted", errorMessage: "Operation aborted" };
  pi.emit("turn_end", { type: "turn_end", turnIndex: 1, message, toolResults: [] });
  pi.emit("agent_end", { type: "agent_end", messages: [message] });

  const decoded = stdoutSpy.mock.calls.map((call) => decodeSequence(call[0]));
  const aborted = decoded.filter((item) => item.eventName === "agent.aborted");
  expect(aborted).toHaveLength(1);
  expect(aborted[0]?.envelope.data).toMatchObject({
    reason: "user",
    message: "Operation aborted",
  });
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

  pi.emit("tool_call", {
    type: "tool_call",
    toolCallId: "i".repeat(200),
    toolName: "n".repeat(200),
    input: {},
  });

  const decoded = decodeSequence(stdoutSpy.mock.calls[0]?.[0] ?? "");
  expect(decoded.envelope.data.toolCallId).toHaveLength(128);
  expect(decoded.envelope.data.toolName).toHaveLength(128);
});

test("goal progress event emits elapsed progress payload", () => {
  const pi = createPi();
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);
  vi.spyOn(piOscRuntime, "now").mockReturnValue(1);
  vi.spyOn(piOscRuntime, "randomId").mockReturnValue("evt");
  piOscExtension(pi);

  pi.emit("session_start", { type: "session_start", reason: "startup" });
  pi.events.emit("goal:progress", {
    status: "active",
    sessionId: "session-1",
    cwd: "/workspace",
    timeUsedSeconds: 65,
  });

  const decoded = decodeSequence(stdoutSpy.mock.calls[2]?.[0] ?? "");
  expect(decoded.eventName).toBe("agent.progress");
  expect(decoded.envelope.data).toEqual({
    state: "active",
    elapsedSeconds: 65,
  });
});

test("goal clear before active progress is ignored", () => {
  const pi = createPi();
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);
  vi.spyOn(piOscRuntime, "now").mockReturnValue(1);
  vi.spyOn(piOscRuntime, "randomId").mockReturnValue("evt");
  piOscExtension(pi);

  pi.events.emit("goal:progress", {
    status: "clear",
    sessionId: "session-1",
    cwd: "/workspace",
  });

  expect(stdoutSpy).not.toHaveBeenCalled();
});

test("tmux writes raw Pi OSC sequence to client tty", () => {
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
    expect.stringContaining("\u001b]6767;pi;1;agent.run;"),
    { encoding: "utf8" },
  );
  expect(stdoutSpy).not.toHaveBeenCalled();
});

test("tmux falls back to passthrough sequence when client tty raw write fails", () => {
  process.env.TMUX = "/tmp/tmux-1000/default,123,0";
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_CLIENT;
  delete process.env.SSH_TTY;
  const pi = createPi();
  vi.spyOn(terminalNotifyRuntime, "execFileSync").mockReturnValue("/dev/ttys009\n");
  const writeFileSyncSpy = vi
    .spyOn(terminalNotifyRuntime, "writeFileSync")
    .mockImplementationOnce(() => {
      throw new Error("raw unavailable");
    })
    .mockImplementation(() => undefined);
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);
  vi.spyOn(piOscRuntime, "now").mockReturnValue(1);
  vi.spyOn(piOscRuntime, "randomId").mockReturnValue("evt");
  piOscExtension(pi);

  pi.emit("agent_start", { type: "agent_start" });

  expect(writeFileSyncSpy).toHaveBeenNthCalledWith(
    2,
    "/dev/ttys009",
    expect.stringContaining("\u001bPtmux;\u001b\u001b]6767;pi;1;agent.run;"),
    { encoding: "utf8" },
  );
  expect(stdoutSpy).not.toHaveBeenCalled();
});
