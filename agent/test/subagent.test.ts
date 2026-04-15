import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ToolExecutionComponent,
  SessionManager,
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { setKeybindings } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import stripAnsi from "strip-ansi";

import { createSubagentExtension } from "../src/extensions/subagent.ts";
import { formatAvailableModesXml } from "../src/extensions/available-modes.ts";
import { resolveSubagentMode, resolveModeTools } from "../src/subagent-sdk/modes.ts";
import { TmuxAdapter } from "../src/subagent-sdk/tmux.ts";
import {
  activateAutoExitTimeoutMode,
  createChildSessionFile,
  getDefaultSessionDir,
  getAutoExitTimeoutModeMarkerPath,
  getParentInjectedInputMarkerPath,
  isAutoExitTimeoutModeActive,
  readChildSessionOutcome,
  readChildSessionStatus,
  reduceRuntimeSubagents,
} from "../src/subagent-sdk/persistence.ts";
import type { MuxAdapter, PaneSubmitMode } from "../src/subagent-sdk/mux.ts";
import { SubagentRuntime } from "../src/subagent-sdk/runtime.ts";
import {
  SUBAGENT_MESSAGE_ENTRY,
  SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
  SUBAGENT_STATE_ENTRY,
  cloneRuntimeSubagent,
  type RuntimeSubagent,
} from "../src/subagent-sdk/types.ts";
import { renderSubagentWidget } from "../src/subagent-sdk/ui.ts";
import { KeybindingsManager } from "../node_modules/@mariozechner/pi-coding-agent/dist/core/keybindings.js";

const TEST_TIMEOUT_MS = 15_000;

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

initTheme("dark");
setKeybindings(KeybindingsManager.create());

