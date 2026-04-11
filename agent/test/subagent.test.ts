import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ToolExecutionComponent, SessionManager, initTheme, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { setKeybindings } from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";

import { createSubagentExtension } from "../src/extensions/subagent.ts";
import { resolveSubagentMode, resolveModeTools } from "../src/extensions/subagent/modes.ts";
import { TmuxAdapter } from "../src/extensions/subagent/tmux.ts";
import {
  createChildSessionFile,
  getDefaultSessionDir,
  getParentInjectedInputMarkerPath,
  readChildSessionOutcome,
  readChildSessionStatus,
  reduceRuntimeSubagents,
} from "../src/extensions/subagent/session.ts";
import type { MuxAdapter, PaneSubmitMode } from "../src/extensions/subagent/mux.ts";
import { SubagentManager } from "../src/extensions/subagent/state.ts";
import { SUBAGENT_MESSAGE_ENTRY, SUBAGENT_STATE_ENTRY, type RuntimeSubagent } from "../src/extensions/subagent/types.ts";
import { KeybindingsManager } from "../node_modules/@mariozechner/pi-coding-agent/dist/core/keybindings.js";

const TEST_TIMEOUT_MS = 15_000;

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) => test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

initTheme("dark");
setKeybindings(KeybindingsManager.create());

class FakeMuxAdapter implements MuxAdapter {
  readonly backend = "tmux";
  readonly created: Array<{ cwd: string; title: string; command: string; target: "pane" | "window"; paneId: string }> = [];
  readonly sent: Array<{ paneId: string; text: string; submitMode?: PaneSubmitMode }> = [];
  readonly killed: string[] = [];
  readonly existingPanes = new Set<string>();

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createPane(options: { cwd: string; title: string; command: string; target: "pane" | "window" }): Promise<{ paneId: string }> {
    const paneId = `%${this.created.length + 1}`;
    this.created.push({ ...options, paneId });
    this.existingPanes.add(paneId);
    return { paneId };
  }

  async sendText(paneId: string, text: string, submitMode?: PaneSubmitMode): Promise<void> {
    this.sent.push({ paneId, text, submitMode });
  }

  async paneExists(paneId: string): Promise<boolean> {
    return this.existingPanes.has(paneId);
  }

  async killPane(paneId: string): Promise<void> {
    this.killed.push(paneId);
    this.existingPanes.delete(paneId);
  }

  async capturePane(): Promise<{ text: string }> {
    return { text: "" };
  }
}

class FakePi implements Partial<ExtensionAPI> {
  activeTools = ["read", "bash", "subagent", "session_query"];
  allTools = this.activeTools.map((name) => ({ name }));
  appendedEntries: Array<{ customType: string; data: unknown }> = [];
  sentMessages: Array<{ message: unknown; options: unknown }> = [];
  registeredTools = new Map<string, ToolDefinition<any, any>>();
  handlers = new Map<string, Array<(...args: any[]) => any>>();

  appendEntry(customType: string, data?: unknown): void {
    this.appendedEntries.push({ customType, data });
  }

  registerTool(tool: ToolDefinition<any, any>): void {
    this.registeredTools.set(tool.name, tool);
  }

  on(eventName: string, handler: (...args: any[]) => any): void {
    const handlers = this.handlers.get(eventName) ?? [];
    handlers.push(handler);
    this.handlers.set(eventName, handlers);
  }

  sendMessage(message: unknown, options?: unknown): void {
    this.sentMessages.push({ message, options });
  }

  async exec(): Promise<{ code: number; stdout: string; stderr: string }> {
    return { code: 0, stdout: "", stderr: "" };
  }

  getActiveTools(): string[] {
    return [...this.activeTools];
  }

  getAllTools(): Array<{ name: string }> {
    return [...this.allTools];
  }

  setActiveTools(toolNames: string[]): void {
    this.activeTools = [...toolNames];
  }

  setSessionName(): void { }
}