class FakeMuxAdapter implements MuxAdapter {
  readonly backend = "tmux";
  readonly created: Array<{
    cwd: string;
    title: string;
    command: string;
    target: "pane" | "window";
    paneId: string;
  }> = [];
  readonly sent: Array<{ paneId: string; text: string; submitMode?: PaneSubmitMode }> = [];
  readonly killed: string[] = [];
  readonly existingPanes = new Set<string>();

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createPane(options: {
    cwd: string;
    title: string;
    command: string;
    target: "pane" | "window";
  }): Promise<{ paneId: string }> {
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
  sentUserMessages: Array<{ content: unknown; options: unknown }> = [];
  sessionNames: string[] = [];
  registeredTools = new Map<string, ToolDefinition<any, any>>();
  handlers = new Map<string, Array<(...args: any[]) => any>>();
  eventHandlers = new Map<string, Array<(...args: any[]) => any>>();
  events = {
    on: (eventName: string, handler: (...args: any[]) => any) => {
      const handlers = this.eventHandlers.get(eventName) ?? [];
      handlers.push(handler);
      this.eventHandlers.set(eventName, handlers);

      return () => {
        const currentHandlers = this.eventHandlers.get(eventName) ?? [];
        this.eventHandlers.set(
          eventName,
          currentHandlers.filter((currentHandler) => currentHandler !== handler),
        );
      };
    },
  };

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

  sendUserMessage(content: unknown, options?: unknown): void {
    this.sentUserMessages.push({ content, options });
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

  setSessionName(name: string): void {
    this.sessionNames.push(name);
  }
}

function createFakeContext(options: {
  cwd: string;
  sessionId?: string;
  sessionFile?: string;
  entries?: Array<{ type: string; customType?: string; data?: unknown }>;
  hasUI?: boolean;
  captureTerminalInput?: (handler: (data: string) => unknown) => void;
  notify?: (message: string, level: string) => void;
  shutdown?: () => void;
}): ExtensionContext {
  const widgets = new Map<string, unknown>();
  return {
    cwd: options.cwd,
    hasUI: options.hasUI ?? true,
    ui: {
      setWidget(key: string, content: unknown) {
        widgets.set(key, content);
      },
      notify(message: string, level: string) {
        options.notify?.(message, level);
      },
      onTerminalInput(handler: (data: string) => unknown) {
        options.captureTerminalInput?.(handler);
        return handler;
      },
    },
    sessionManager: {
      getSessionId: () => options.sessionId ?? "parent-session-id",
      getSessionFile: () => options.sessionFile,
      getEntries: () => options.entries ?? [],
      getBranch: () => options.entries ?? [],
    },
    shutdown: () => {
      options.shutdown?.();
    },
  } as unknown as ExtensionContext;
}

function renderToolText(
  tool: ToolDefinition<any, any>,
  args: Record<string, unknown>,
  result: { content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean },
  expanded: boolean,
): string {
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

async function emitHandlers(
  fakePi: FakePi,
  eventName: string,
  event: unknown,
  ctx?: ExtensionContext,
): Promise<void> {
  for (const handler of fakePi.handlers.get(eventName) ?? []) {
    await handler(event, ctx);
  }
}

async function emitEventBus(fakePi: FakePi, eventName: string, event: unknown): Promise<void> {
  for (const handler of fakePi.eventHandlers.get(eventName) ?? []) {
    await handler(event);
  }
}

timedTest("resolveModeTools inherits parent tools and denies subagent", () => {
  const resolved = resolveModeTools(
    undefined,
    ["read", "bash", "subagent", "session_query"],
    ["read", "bash", "subagent", "session_query"],
  );
  assert.deepEqual(resolved, ["bash", "read", "session_query"]);
});

timedTest("resolveModeTools supports explicit allow and deny rules", () => {
  const resolved = resolveModeTools(
    ["*", "!bash", "session_query"],
    ["read", "bash", "subagent"],
    ["read", "bash", "subagent", "session_query"],
  );
  assert.deepEqual(resolved, ["read", "session_query"]);
});

timedTest("resolveSubagentMode loads mode config from the child cwd", async () => {
  const parentCwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-parent-"));
  const childCwd = path.join(parentCwd, "child");
  await fs.mkdir(path.join(childCwd, ".pi"), { recursive: true });
  await fs.writeFile(
    path.join(childCwd, ".pi", "modes.json"),
    `${JSON.stringify(
      {
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
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

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

timedTest(
  "resolveSubagentMode expands file system prompts relative to the defining modes file",
  async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-global-"));
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-global-config-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

    process.env.PI_CODING_AGENT_DIR = agentDir;
    await fs.mkdir(path.join(agentDir, "prompts"), { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "prompts", "review.md"),
      "Review only\nEscalate blockers\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(agentDir, "modes.json"),
      `${JSON.stringify(
        {
          version: 1,
          modes: {
            reviewer: {
              provider: "mode-provider",
              modelId: "review-model",
              systemPrompt: "{file:./prompts/review.md}",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    try {
      const mode = await resolveSubagentMode(
        new FakePi() as unknown as ExtensionAPI,
        createFakeContext({ cwd }),
        { mode: "reviewer" },
      );

      assert.ok(mode.value);
      assert.equal(mode.value?.systemPrompt, "Review only\nEscalate blockers\n");
      assert.equal(mode.value?.systemPromptMode, "append");
    } finally {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest(
  "resolveSubagentMode defaults and preserves subagent auto-exit idle timeout",
  async () => {
    const parentCwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-timeout-parent-"));
    const childCwd = path.join(parentCwd, "child");
    await fs.mkdir(path.join(childCwd, ".pi"), { recursive: true });
    await fs.writeFile(
      path.join(childCwd, ".pi", "modes.json"),
      `${JSON.stringify(
        {
          version: 1,
          modes: {
            reviewer: {
              tools: ["read"],
              autoExit: true,
              autoExitTimeoutMs: 45_000,
            },
            manual: {
              tools: ["read"],
              autoExit: false,
              autoExitTimeoutMs: 12_000,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    try {
      const defaultWorker = await resolveSubagentMode(
        new FakePi() as unknown as ExtensionAPI,
        createFakeContext({ cwd: parentCwd }),
        {},
      );
      const configured = await resolveSubagentMode(
        new FakePi() as unknown as ExtensionAPI,
        createFakeContext({ cwd: parentCwd }),
        { mode: "reviewer", cwd: childCwd },
      );
      const disabled = await resolveSubagentMode(
        new FakePi() as unknown as ExtensionAPI,
        createFakeContext({ cwd: parentCwd }),
        { mode: "manual", cwd: childCwd },
      );

      assert.ok(defaultWorker.value);
      assert.equal(defaultWorker.value?.autoExit, true);
      assert.equal(defaultWorker.value?.autoExitTimeoutMs, 30_000);

      assert.ok(configured.value);
      assert.equal(configured.value?.autoExit, true);
      assert.equal(configured.value?.autoExitTimeoutMs, 45_000);

      assert.ok(disabled.value);
      assert.equal(disabled.value?.autoExit, false);
      assert.equal(disabled.value?.autoExitTimeoutMs, undefined);
    } finally {
      await fs.rm(parentCwd, { recursive: true, force: true });
    }
  },
);

timedTest(
  "child bootstrap names child sessions with subagent name plus normalized prompt",
  async () => {
    const previousChildState = process.env.PI_SUBAGENT_CHILD_STATE;
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-child-name-"));
    const sessionPath = path.join(cwd, "child.jsonl");

    process.env.PI_SUBAGENT_CHILD_STATE = JSON.stringify({
      sessionId: "child-session-id",
      sessionPath,
      parentSessionId: "parent-session-id",
      parentSessionPath: path.join(cwd, "parent.jsonl"),
      name: "worker-one",
      prompt: "Continue the review\n\tInspect failing tests\u0007 and summarize root cause",
      autoExit: true,
      autoExitTimeoutMs: 30_000,
      handoff: false,
      tools: ["read"],
      startedAt: Date.now(),
    });

    try {
      const fakePi = new FakePi();
      createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(
        fakePi as unknown as ExtensionAPI,
      );
      const ctx = createFakeContext({
        cwd,
        sessionId: "child-session-id",
        sessionFile: sessionPath,
      });

      await emitHandlers(fakePi, "session_start", { reason: "resume" }, ctx);

      assert.equal(
        fakePi.sessionNames.at(-1),
        "[worker-one] Continue the review Inspect failing tests and summarize root cause",
      );
    } finally {
      if (previousChildState === undefined) {
        delete process.env.PI_SUBAGENT_CHILD_STATE;
      } else {
        process.env.PI_SUBAGENT_CHILD_STATE = previousChildState;
      }
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest("child bootstrap installs when subagent extension is disabled", async () => {
  const previousChildState = process.env.PI_SUBAGENT_CHILD_STATE;
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-child-wrapper-"));
  const sessionPath = path.join(cwd, "child.jsonl");

  process.env.PI_SUBAGENT_CHILD_STATE = JSON.stringify({
    sessionId: "child-session-id",
    sessionPath,
    parentSessionId: "parent-session-id",
    parentSessionPath: path.join(cwd, "parent.jsonl"),
    name: "worker-one",
    prompt: "Return structured output",
    autoExit: true,
    autoExitTimeoutMs: 30_000,
    handoff: false,
    tools: ["read", "bash"],
    outputFormat: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
      retryCount: 3,
    },
    startedAt: Date.now(),
  });

  try {
    const fakePi = new FakePi();
    createSubagentExtension({ enabled: false })(fakePi as unknown as ExtensionAPI);

    assert.ok(fakePi.registeredTools.has("StructuredOutput"));
    assert.equal(fakePi.registeredTools.has("subagent"), false);
    assert.ok((fakePi.handlers.get("agent_end") ?? []).length > 0);
  } finally {
    if (previousChildState === undefined) {
      delete process.env.PI_SUBAGENT_CHILD_STATE;
    } else {
      process.env.PI_SUBAGENT_CHILD_STATE = previousChildState;
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

timedTest(
  "child bootstrap auto-exits immediately on idle with no manual terminal input",
  async () => {
    const previousChildState = process.env.PI_SUBAGENT_CHILD_STATE;
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-child-auto-exit-"));
    const sessionPath = path.join(cwd, "child.jsonl");
    let shutdownCount = 0;
    const notifications: Array<{ message: string; level: string }> = [];

    await fs.rm(getAutoExitTimeoutModeMarkerPath("child-session-id"), { force: true });

    process.env.PI_SUBAGENT_CHILD_STATE = JSON.stringify({
      sessionId: "child-session-id",
      sessionPath,
      parentSessionId: "parent-session-id",
      parentSessionPath: path.join(cwd, "parent.jsonl"),
      name: "worker-one",
      prompt: "Inspect failing tests",
      autoExit: true,
      autoExitTimeoutMs: 25,
      handoff: false,
      tools: ["read"],
      startedAt: Date.now(),
    });

    try {
      const fakePi = new FakePi();
      createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(
        fakePi as unknown as ExtensionAPI,
      );
      const ctx = createFakeContext({
        cwd,
        sessionId: "child-session-id",
        sessionFile: sessionPath,
        notify: (message, level) => {
          notifications.push({ message, level });
        },
        shutdown: () => {
          shutdownCount += 1;
        },
      });

      await emitHandlers(fakePi, "session_start", { reason: "startup" }, ctx);

      await emitHandlers(fakePi, "agent_end", {}, ctx);
      assert.equal(shutdownCount, 1);
      assert.deepEqual(notifications, []);
    } finally {
      if (previousChildState === undefined) {
        delete process.env.PI_SUBAGENT_CHILD_STATE;
      } else {
        process.env.PI_SUBAGENT_CHILD_STATE = previousChildState;
      }
      await fs.rm(getAutoExitTimeoutModeMarkerPath("child-session-id"), { force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest(
  "child bootstrap manual terminal input activates idle timeout mode across idle transitions",
  async () => {
    const previousChildState = process.env.PI_SUBAGENT_CHILD_STATE;
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-child-timeout-mode-"));
    const sessionPath = path.join(cwd, "child.jsonl");
    let terminalInputHandler: ((data: string) => unknown) | undefined;
    let shutdownCount = 0;

    await fs.rm(getAutoExitTimeoutModeMarkerPath("child-session-id"), { force: true });

    process.env.PI_SUBAGENT_CHILD_STATE = JSON.stringify({
      sessionId: "child-session-id",
      sessionPath,
      parentSessionId: "parent-session-id",
      parentSessionPath: path.join(cwd, "parent.jsonl"),
      name: "worker-one",
      prompt: "Inspect failing tests",
      autoExit: true,
      autoExitTimeoutMs: 25,
      handoff: false,
      tools: ["read"],
      startedAt: Date.now(),
    });

    try {
      const fakePi = new FakePi();
      createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(
        fakePi as unknown as ExtensionAPI,
      );
      const ctx = createFakeContext({
        cwd,
        sessionId: "child-session-id",
        sessionFile: sessionPath,
        captureTerminalInput: (handler) => {
          terminalInputHandler = handler;
        },
        shutdown: () => {
          shutdownCount += 1;
        },
      });

      await emitHandlers(fakePi, "session_start", { reason: "startup" }, ctx);
      terminalInputHandler?.("manual follow-up");
      assert.equal(isAutoExitTimeoutModeActive("child-session-id"), true);

      await emitHandlers(fakePi, "agent_end", {}, ctx);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(shutdownCount, 0);

      await emitHandlers(fakePi, "before_agent_start", {}, ctx);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(shutdownCount, 0);

      await emitHandlers(fakePi, "agent_end", {}, ctx);
      await new Promise((resolve) => setTimeout(resolve, 35));
      assert.equal(shutdownCount, 1);
    } finally {
      if (previousChildState === undefined) {
        delete process.env.PI_SUBAGENT_CHILD_STATE;
      } else {
        process.env.PI_SUBAGENT_CHILD_STATE = previousChildState;
      }
      await fs.rm(getAutoExitTimeoutModeMarkerPath("child-session-id"), { force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest("child bootstrap ignores parent-injected input for timeout mode activation", async () => {
  const previousChildState = process.env.PI_SUBAGENT_CHILD_STATE;
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-child-parent-input-"));
  const sessionPath = path.join(cwd, "child.jsonl");
  let terminalInputHandler: ((data: string) => unknown) | undefined;
  let shutdownCount = 0;

  await fs.rm(getParentInjectedInputMarkerPath("child-session-id"), { force: true });
  await fs.rm(getAutoExitTimeoutModeMarkerPath("child-session-id"), { force: true });

  process.env.PI_SUBAGENT_CHILD_STATE = JSON.stringify({
    sessionId: "child-session-id",
    sessionPath,
    parentSessionId: "parent-session-id",
    parentSessionPath: path.join(cwd, "parent.jsonl"),
    name: "worker-one",
    prompt: "Inspect failing tests",
    autoExit: true,
    autoExitTimeoutMs: 25,
    handoff: false,
    tools: ["read"],
    startedAt: Date.now(),
  });

  try {
    const fakePi = new FakePi();
    createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(
      fakePi as unknown as ExtensionAPI,
    );
    const ctx = createFakeContext({
      cwd,
      sessionId: "child-session-id",
      sessionFile: sessionPath,
      captureTerminalInput: (handler) => {
        terminalInputHandler = handler;
      },
      shutdown: () => {
        shutdownCount += 1;
      },
    });

    await emitHandlers(fakePi, "session_start", { reason: "startup" }, ctx);
    await fs.mkdir(path.dirname(getParentInjectedInputMarkerPath("child-session-id")), {
      recursive: true,
    });
    await fs.writeFile(
      getParentInjectedInputMarkerPath("child-session-id"),
      JSON.stringify({ expiresAt: Date.now() + 1_500 }),
      "utf8",
    );

    terminalInputHandler?.("parent follow-up");
    assert.equal(isAutoExitTimeoutModeActive("child-session-id"), false);

    await emitHandlers(fakePi, "agent_end", {}, ctx);
    assert.equal(shutdownCount, 1);
  } finally {
    if (previousChildState === undefined) {
      delete process.env.PI_SUBAGENT_CHILD_STATE;
    } else {
      process.env.PI_SUBAGENT_CHILD_STATE = previousChildState;
    }
    await fs.rm(getParentInjectedInputMarkerPath("child-session-id"), { force: true });
    await fs.rm(getAutoExitTimeoutModeMarkerPath("child-session-id"), { force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

timedTest("child bootstrap rejects structured output mixed with other tool calls", async () => {
  const previousChildState = process.env.PI_SUBAGENT_CHILD_STATE;
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-child-final-tool-"));
  const sessionPath = path.join(cwd, "child.jsonl");
  let shutdownCount = 0;

  process.env.PI_SUBAGENT_CHILD_STATE = JSON.stringify({
    sessionId: "child-session-id",
    sessionPath,
    parentSessionId: "parent-session-id",
    parentSessionPath: path.join(cwd, "parent.jsonl"),
    name: "worker-one",
    prompt: "Return structured output",
    autoExit: true,
    autoExitTimeoutMs: 30_000,
    handoff: false,
    tools: ["read", "bash"],
    outputFormat: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
      retryCount: 0,
    },
    startedAt: Date.now(),
  });

  try {
    const fakePi = new FakePi();
    createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(
      fakePi as unknown as ExtensionAPI,
    );
    const ctx = createFakeContext({
      cwd,
      sessionId: "child-session-id",
      sessionFile: sessionPath,
      shutdown: () => {
        shutdownCount += 1;
      },
    });

    await emitHandlers(
      fakePi,
      "before_agent_start",
      { systemPrompt: "system", prompt: "task" },
      ctx,
    );
    await emitHandlers(fakePi, "turn_start", { turnIndex: 1, timestamp: Date.now() }, ctx);

    const structuredOutputTool = fakePi.registeredTools.get("StructuredOutput");
    assert.ok(structuredOutputTool);
    await structuredOutputTool.execute(
      "structured-tool-call",
      { answer: "done" },
      undefined,
      undefined,
      ctx,
    );

    await emitHandlers(
      fakePi,
      "turn_end",
      {
        turnIndex: 1,
        message: { role: "assistant", content: [], timestamp: Date.now() },
        toolResults: [
          {
            role: "toolResult",
            toolCallId: "structured-tool-call",
            toolName: "StructuredOutput",
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: Date.now(),
          },
          {
            role: "toolResult",
            toolCallId: "bash-tool-call",
            toolName: "bash",
            content: [{ type: "text", text: "ran" }],
            isError: false,
            timestamp: Date.now(),
          },
        ],
      },
      ctx,
    );

    await emitHandlers(fakePi, "agent_end", { messages: [] }, ctx);

    const structuredEntries = fakePi.appendedEntries.filter(
      (entry) => entry.customType === SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
    );
    assert.equal(structuredEntries.length, 1);
    const structuredEntry = structuredEntries[0];
    assert.ok(structuredEntry);
    assert.equal((structuredEntry.data as { status: string }).status, "error");
    assert.equal(
      (structuredEntry.data as { error?: { code?: string } }).error?.code,
      "validation_failed",
    );
    assert.equal(shutdownCount, 1);
  } finally {
    if (previousChildState === undefined) {
      delete process.env.PI_SUBAGENT_CHILD_STATE;
    } else {
      process.env.PI_SUBAGENT_CHILD_STATE = previousChildState;
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

timedTest("child bootstrap treats retryCount as total allowed turns", async () => {
  const previousChildState = process.env.PI_SUBAGENT_CHILD_STATE;
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-child-retry-budget-"));
  const sessionPath = path.join(cwd, "child.jsonl");

  process.env.PI_SUBAGENT_CHILD_STATE = JSON.stringify({
    sessionId: "child-session-id",
    sessionPath,
    parentSessionId: "parent-session-id",
    parentSessionPath: path.join(cwd, "parent.jsonl"),
    name: "worker-one",
    prompt: "Return structured output",
    autoExit: true,
    autoExitTimeoutMs: 30_000,
    handoff: false,
    tools: ["read"],
    outputFormat: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
      retryCount: 3,
    },
    startedAt: Date.now(),
  });

  try {
    const fakePi = new FakePi();
    createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(
      fakePi as unknown as ExtensionAPI,
    );
    const ctx = createFakeContext({
      cwd,
      sessionId: "child-session-id",
      sessionFile: sessionPath,
    });

    for (let run = 0; run < 3; run += 1) {
      await emitHandlers(
        fakePi,
        "before_agent_start",
        { systemPrompt: "system", prompt: `task-${run}` },
        ctx,
      );
      await emitHandlers(fakePi, "turn_start", { turnIndex: 1, timestamp: Date.now() }, ctx);
      await emitHandlers(
        fakePi,
        "turn_end",
        {
          turnIndex: 1,
          message: { role: "assistant", content: [], timestamp: Date.now() },
          toolResults: [],
        },
        ctx,
      );
      await emitHandlers(fakePi, "agent_end", { messages: [] }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const structuredEntries = fakePi.appendedEntries
      .filter((entry) => entry.customType === SUBAGENT_STRUCTURED_OUTPUT_ENTRY)
      .map((entry) => entry.data as { status: string; attempts: number });

    assert.deepEqual(
      structuredEntries.map((entry) => entry.status),
      ["retrying", "retrying", "error"],
    );
    assert.deepEqual(
      structuredEntries.map((entry) => entry.attempts),
      [1, 2, 3],
    );
    assert.equal(fakePi.sentUserMessages.length, 2);
  } finally {
    if (previousChildState === undefined) {
      delete process.env.PI_SUBAGENT_CHILD_STATE;
    } else {
      process.env.PI_SUBAGENT_CHILD_STATE = previousChildState;
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

timedTest("child bootstrap resumes structured retry counters from persisted state", async () => {
  const previousChildState = process.env.PI_SUBAGENT_CHILD_STATE;
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-child-retry-resume-"));
  const sessionPath = path.join(cwd, "child.jsonl");

  await fs.writeFile(
    sessionPath,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "child-session-id",
        timestamp: new Date().toISOString(),
        cwd,
      }),
      JSON.stringify({
        type: "custom",
        id: "structured-retrying-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
        data: {
          status: "retrying",
          attempts: 2,
          retryCount: 3,
          updatedAt: Date.now(),
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  process.env.PI_SUBAGENT_CHILD_STATE = JSON.stringify({
    sessionId: "child-session-id",
    sessionPath,
    parentSessionId: "parent-session-id",
    parentSessionPath: path.join(cwd, "parent.jsonl"),
    name: "worker-one",
    prompt: "Return structured output",
    autoExit: true,
    autoExitTimeoutMs: 30_000,
    handoff: false,
    tools: ["read"],
    outputFormat: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
      retryCount: 3,
    },
    startedAt: Date.now(),
  });

  try {
    const fakePi = new FakePi();
    createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(
      fakePi as unknown as ExtensionAPI,
    );
    const ctx = createFakeContext({
      cwd,
      sessionId: "child-session-id",
      sessionFile: sessionPath,
    });

    await emitHandlers(
      fakePi,
      "before_agent_start",
      { systemPrompt: "system", prompt: "task" },
      ctx,
    );
    await emitHandlers(fakePi, "turn_start", { turnIndex: 1, timestamp: Date.now() }, ctx);
    await emitHandlers(
      fakePi,
      "turn_end",
      {
        turnIndex: 1,
        message: { role: "assistant", content: [], timestamp: Date.now() },
        toolResults: [],
      },
      ctx,
    );
    await emitHandlers(fakePi, "agent_end", { messages: [] }, ctx);

    const structuredEntries = fakePi.appendedEntries
      .filter((entry) => entry.customType === SUBAGENT_STRUCTURED_OUTPUT_ENTRY)
      .map((entry) => entry.data as { status: string; attempts: number });

    assert.deepEqual(
      structuredEntries.map((entry) => entry.status),
      ["error"],
    );
    assert.deepEqual(
      structuredEntries.map((entry) => entry.attempts),
      [3],
    );
    assert.equal(fakePi.sentUserMessages.length, 0);
  } finally {
    if (previousChildState === undefined) {
      delete process.env.PI_SUBAGENT_CHILD_STATE;
    } else {
      process.env.PI_SUBAGENT_CHILD_STATE = previousChildState;
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

timedTest("subagent widget shows idle auto-exit countdown only while idle", () => {
  const now = Date.now();
  const widgetState: RuntimeSubagent = {
    event: "restored",
    sessionId: "12345678-1234-1234-1234-123456789abc",
    sessionPath: "/tmp/subagent.jsonl",
    parentSessionId: "parent-session-id",
    parentSessionPath: "/tmp/parent.jsonl",
    name: "worker-one",
    mode: "reviewer",
    modeLabel: "reviewer",
    cwd: "/tmp/project",
    paneId: "%5",
    task: "Inspect failing tests",
    handoff: false,
    autoExit: true,
    autoExitTimeoutMs: 90_000,
    autoExitTimeoutActive: true,
    autoExitDeadlineAt: now + 90_000,
    status: "idle",
    startedAt: 1,
    updatedAt: 2,
  };

  const idleWidget = renderSubagentWidget([widgetState]);
  assert.ok(idleWidget);
  assert.match(idleWidget.join("\n"), /auto-exit/);
  assert.match(idleWidget.join("\n"), /1m 30s|1m 29s/);

  const runningWidget = renderSubagentWidget([
    { ...widgetState, status: "running", autoExitDeadlineAt: undefined },
  ]);
  assert.ok(runningWidget);
  assert.doesNotMatch(runningWidget.join("\n"), /auto-exit/);

  const idleImmediateExitWidget = renderSubagentWidget([
    { ...widgetState, autoExitTimeoutActive: false, autoExitDeadlineAt: undefined },
  ]);
  assert.ok(idleImmediateExitWidget);
  assert.doesNotMatch(idleImmediateExitWidget.join("\n"), /auto-exit/);
});

timedTest("subagent manager arms idle countdown only after timeout mode activates", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-manager-timeout-mode-"));
  const sessionPath = path.join(dir, "idle.jsonl");
  const sessionId = "child-session-id";
  const idleAt = new Date().toISOString();

  await fs.writeFile(
    sessionPath,
    [
      JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: idleAt, cwd: dir }),
      JSON.stringify({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: idleAt,
        message: { role: "user", content: [{ type: "text", text: "Do work" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: idleAt,
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Done" }],
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  try {
    const runtime = new SubagentRuntime(
      new FakePi() as unknown as ExtensionAPI,
      new FakeMuxAdapter(),
      () => "",
    );

    const baseState: RuntimeSubagent = {
      event: "updated",
      sessionId,
      sessionPath,
      parentSessionId: "parent-session-id",
      parentSessionPath: path.join(dir, "parent.jsonl"),
      name: "worker-one",
      mode: "reviewer",
      modeLabel: "reviewer",
      cwd: dir,
      paneId: "%5",
      task: "Inspect failing tests",
      handoff: false,
      autoExit: true,
      autoExitTimeoutMs: 90_000,
      autoExitTimeoutActive: false,
      status: "running",
      startedAt: 1,
      updatedAt: 2,
    };

    const immediateExitState = (await (runtime as any).syncLiveState(
      baseState,
      "updated",
    )) as RuntimeSubagent;
    assert.equal(immediateExitState.status, "idle");
    assert.equal(immediateExitState.autoExitTimeoutActive, false);
    assert.equal(immediateExitState.autoExitDeadlineAt, undefined);

    activateAutoExitTimeoutMode(sessionId);

    const delayedExitState = (await (runtime as any).syncLiveState(
      baseState,
      "updated",
    )) as RuntimeSubagent;
    assert.equal(delayedExitState.status, "idle");
    assert.equal(delayedExitState.autoExitTimeoutActive, true);
    assert.equal(delayedExitState.autoExitDeadlineAt, Date.parse(idleAt) + 90_000);
  } finally {
    await fs.rm(getAutoExitTimeoutModeMarkerPath(sessionId), { force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

timedTest("TmuxAdapter creates a new tmux window when requested", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const adapter = new TmuxAdapter(async (command, args) => {
    calls.push({ command, args });
    if (args[0] === "new-window") {
      return { code: 0, stdout: "%7\n", stderr: "" };
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
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      [
        "new-window",
        "-d",
        "-c",
        "/tmp/project",
        "-n",
        "worker-window",
        "-P",
        "-F",
        "#{pane_id}",
        "pi --session fake",
      ],
      ["select-pane", "-t", "%7", "-T", "worker-window"],
    ],
  );
});

timedTest("subagent tool metadata explains tmux inspection and wait-for-summary flow", () => {
  const fakePi = new FakePi();
  createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(
    fakePi as unknown as ExtensionAPI,
  );
  const tool = fakePi.registeredTools.get("subagent");
  assert.ok(tool);

  assert.match(tool.description, /no subagent read action/i);
  assert.match(tool.description, /wait for the automatic completion summary/i);
  assert.match(tool.promptSnippet ?? "", /no subagent read action/i);
  assert.match(tool.promptSnippet ?? "", /automatic completion summary/i);
  assert.ok(
    tool.promptGuidelines?.some((guideline) =>
      /tmux pane\/window output directly/i.test(guideline),
    ),
  );
  assert.ok(
    tool.promptGuidelines?.some((guideline) =>
      /do not poll with `list` just to get the final result/i.test(guideline),
    ),
  );

  const parameterDescriptions =
    (tool.parameters as { properties?: Record<string, { description?: string }> }).properties ?? {};
  assert.match(parameterDescriptions.action?.description ?? "", /no subagent read action/i);
  assert.match(parameterDescriptions.name?.description ?? "", /title shown immediately on launch/i);
  assert.match(
    parameterDescriptions.task?.description ?? "",
    /inspect tmux pane\/window output directly/i,
  );
  assert.match(parameterDescriptions.sessionId?.description ?? "", /UUID v4/i);
  assert.match(
    parameterDescriptions.message?.description ?? "",
    /inspect the reply, read the tmux output directly/i,
  );
});

timedTest(
  "subagent tool prompt guidelines include available modes xml and refresh on modes change",
  async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-modes-prompt-"));
    const fakePi = new FakePi();
    createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(
      fakePi as unknown as ExtensionAPI,
    );

    try {
      await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, ".pi", "modes.json"),
        `${JSON.stringify(
          {
            version: 1,
            modes: {
              review: {
                provider: "mode-provider",
                modelId: "review-model",
                thinkingLevel: "high",
                description: "Review & verify",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const ctx = createFakeContext({
        cwd,
        sessionId: "parent-session-id",
        sessionFile: path.join(cwd, "parent.jsonl"),
      });

      await emitHandlers(fakePi, "session_start", { reason: "new" }, ctx);

      const initialTool = fakePi.registeredTools.get("subagent");
      assert.ok(initialTool);
      assert.ok(
        initialTool.promptGuidelines?.some((guideline) =>
          /Available subagent modes/i.test(guideline),
        ),
      );
      assert.ok(
        initialTool.promptGuidelines?.some((guideline) => /<available_modes>/i.test(guideline)),
      );
      assert.ok(
        initialTool.promptGuidelines?.some((guideline) =>
          /description="Review &amp; verify"/i.test(guideline),
        ),
      );

      await fs.writeFile(
        path.join(cwd, ".pi", "modes.json"),
        `${JSON.stringify(
          {
            version: 1,
            modes: {
              review: {
                provider: "mode-provider",
                modelId: "review-model",
                thinkingLevel: "high",
                description: "Review & verify",
              },
              docs: {
                provider: "mode-provider",
                modelId: "docs-model",
                thinkingLevel: "low",
                description: "Fast <writing>",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await emitEventBus(fakePi, "modes:changed", undefined);

      const updatedTool = fakePi.registeredTools.get("subagent");
      assert.ok(updatedTool);
      assert.ok(
        updatedTool.promptGuidelines?.some((guideline) =>
          /<mode name="docs" model="mode-provider\/docs-model" thinkingLevel="low" description="Fast &lt;writing&gt;" \/>/i.test(
            guideline,
          ),
        ),
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest("formatAvailableModesXml sorts unsorted modes deterministically", () => {
  const xml = formatAvailableModesXml([
    {
      name: "zeta",
      spec: {
        description: "Last",
      },
    },
    {
      name: "alpha",
      spec: {
        provider: "mode-provider",
        modelId: "alpha-model",
      },
    },
    {
      name: "middle",
      spec: {
        thinkingLevel: "low",
        description: 'Fast <focused> & "safe"',
      },
    },
  ]);

  assert.equal(
    xml,
    [
      "<available_modes>",
      '  <mode name="alpha" model="mode-provider/alpha-model" />',
      '  <mode name="middle" thinkingLevel="low" description="Fast &lt;focused&gt; &amp; &quot;safe&quot;" />',
      '  <mode name="zeta" description="Last" />',
      "</available_modes>",
    ].join("\n"),
  );
});

timedTest(
  "subagent available modes prompt signature stays stable across input reordering",
  async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-modes-signature-"));
    const fakePi = new FakePi();
    createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(
      fakePi as unknown as ExtensionAPI,
    );

    try {
      await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, ".pi", "modes.json"),
        `${JSON.stringify(
          {
            version: 1,
            modes: {
              bravo: {
                provider: "mode-provider",
                modelId: "bravo-model",
              },
              alpha: {
                provider: "mode-provider",
                modelId: "alpha-model",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const ctx = createFakeContext({
        cwd,
        sessionId: "parent-session-id",
        sessionFile: path.join(cwd, "parent.jsonl"),
      });

      await emitHandlers(fakePi, "session_start", { reason: "new" }, ctx);

      const initialTool = fakePi.registeredTools.get("subagent");
      assert.ok(initialTool);
      const initialPrompt = initialTool.promptGuidelines?.join("\n\n") ?? "";

      await fs.writeFile(
        path.join(cwd, ".pi", "modes.json"),
        `${JSON.stringify(
          {
            version: 1,
            modes: {
              alpha: {
                provider: "mode-provider",
                modelId: "alpha-model",
              },
              bravo: {
                provider: "mode-provider",
                modelId: "bravo-model",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await emitEventBus(fakePi, "modes:changed", undefined);

      const updatedTool = fakePi.registeredTools.get("subagent");
      assert.ok(updatedTool);
      const updatedPrompt = updatedTool.promptGuidelines?.join("\n\n") ?? "";
      assert.equal(updatedPrompt, initialPrompt);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest("reduceRuntimeSubagents keeps latest state for the current parent session", () => {
  const states = reduceRuntimeSubagents(
    [
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
    ],
    "parent-a",
  );

  assert.equal(states.size, 1);
  assert.equal(states.get("child-1")?.status, "completed");
});

timedTest("reduceRuntimeSubagents ignores malformed and unexpected state entries", () => {
  const states = reduceRuntimeSubagents(
    [
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
    ],
    "parent-a",
  );

  assert.equal(states.size, 1);
  assert.deepEqual(Array.from(states.keys()), ["child-valid"]);
});

timedTest("cloneRuntimeSubagent deep-clones nested structured fields", () => {
  const original: RuntimeSubagent = {
    event: "started",
    sessionId: "child-1",
    sessionPath: "/tmp/child-1.jsonl",
    parentSessionId: "parent-1",
    parentSessionPath: "/tmp/parent-1.jsonl",
    name: "worker-one",
    mode: "worker",
    modeLabel: "worker",
    cwd: "/tmp/project",
    paneId: "%1",
    task: "task",
    handoff: false,
    autoExit: true,
    status: "running",
    outputFormat: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: { result: { type: "string" } },
      },
      retryCount: 3,
    },
    structured: { result: "ok" },
    structuredError: {
      code: "validation_failed",
      message: "error",
      retryCount: 3,
      attempts: 1,
      lastValidationError: "bad",
    },
    startedAt: 1,
    updatedAt: 2,
  };

  const cloned = cloneRuntimeSubagent(original);
  (cloned.structured as { result: string }).result = "mutated";
  (
    cloned.outputFormat as { schema: { properties: { result: { type: string } } } }
  ).schema.properties.result.type = "number";
  (cloned.structuredError as { message: string }).message = "mutated error";

  assert.equal((original.structured as { result: string }).result, "ok");
  assert.equal(
    (original.outputFormat as { schema: { properties: { result: { type: string } } } }).schema
      .properties.result.type,
    "string",
  );
  assert.equal((original.structuredError as { message: string }).message, "error");
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
  await fs.writeFile(
    sessionPath,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "child",
        timestamp: new Date().toISOString(),
        cwd: dir,
      }),
      JSON.stringify({
        type: "message",
        id: "a",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Finished successfully" }],
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

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

  await fs.writeFile(
    idlePath,
    [
      JSON.stringify({ type: "session", version: 3, id: "idle", timestamp, cwd: dir }),
      JSON.stringify({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp,
        message: { role: "user", content: [{ type: "text", text: "Do work" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp,
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Done" }],
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  await fs.writeFile(
    runningPath,
    [
      JSON.stringify({ type: "session", version: 3, id: "running", timestamp, cwd: dir }),
      JSON.stringify({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp,
        message: { role: "user", content: [{ type: "text", text: "Still working" }] },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  try {
    assert.equal(await readChildSessionStatus(idlePath), "idle");
    assert.equal(await readChildSessionStatus(runningPath), "running");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

timedTest("subagent tool renders compact collapsed success and expanded metadata", () => {
  const fakePi = new FakePi();
  createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(
    fakePi as unknown as ExtensionAPI,
  );
  const tool = fakePi.registeredTools.get("subagent");
  assert.ok(tool);

  const task = "Continue the review\nInspect failing tests";

  const state: RuntimeSubagent = {
    event: "started",
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

  const collapsed = renderToolText(
    tool,
    {
      action: "start",
      name: state.name,
      mode: state.mode,
      task: state.task,
    },
    {
      content: [{ type: "text", text: "ok" }],
      details: {
        action: "start",
        args: { action: "start", name: state.name, mode: state.mode, task: state.task },
        prompt: state.task,
        state,
      },
      isError: false,
    },
    false,
  );
  const expanded = renderToolText(
    tool,
    {
      action: "start",
      name: state.name,
      mode: state.mode,
      task: state.task,
    },
    {
      content: [{ type: "text", text: "ok" }],
      details: {
        action: "start",
        args: { action: "start", name: state.name, mode: state.mode, task: state.task },
        prompt: state.task,
        state,
      },
      isError: false,
    },
    true,
  );

  const collapsedLines = collapsed.split("\n").filter((line) => line.trim().length > 0);
  assert.equal(collapsedLines.length, 1);
  assert.match(
    collapsed,
    /π start · worker-one · reviewer · Continue the review Inspect failing tests · worker-one · idle/,
  );
  assert.doesNotMatch(collapsed, /sessionPath:/);
  assert.doesNotMatch(collapsed, /paneId:/);
  assert.doesNotMatch(collapsed, /prompt:/);
  assert.match(expanded, /π start/);
  assert.match(expanded, /name: worker-one/);
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
  createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(
    fakePi as unknown as ExtensionAPI,
  );
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

  const listCollapsed = renderToolText(
    tool,
    {
      action: "list",
    },
    {
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
    },
    false,
  );

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

  const cancelCollapsed = renderToolText(
    tool,
    {
      action: "cancel",
      sessionId: cancelledState.sessionId,
    },
    {
      content: [{ type: "text", text: "ok" }],
      details: {
        action: "cancel",
        args: { action: "cancel", sessionId: cancelledState.sessionId },
        state: cancelledState,
      },
      isError: false,
    },
    false,
  );

  assert.match(cancelCollapsed, /π cancel · cancelle · worker-stop · cancelled/);
});

timedTest("subagent tool execute preserves prompt and expanded start details", async () => {
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
    assert.match(
      started.content[0]?.text ?? "",
      /will return with a summary automatically when it finishes/i,
    );
    assert.match(started.content[0]?.text ?? "", /Use subagent message only to steer the work/i);
    const startedDetails = started.details as { prompt: string; state: RuntimeSubagent };
    assert.match(
      started.content[0]?.text ?? "",
      new RegExp(`sessionId: ${startedDetails.state.sessionId}`),
    );
    assert.equal(startedDetails.state.task, startTask);
    assert.match(started.content[0]?.text ?? "", /subagent cancel to stop it/i);

    const listed = await tool.execute(
      "tool-call-list",
      { action: "list" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(listed.content[0]?.text ?? "", /count: 1/);
    assert.match(
      listed.content[0]?.text ?? "",
      new RegExp(`sessionId: ${startedDetails.state.sessionId}`),
    );

    const expanded = renderToolText(
      tool,
      { action: "start", name: "worker-one", mode: "worker", task: startTask },
      {
        content: started.content as Array<{ type: "text"; text: string }>,
        details: started.details,
        isError: false,
      },
      true,
    );

    assert.match(expanded, /sessionId: /);
    assert.match(expanded, /prompt:/);
    assert.match(expanded, /promptGuidance:/);
    assert.match(expanded, /will return with a summary automatically when it finishes/i);
    assert.match(expanded, /Inspect the failing tests/);
    assert.match(expanded, /sessionPath: /);
  } finally {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

timedTest(
  "subagent tool execute returns structured JSON in content for structured start",
  async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "agent-subagent-tool-structured-dir-"),
    );
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-tool-structured-cwd-"));
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

      const startedPromise = tool.execute(
        "tool-call-start-structured",
        {
          action: "start",
          name: "worker-one",
          task: "Return structured output",
          outputFormat: {
            type: "json_schema",
            schema: Type.Object({
              summary: Type.String(),
              risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
            }),
          },
        },
        undefined,
        undefined,
        ctx,
      );

      let sessionPath: string | undefined;
      let paneId: string | undefined;
      const startTimeoutAt = Date.now() + 4_000;
      while (Date.now() < startTimeoutAt) {
        const stateEntry = fakePi.appendedEntries.find(
          (entry) => entry.customType === SUBAGENT_STATE_ENTRY,
        );
        if (stateEntry) {
          const stateData = stateEntry.data as { sessionPath?: string; paneId?: string };
          sessionPath = stateData.sessionPath;
          paneId = stateData.paneId;
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      assert.ok(sessionPath);
      assert.ok(paneId);

      const timestamp = new Date().toISOString();
      await fs.appendFile(
        sessionPath,
        [
          JSON.stringify({
            type: "message",
            id: "u1",
            parentId: null,
            timestamp,
            message: { role: "user", content: [{ type: "text", text: "Do work" }] },
          }),
          JSON.stringify({
            type: "message",
            id: "a1",
            parentId: "u1",
            timestamp,
            message: {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "Done" }],
            },
          }),
          JSON.stringify({
            type: "custom",
            id: "c1",
            parentId: "a1",
            timestamp,
            customType: SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
            data: {
              status: "captured",
              attempts: 1,
              retryCount: 3,
              structured: { summary: "All clear", risk: "low" },
              updatedAt: Date.now(),
            },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      fakeMux.existingPanes.delete(paneId);

      const started = await startedPromise;
      assert.equal(started.content.length, 1);
      assert.deepEqual(JSON.parse(started.content[0]?.text ?? "{}"), {
        summary: "All clear",
        risk: "low",
      });
    } finally {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest("subagent tool surfaces invalid params with actionable guidance", async () => {
  const fakePi = new FakePi();
  createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(
    fakePi as unknown as ExtensionAPI,
  );
  const tool = fakePi.registeredTools.get("subagent");
  assert.ok(tool);

  await assert.rejects(
    () =>
      tool.execute(
        "tool-call-invalid-start",
        { action: "start", name: "worker-one" },
        undefined,
        undefined,
        createFakeContext({ cwd: process.cwd() }),
      ),
    /Invalid subagent start params: `task` is required.*There is no subagent read action later/i,
  );

  await assert.rejects(
    () =>
      tool.execute(
        "tool-call-invalid-message",
        { action: "message", sessionId: "child-1" },
        undefined,
        undefined,
        createFakeContext({ cwd: process.cwd() }),
      ),
    /Invalid subagent message params: `message` is required/i,
  );
});

timedTest(
  "SubagentRuntime spawn, resume, message, cancel, and restore cover the lifecycle",
  async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-dir-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-cwd-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const fakePi = new FakePi();
    const fakeMux = new FakeMuxAdapter();
    const launched: Array<{
      state: RuntimeSubagent;
      childState: unknown;
      prompt: string;
      options: unknown;
    }> = [];
    const runtime = new SubagentRuntime(
      fakePi as unknown as ExtensionAPI,
      fakeMux,
      (state, childState, prompt, options) => {
        launched.push({ state, childState, prompt, options });
        return "pi --session fake";
      },
    );

    try {
      await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, ".pi", "modes.json"),
        `${JSON.stringify(
          {
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
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const ctx = createFakeContext({
        cwd,
        sessionFile: path.join(cwd, "parent.jsonl"),
      });

      const started = await runtime.spawn(
        {
          name: "worker-one",
          task: "Inspect the failing tests",
          mode: "reviewer",
        },
        ctx,
      );
      assert.equal(started.state.status, "running");
      assert.equal(fakeMux.created.length, 1);
      assert.equal(fakeMux.created[0]?.target, "window");
      assert.equal(launched.length, 1);
      const launch = launched[0]!;
      assert.equal(launch.prompt, "Inspect the failing tests");
      assert.equal(fakeMux.sent.length, 0);
      assert.deepEqual((launch.childState as { tools: string[] }).tools, ["read"]);
      assert.equal((launch.childState as { prompt: string }).prompt, "Inspect the failing tests");
      assert.equal((launch.childState as { autoExitTimeoutMs?: number }).autoExitTimeoutMs, 30_000);
      assert.deepEqual(launch.options, {
        launchTarget: { kind: "session", sessionPath: started.state.sessionPath },
        tmuxTarget: "window",
        mode: "reviewer",
        model: "mode-provider/review-model",
        thinkingLevel: undefined,
        systemPrompt: "Review only",
        systemPromptMode: "append",
      });
      assert.equal(
        fakePi.appendedEntries.filter((entry) => entry.customType === SUBAGENT_STATE_ENTRY).length,
        1,
      );
      const persistedStartedState = fakePi.appendedEntries.find(
        (entry) => entry.customType === SUBAGENT_STATE_ENTRY,
      )?.data as Record<string, unknown> | undefined;
      assert.ok(persistedStartedState);
      assert.equal("modeLabel" in persistedStartedState, false);
      assert.equal(runtime.listStates().length, 1);

      const runtimeSnapshot = runtime.listStates()[0];
      assert.ok(runtimeSnapshot);
      runtimeSnapshot.status = "failed";
      runtimeSnapshot.paneId = "%999";
      assert.equal(runtime.listStates()[0]?.status, "running");
      assert.notEqual(runtime.listStates()[0]?.paneId, "%999");

      const delivered = await runtime.message(
        {
          sessionId: started.state.sessionId,
          message: "Focus on src/extensions first",
          delivery: "steer",
        },
        ctx,
      );
      assert.equal(delivered.state.status, "running");
      assert.equal(delivered.autoResumed, false);
      assert.equal(fakeMux.sent.length, 1);
      assert.equal(fakeMux.sent[0]?.submitMode, "steer");
      assert.equal(
        fakePi.appendedEntries.filter((entry) => entry.customType === SUBAGENT_MESSAGE_ENTRY)
          .length,
        2,
      );
      const parentInputMarker = JSON.parse(
        await fs.readFile(getParentInjectedInputMarkerPath(started.state.sessionId), "utf8"),
      ) as { expiresAt: number };
      assert.ok(parentInputMarker.expiresAt > Date.now());

      const cancelled = await runtime.cancel({ sessionId: started.state.sessionId });
      assert.equal(cancelled.status, "cancelled");
      assert.equal(fakeMux.killed.length, 1);
      assert.equal(runtime.listStates().length, 1);
      assert.equal(runtime.listStates()[0]?.status, "cancelled");
      assert.equal(fakePi.sentMessages.length, 1);

      const resumed = await runtime.resume(
        {
          sessionId: started.state.sessionId,
          task: "Address the review feedback",
          mode: "reviewer",
        },
        ctx,
      );
      assert.equal(resumed.state.status, "running");
      assert.equal(resumed.state.sessionId, started.state.sessionId);
      assert.equal(resumed.state.paneId, "%2");
      assert.equal(fakeMux.created.length, 2);
      assert.equal(fakeMux.created[1]?.target, "window");
      assert.equal(launched.length, 2);
      const resumedLaunch = launched[1];
      assert.ok(resumedLaunch);
      assert.equal(resumedLaunch.prompt, "Address the review feedback");
      assert.equal(
        (resumedLaunch.childState as { prompt: string }).prompt,
        "Address the review feedback",
      );
      assert.equal(
        (resumedLaunch.childState as { autoExitTimeoutMs?: number }).autoExitTimeoutMs,
        30_000,
      );
      assert.deepEqual(resumedLaunch.options, {
        launchTarget: { kind: "session", sessionPath: started.state.sessionPath },
        tmuxTarget: "window",
        mode: "reviewer",
        model: "mode-provider/review-model",
        thinkingLevel: undefined,
        systemPrompt: "Review only",
        systemPromptMode: "append",
      });
      fakeMux.existingPanes.delete(resumed.state.paneId);

      const deliveredAfterAutoResume = await runtime.message(
        {
          sessionId: started.state.sessionId,
          message: "Continue with the highest priority review item",
          delivery: "followUp",
        },
        ctx,
      );
      assert.equal(deliveredAfterAutoResume.autoResumed, true);
      assert.equal(deliveredAfterAutoResume.resumePrompt, "Address the review feedback");
      assert.equal(deliveredAfterAutoResume.state.status, "running");
      assert.equal(deliveredAfterAutoResume.state.paneId, "%3");
      assert.equal(fakeMux.created.length, 3);
      assert.equal(fakeMux.sent.length, 2);
      assert.equal(fakeMux.sent[1]?.paneId, "%3");
      assert.equal(fakeMux.sent[1]?.submitMode, "followUp");
      assert.equal(launched.length, 3);
      assert.equal(launched[2]?.prompt, "Address the review feedback");
      assert.equal(
        fakePi.appendedEntries.filter((entry) => entry.customType === SUBAGENT_MESSAGE_ENTRY)
          .length,
        4,
      );

      const restoredSessionId = "restored-child";
      const childSessionDir = getDefaultSessionDir(cwd);
      const childSessionPath = path.join(
        childSessionDir,
        `${new Date().toISOString().replace(/[:.]/g, "-")}_${restoredSessionId}.jsonl`,
      );
      await fs.mkdir(path.dirname(childSessionPath), { recursive: true });
      await fs.writeFile(
        childSessionPath,
        [
          JSON.stringify({
            type: "session",
            version: 3,
            id: restoredSessionId,
            timestamp: new Date().toISOString(),
            cwd,
          }),
          JSON.stringify({
            type: "message",
            id: "m1",
            parentId: null,
            timestamp: new Date().toISOString(),
            message: {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "Restored completion summary" }],
            },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const restoreCtx = createFakeContext({
        cwd,
        sessionId: "parent-session-id",
        sessionFile: path.join(cwd, "parent.jsonl"),
        entries: [
          {
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
          },
        ],
      });

      await runtime.restore(restoreCtx);
      assert.equal(
        runtime.listStates().find((state) => state.sessionId === restoredSessionId)?.status,
        "completed",
      );
      const completedStates = fakePi.appendedEntries.filter(
        (entry) => entry.customType === SUBAGENT_STATE_ENTRY,
      ) as Array<{ customType: string; data: RuntimeSubagent }>;
      assert.equal(completedStates.at(-1)?.data.status, "completed");
      assert.equal(fakePi.sentMessages.length, 2);
      assert.deepEqual(fakePi.sentMessages[1]?.options, { deliverAs: "steer", triggerTurn: true });
    } finally {
      runtime.dispose();
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest(
  "subagent tool execute auto-resumes dead child sessions before delivering a message",
  async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-tool-message-dir-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-tool-message-cwd-"));
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

      const started = await tool.execute(
        "tool-call-start-for-message",
        { action: "start", name: "worker-one", task: "Inspect the failing tests" },
        undefined,
        undefined,
        ctx,
      );
      const startedState = (started.details as { state: RuntimeSubagent }).state;
      fakeMux.existingPanes.delete(startedState.paneId);

      const messaged = await tool.execute(
        "tool-call-message-dead-child",
        {
          action: "message",
          sessionId: startedState.sessionId,
          message: "Focus on the root cause",
          delivery: "followUp",
        },
        undefined,
        undefined,
        ctx,
      );

      assert.match(messaged.content[0]?.text ?? "", /sessionId: /);
      assert.match(
        messaged.content[0]?.text ?? "",
        /Previous task resumed and followUp message delivered/i,
      );
      const details = messaged.details as {
        state: RuntimeSubagent;
        autoResumed?: boolean;
        resumePrompt?: string;
        delivery: string;
        message: string;
      };
      assert.equal(details.autoResumed, true);
      assert.equal(details.resumePrompt, "Inspect the failing tests");
      assert.equal(details.state.status, "running");
      assert.equal(fakeMux.created.length, 2);
      assert.equal(fakeMux.sent.length, 1);
      assert.equal(fakeMux.sent[0]?.paneId, details.state.paneId);
      assert.equal(fakeMux.sent[0]?.submitMode, "followUp");

      const collapsed = renderToolText(
        tool,
        {
          action: "message",
          sessionId: startedState.sessionId,
          message: "Focus on the root cause",
          delivery: "followUp",
        },
        {
          content: messaged.content as Array<{ type: "text"; text: string }>,
          details: messaged.details,
          isError: false,
        },
        false,
      );
      const expanded = renderToolText(
        tool,
        {
          action: "message",
          sessionId: startedState.sessionId,
          message: "Focus on the root cause",
          delivery: "followUp",
        },
        {
          content: messaged.content as Array<{ type: "text"; text: string }>,
          details: messaged.details,
          isError: false,
        },
        true,
      );

      assert.match(
        collapsed,
        /worker-one · running · resumed · followUp · Focus on the root cause/,
      );
      assert.match(expanded, /autoResumed: true/);
      assert.match(expanded, /resumePrompt:[\s\S]*Inspect the failing tests/);
      assert.match(expanded, /delivery: followUp/);
      assert.match(expanded, /message:/);
    } finally {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest("subagent tool execute reports unknown message sessions clearly", async () => {
  const fakePi = new FakePi();
  createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(
    fakePi as unknown as ExtensionAPI,
  );
  const tool = fakePi.registeredTools.get("subagent");
  assert.ok(tool);

  await assert.rejects(
    () =>
      tool.execute(
        "tool-call-message-unknown-session",
        { action: "message", sessionId: "missing-child", message: "Ping", delivery: "steer" },
        undefined,
        undefined,
        createFakeContext({ cwd: process.cwd() }),
      ),
    /subagent message failed: sessionId missing-child was not found in this parent session\. Use subagent list or a prior result to get the full UUID v4 sessionId\./i,
  );
});