function createFakeContext(options: {
  cwd: string;
  sessionId?: string;
  sessionFile?: string;
  entries?: Array<{ type: string; customType?: string; data?: unknown }>;
  hasUI?: boolean;
}): ExtensionContext {
  const widgets = new Map<string, unknown>();
  return {
    cwd: options.cwd,
    hasUI: options.hasUI ?? true,
    ui: {
      setWidget(key: string, content: unknown) {
        widgets.set(key, content);
      },
      notify() { },
    },
    sessionManager: {
      getSessionId: () => options.sessionId ?? "parent-session-id",
      getSessionFile: () => options.sessionFile,
      getEntries: () => options.entries ?? [],
      getBranch: () => options.entries ?? [],
    },
  } as unknown as ExtensionContext;
}

function renderToolText(tool: ToolDefinition<any, any>, args: Record<string, unknown>, result: { content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean }, expanded: boolean): string {
  const component = new ToolExecutionComponent(
    tool.name,
    `preview-${tool.name}-${expanded ? "expanded" : "collapsed"}`,
    args,
    {},
    tool,
    { requestRender() {} } as never,
    process.cwd(),
  );

  component.setExpanded(expanded);
  component.markExecutionStarted();
  component.setArgsComplete();
  component.updateResult(result, false);
  return stripAnsi(component.render(140).join("\n"));
}

timedTest("resolveModeTools inherits parent tools and denies subagent", () => {
  const resolved = resolveModeTools(undefined, ["read", "bash", "subagent", "session_query"], ["read", "bash", "subagent", "session_query"]);
  assert.deepEqual(resolved, ["bash", "read", "session_query"]);
});

timedTest("resolveModeTools supports explicit allow and deny rules", () => {
  const resolved = resolveModeTools(["*", "!bash", "session_query"], ["read", "bash", "subagent"], ["read", "bash", "subagent", "session_query"]);
  assert.deepEqual(resolved, ["read", "session_query"]);
});

timedTest("resolveSubagentMode loads mode config from the child cwd", async () => {
  const parentCwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-parent-"));
  const childCwd = path.join(parentCwd, "child");
  await fs.mkdir(path.join(childCwd, ".pi"), { recursive: true });
  await fs.writeFile(path.join(childCwd, ".pi", "modes.json"), `${JSON.stringify({
    version: 1,
    modes: {
        reviewer: {
          provider: "mode-provider",
          modelId: "review-model",
          tools: ["read"],
          autoExit: false,
          tmuxTarget: "window",
          systemPrompt: "Review only",
          systemPromptMode: "replace",
        },
    },
  }, null, 2)}\n`, "utf8");

  try {
    const mode = await resolveSubagentMode(
      new FakePi() as unknown as ExtensionAPI,
      createFakeContext({ cwd: parentCwd }),
      { mode: "reviewer", cwd: childCwd },
    );
    assert.ok(mode.value);
    assert.equal(mode.value?.cwd, childCwd);
    assert.equal(mode.value?.model, "mode-provider/review-model");
    assert.deepEqual(mode.value?.tools, ["read"]);
    assert.equal(mode.value?.autoExit, false);
    assert.equal(mode.value?.tmuxTarget, "window");
    assert.equal(mode.value?.systemPrompt, "Review only");
    assert.equal(mode.value?.systemPromptMode, "replace");
  } finally {
    await fs.rm(parentCwd, { recursive: true, force: true });
  }
});

timedTest("TmuxAdapter creates a new tmux window when requested", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const adapter = new TmuxAdapter(async (command, args) => {
    calls.push({ command, args });
    if (args[0] === "new-window") {
      return { code: 0, stdout: "%7\t@3\n", stderr: "" };
    }

    return { code: 0, stdout: "", stderr: "" };
  }, process.cwd());

  const created = await adapter.createPane({
    cwd: "/tmp/project",
    title: "worker-window",
    command: "pi --session fake",
    target: "window",
  });

  assert.equal(created.paneId, "%7");
  assert.deepEqual(calls.map((call) => call.args), [
    ["new-window", "-d", "-c", "/tmp/project", "-P", "-F", "#{pane_id}\t#{window_id}", "pi --session fake"],
    ["rename-window", "-t", "@3", "worker-window"],
    ["select-pane", "-t", "%7", "-T", "worker-window"],
  ]);
});

timedTest("reduceRuntimeSubagents keeps latest state for the current parent session", () => {
  const states = reduceRuntimeSubagents([
    {
      type: "custom",
      customType: SUBAGENT_STATE_ENTRY,
      data: {
        event: "started",
        sessionId: "child-1",
        sessionPath: "/tmp/child-1.jsonl",
        parentSessionId: "parent-a",
        parentSessionPath: "/tmp/parent-a.jsonl",
        name: "worker-a",
        mode: "worker",
        cwd: "/tmp/project",
        paneId: "%1",
        task: "task a",
        handoff: false,
        autoExit: true,
        status: "running",
        startedAt: 1,
        updatedAt: 1,
      },
    },
    {
      type: "custom",
      customType: SUBAGENT_STATE_ENTRY,
      data: {
        event: "completed",
        sessionId: "child-1",
        sessionPath: "/tmp/child-1.jsonl",
        parentSessionId: "parent-a",
        parentSessionPath: "/tmp/parent-a.jsonl",
        name: "worker-a",
        mode: "worker",
        cwd: "/tmp/project",
        paneId: "%1",
        task: "task a",
        handoff: false,
        autoExit: true,
        status: "completed",
        startedAt: 1,
        updatedAt: 2,
        completedAt: 2,
      },
    },
    {
      type: "custom",
      customType: SUBAGENT_STATE_ENTRY,
      data: {
        event: "started",
        sessionId: "child-2",
        sessionPath: "/tmp/child-2.jsonl",
        parentSessionId: "parent-b",
        parentSessionPath: "/tmp/parent-b.jsonl",
        name: "worker-b",
        mode: "worker",
        cwd: "/tmp/project",
        paneId: "%2",
        task: "task b",
        handoff: false,
        autoExit: true,
        status: "running",
        startedAt: 1,
        updatedAt: 1,
      },
    },
  ], "parent-a");

  assert.equal(states.size, 1);
  assert.equal(states.get("child-1")?.status, "completed");
});

timedTest("reduceRuntimeSubagents ignores malformed and unexpected state entries", () => {
  const states = reduceRuntimeSubagents([
    {
      type: "custom",
      customType: SUBAGENT_STATE_ENTRY,
      data: {
        event: "started",
        sessionId: "child-invalid-status",
        sessionPath: "/tmp/child-invalid-status.jsonl",
        parentSessionId: "parent-a",
        parentSessionPath: "/tmp/parent-a.jsonl",
        name: "worker-a",
        mode: "worker",
        cwd: "/tmp/project",
        paneId: "%1",
        task: "task a",
        handoff: false,
        autoExit: true,
        status: "unknown",
        startedAt: 1,
        updatedAt: 1,
      },
    },
    {
      type: "custom",
      customType: SUBAGENT_STATE_ENTRY,
      data: {
        event: "started",
        sessionId: "child-extra-field",
        sessionPath: "/tmp/child-extra-field.jsonl",
        parentSessionId: "parent-a",
        parentSessionPath: "/tmp/parent-a.jsonl",
        name: "worker-b",
        mode: "worker",
        cwd: "/tmp/project",
        paneId: "%2",
        task: "task b",
        handoff: false,
        autoExit: true,
        status: "running",
        startedAt: 1,
        updatedAt: 1,
        unexpected: true,
      },
    },
    {
      type: "custom",
      customType: SUBAGENT_STATE_ENTRY,
      data: {
        event: "started",
        sessionId: "child-valid",
        sessionPath: "/tmp/child-valid.jsonl",
        parentSessionId: "parent-a",
        parentSessionPath: "/tmp/parent-a.jsonl",
        name: "worker-c",
        mode: "worker",
        cwd: "/tmp/project",
        paneId: "%3",
        task: "task c",
        handoff: false,
        autoExit: true,
        status: "running",
        startedAt: 1,
        updatedAt: 1,
      },
    },
  ], "parent-a");

  assert.equal(states.size, 1);
  assert.deepEqual(Array.from(states.keys()), ["child-valid"]);
});

timedTest("createChildSessionFile bootstraps a persisted child session header", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-bootstrap-dir-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-bootstrap-cwd-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const sessionPath = await createChildSessionFile({
      cwd,
      sessionId: "child-session-id",
      parentSessionPath: "/tmp/parent-session.jsonl",
    });

    const sessionManager = SessionManager.open(sessionPath);
    const header = sessionManager.getHeader();
    assert.ok(header);
    assert.equal(header?.id, "child-session-id");
    assert.equal(header?.cwd, cwd);
    assert.equal(header?.parentSession, "/tmp/parent-session.jsonl");
  } finally {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

timedTest("readChildSessionOutcome extracts the last assistant summary", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-outcome-"));
  const sessionPath = path.join(dir, "child.jsonl");
  await fs.writeFile(sessionPath, [
    JSON.stringify({ type: "session", version: 3, id: "child", timestamp: new Date().toISOString(), cwd: dir }),
    JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Finished successfully" }] } }),
  ].join("\n") + "\n", "utf8");

  try {
    const outcome = await readChildSessionOutcome(sessionPath);
    assert.equal(outcome.failed, false);
    assert.equal(outcome.summary, "Finished successfully");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

timedTest("readChildSessionStatus distinguishes running and idle child sessions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-status-"));
  const idlePath = path.join(dir, "idle.jsonl");
  const runningPath = path.join(dir, "running.jsonl");
  const timestamp = new Date().toISOString();

  await fs.writeFile(idlePath, [
    JSON.stringify({ type: "session", version: 3, id: "idle", timestamp, cwd: dir }),
    JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "Do work" }] } }),
    JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp, message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] } }),
  ].join("\n") + "\n", "utf8");

  await fs.writeFile(runningPath, [
    JSON.stringify({ type: "session", version: 3, id: "running", timestamp, cwd: dir }),
    JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "Still working" }] } }),
  ].join("\n") + "\n", "utf8");

  try {
    assert.equal(await readChildSessionStatus(idlePath), "idle");
    assert.equal(await readChildSessionStatus(runningPath), "running");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

timedTest("subagent tool renders compact collapsed success and expanded metadata", () => {
  const fakePi = new FakePi();
  createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(fakePi as unknown as ExtensionAPI);
  const tool = fakePi.registeredTools.get("subagent");
  assert.ok(tool);

  const task = "Continue the review\nInspect failing tests";

  const state: RuntimeSubagent = {
    event: "resumed",
    sessionId: "12345678-1234-1234-1234-123456789abc",
    sessionPath: "/tmp/subagent.jsonl",
    parentSessionId: "parent-session-id",
    parentSessionPath: "/tmp/parent.jsonl",
    name: "worker-one",
    mode: "reviewer",
    modeLabel: "reviewer",
    cwd: "/tmp/project",
    paneId: "%5",
    task,
    handoff: false,
    autoExit: true,
    status: "idle",
    startedAt: 1,
    updatedAt: 2,
  };

  const collapsed = renderToolText(tool, {
    action: "resume",
    sessionId: state.sessionId,
    mode: state.mode,
    task: state.task,
  }, {
    content: [{ type: "text", text: "ok" }],
    details: { action: "resume", args: { action: "resume", sessionId: state.sessionId, mode: state.mode, task: state.task }, prompt: state.task, state },
    isError: false,
  }, false);
  const expanded = renderToolText(tool, {
    action: "resume",
    sessionId: state.sessionId,
    mode: state.mode,
    task: state.task,
  }, {
    content: [{ type: "text", text: "ok" }],
    details: { action: "resume", args: { action: "resume", sessionId: state.sessionId, mode: state.mode, task: state.task }, prompt: state.task, state },
    isError: false,
  }, true);

  const collapsedLines = collapsed.split("\n").filter((line) => line.trim().length > 0);
  assert.equal(collapsedLines.length, 1);
  assert.match(collapsed, /π resume · 12345678 · Continue the review Inspect failing tests · worker-one · idle/);
  assert.doesNotMatch(collapsed, /sessionPath:/);
  assert.doesNotMatch(collapsed, /paneId:/);
  assert.doesNotMatch(collapsed, /prompt:/);
  assert.match(expanded, /π resume/);
  assert.match(expanded, /sessionId: 12345678-1234-1234-1234-123456789abc/);
  assert.match(expanded, /mode: reviewer/);
  assert.match(expanded, /task:/);
  assert.match(expanded, /Continue the review/);
  assert.match(expanded, /Inspect failing tests/);
  assert.match(expanded, /prompt:/);
  assert.match(expanded, /sessionId: 12345678-1234-1234-1234-123456789abc/);
  assert.match(expanded, /paneId: %5/);
  assert.match(expanded, /status: idle/);
  assert.match(expanded, /sessionPath: \/tmp\/subagent\.jsonl/);
  assert.match(expanded, /parentSessionId: parent-session-id/);
  assert.match(expanded, /startedAt: 1970-01-01T00:00:00\.001Z/);
  assert.match(expanded, /updatedAt: 1970-01-01T00:00:00\.002Z/);
});

timedTest("subagent tool renders collapsed list summary counts and cancel status", () => {
  const fakePi = new FakePi();
  createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(fakePi as unknown as ExtensionAPI);
  const tool = fakePi.registeredTools.get("subagent");
  assert.ok(tool);

  const baseState = {
    event: "restored" as const,
    parentSessionId: "parent-session-id",
    parentSessionPath: "/tmp/parent.jsonl",
    mode: "worker",
    modeLabel: "worker",
    cwd: "/tmp/project",
    handoff: false,
    autoExit: true,
    startedAt: 1,
    updatedAt: 2,
  };

  const listCollapsed = renderToolText(tool, {
    action: "list",
  }, {
    content: [{ type: "text", text: "ok" }],
    details: {
      action: "list",
      args: { action: "list" },
      subagents: [
        {
          ...baseState,
          sessionId: "running-1",
          sessionPath: "/tmp/running-1.jsonl",
          name: "worker-one",
          paneId: "%1",
          task: "Task one",
          status: "running",
        },
        {
          ...baseState,
          sessionId: "idle-1",
          sessionPath: "/tmp/idle-1.jsonl",
          name: "worker-two",
          paneId: "%2",
          task: "Task two",
          status: "idle",
        },
        {
          ...baseState,
          sessionId: "completed-1",
          sessionPath: "/tmp/completed-1.jsonl",
          name: "worker-three",
          paneId: "%3",
          task: "Task three",
          status: "completed",
          completedAt: 3,
        },
      ],
    },
    isError: false,
  }, false);

  assert.match(listCollapsed, /π list · 3 agents · 1 running · 1 idle · 1 completed/);
  assert.doesNotMatch(listCollapsed, /cancelled/);
  assert.doesNotMatch(listCollapsed, /failed/);

  const cancelledState: RuntimeSubagent = {
    ...baseState,
    event: "cancelled",
    sessionId: "cancelled-1",
    sessionPath: "/tmp/cancelled-1.jsonl",
    name: "worker-stop",
    paneId: "%8",
    task: "Stop this agent",
    status: "cancelled",
    completedAt: 4,
  };

  const cancelCollapsed = renderToolText(tool, {
    action: "cancel",
    sessionId: cancelledState.sessionId,
  }, {
    content: [{ type: "text", text: "ok" }],
    details: {
      action: "cancel",
      args: { action: "cancel", sessionId: cancelledState.sessionId },
      state: cancelledState,
    },
    isError: false,
  }, false);

  assert.match(cancelCollapsed, /π cancel · cancelle · worker-stop · cancelled/);
});

timedTest("subagent tool execute preserves prompt and expanded resume details", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-tool-dir-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-tool-cwd-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const fakePi = new FakePi();
  const fakeMux = new FakeMuxAdapter();
  createSubagentExtension({ adapterFactory: () => fakeMux })(fakePi as unknown as ExtensionAPI);
  const tool = fakePi.registeredTools.get("subagent");
  assert.ok(tool);

  try {
    const ctx = createFakeContext({
      cwd,
      sessionFile: path.join(cwd, "parent.jsonl"),
    });

    const startTask = "Inspect the failing tests";
    const started = await tool.execute(
      "tool-call-start",
      { action: "start", name: "worker-one", task: startTask },
      undefined,
      undefined,
      ctx,
    );

    assert.equal((started.details as { prompt: string }).prompt, startTask);
    const startedSessionId = ((started.details as { state: RuntimeSubagent }).state).sessionId;
    fakeMux.existingPanes.clear();

    const resumeTask = "Continue the review\nInspect failing tests and summarize root cause";
    const resumed = await tool.execute(
      "tool-call-resume",
      { action: "resume", sessionId: startedSessionId, mode: "worker", task: resumeTask },
      undefined,
      undefined,
      ctx,
    );

    const resumedDetails = resumed.details as { prompt: string; state: RuntimeSubagent };
    assert.equal(resumedDetails.prompt, resumeTask);
    assert.equal(resumedDetails.state.sessionId, startedSessionId);

    const expanded = renderToolText(
      tool,
      { action: "resume", sessionId: startedSessionId, mode: "worker", task: resumeTask },
      { content: resumed.content as Array<{ type: "text"; text: string }>, details: resumed.details, isError: false },
      true,
    );

    assert.match(expanded, /sessionId: /);
    assert.match(expanded, /prompt:/);
    assert.match(expanded, /Continue the review/);
    assert.match(expanded, /Inspect failing tests and summarize root cause/);
    assert.match(expanded, /sessionPath: /);
  } finally {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

timedTest("SubagentManager start, resume, message, cancel, and restore cover the lifecycle", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-dir-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-cwd-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const fakePi = new FakePi();
  const fakeMux = new FakeMuxAdapter();
  const launched: Array<{ state: RuntimeSubagent; childState: unknown; prompt: string; options: unknown }> = [];
  const manager = new SubagentManager(
    fakePi as unknown as ExtensionAPI,
    fakeMux,
    (state, childState, prompt, options) => {
      launched.push({ state, childState, prompt, options });
      return "pi --session fake";
    },
  );

  try {
    await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".pi", "modes.json"), `${JSON.stringify({
      version: 1,
      modes: {
        reviewer: {
          provider: "mode-provider",
          modelId: "review-model",
          tools: ["read"],
          autoExit: true,
          tmuxTarget: "window",
          systemPrompt: "Review only",
        },
      },
    }, null, 2)}\n`, "utf8");

    const ctx = createFakeContext({
      cwd,
      sessionFile: path.join(cwd, "parent.jsonl"),
    });

    const started = await manager.start({
      name: "worker-one",
      task: "Inspect the failing tests",
      mode: "reviewer",
    }, ctx);
    assert.equal(started.state.status, "running");
    assert.equal(fakeMux.created.length, 1);
    assert.equal(fakeMux.created[0]?.target, "window");
    assert.equal(launched.length, 1);
    const launch = launched[0]!;
    assert.equal(launch.prompt, "Inspect the failing tests");
    assert.equal(fakeMux.sent.length, 0);
    assert.deepEqual((launch.childState as { tools: string[] }).tools, ["read"]);
    assert.deepEqual(launch.options, {
      launchTarget: { kind: "session", sessionPath: started.state.sessionPath },
      tmuxTarget: "window",
      mode: "reviewer",
      model: "mode-provider/review-model",
      thinkingLevel: undefined,
      systemPrompt: "Review only",
      systemPromptMode: "append",
    });
    assert.equal(fakePi.appendedEntries.filter((entry) => entry.customType === SUBAGENT_STATE_ENTRY).length, 1);
    const persistedStartedState = fakePi.appendedEntries.find((entry) => entry.customType === SUBAGENT_STATE_ENTRY)?.data as Record<string, unknown> | undefined;
    assert.ok(persistedStartedState);
    assert.equal("modeLabel" in persistedStartedState, false);
    assert.equal(manager.list().length, 1);

    const delivered = await manager.message({
      sessionId: started.state.sessionId,
      message: "Focus on src/extensions first",
      delivery: "steer",
    });
    assert.equal(delivered.status, "running");
    assert.equal(fakeMux.sent.length, 1);
    assert.equal(fakeMux.sent[0]?.submitMode, "steer");
    assert.equal(fakePi.appendedEntries.filter((entry) => entry.customType === SUBAGENT_MESSAGE_ENTRY).length, 2);
    const parentInputMarker = JSON.parse(await fs.readFile(getParentInjectedInputMarkerPath(started.state.sessionId), "utf8")) as { expiresAt: number };
    assert.ok(parentInputMarker.expiresAt > Date.now());

    const cancelled = await manager.cancel({ sessionId: started.state.sessionId });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(fakeMux.killed.length, 1);
    assert.equal(manager.list().length, 1);
    assert.equal(manager.list()[0]?.status, "cancelled");
    assert.equal(fakePi.sentMessages.length, 1);

    const resumed = await manager.resume({
      sessionId: started.state.sessionId,
      task: "Address the review feedback",
      mode: "reviewer",
    }, ctx);
    assert.equal(resumed.state.status, "running");
    assert.equal(resumed.state.sessionId, started.state.sessionId);
    assert.equal(resumed.state.paneId, "%2");
    assert.equal(fakeMux.created.length, 2);
    assert.equal(fakeMux.created[1]?.target, "window");
    assert.equal(launched.length, 2);
    assert.equal(launched[1]?.prompt, "Address the review feedback");
    assert.deepEqual(launched[1]?.options, {
      launchTarget: { kind: "session", sessionPath: started.state.sessionPath },
      tmuxTarget: "window",
      mode: "reviewer",
      model: "mode-provider/review-model",
      thinkingLevel: undefined,
      systemPrompt: "Review only",
      systemPromptMode: "append",
    });
    fakeMux.existingPanes.delete(resumed.state.paneId);

    const restoredSessionId = "restored-child";
    const childSessionDir = getDefaultSessionDir(cwd);
    const childSessionPath = path.join(childSessionDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${restoredSessionId}.jsonl`);
    await fs.mkdir(path.dirname(childSessionPath), { recursive: true });
    await fs.writeFile(childSessionPath, [
      JSON.stringify({ type: "session", version: 3, id: restoredSessionId, timestamp: new Date().toISOString(), cwd }),
      JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Restored completion summary" }] } }),
    ].join("\n") + "\n", "utf8");

    const restoreCtx = createFakeContext({
      cwd,
      sessionId: "parent-session-id",
      sessionFile: path.join(cwd, "parent.jsonl"),
      entries: [{
        type: "custom",
        customType: SUBAGENT_STATE_ENTRY,
        data: {
          event: "started",
          sessionId: restoredSessionId,
          sessionPath: childSessionPath,
          parentSessionId: "parent-session-id",
          parentSessionPath: path.join(cwd, "parent.jsonl"),
          name: "worker-restore",
          mode: "worker",
          cwd,
          paneId: "%999",
          task: "restore me",
          handoff: false,
          autoExit: true,
          status: "running",
          startedAt: Date.now(),
          updatedAt: Date.now(),
        },
      }],
    });

    await manager.restore(restoreCtx);
    assert.equal(manager.list().find((state) => state.sessionId === restoredSessionId)?.status, "completed");
    const completedStates = fakePi.appendedEntries.filter((entry) => entry.customType === SUBAGENT_STATE_ENTRY) as Array<{ customType: string; data: RuntimeSubagent }>;
    assert.equal(completedStates.at(-1)?.data.status, "completed");
    assert.equal(fakePi.sentMessages.length, 2);
    assert.deepEqual(fakePi.sentMessages[1]?.options, { deliverAs: "steer", triggerTurn: true });
  } finally {
    manager.dispose();
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
