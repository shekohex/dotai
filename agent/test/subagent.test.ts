import { afterEach, expect, test } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

import {
  ToolExecutionComponent,
  SessionManager,
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { setKeybindings } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import stripAnsi from "strip-ansi";
import { createTempDir } from "./test-utils/temp-paths.ts";

import {
  defineModesFile,
  registerBuiltInModes,
  unregisterBuiltInModes,
} from "../src/mode-utils.ts";
import { createSubagentExtension } from "../src/extensions/subagent.ts";
import { syncModeTools } from "../src/extensions/modes/tools.ts";
import { formatAvailableModesXml } from "../src/extensions/available-modes.ts";
import { resolveSubagentMode, resolveModeTools } from "../src/subagent-sdk/modes.ts";
import { FallbackMuxAdapter } from "../src/subagent-sdk/fallback-mux.ts";
import { TmuxAdapter } from "../src/subagent-sdk/tmux.ts";
import {
  activateAutoExitTimeoutMode,
  cleanupSubagentPersistenceArtifacts,
  createChildSessionFile,
  getDefaultSessionDir,
  getAutoExitTimeoutModeMarkerPath,
  getEphemeralChildOutcomePath,
  getParentInjectedInputMarkerPath,
  isAutoExitTimeoutModeActive,
  readChildSessionOutcome,
  readEphemeralChildSessionOutcomeBySessionId,
  readChildSessionStatus,
  reduceRuntimeSubagents,
  writeEphemeralChildSessionOutcome,
} from "../src/subagent-sdk/persistence.ts";

const TEST_MODE_SOURCE_NAMES = [
  "test-subagent-child-reviewer",
  "test-subagent-child-mapper",
  "test-subagent-global-reviewer",
  "test-subagent-child-timeout",
  "test-subagent-prompt-guidelines",
  "test-subagent-runtime-reviewer",
] as const;

afterEach(() => {
  for (const sourceName of TEST_MODE_SOURCE_NAMES) {
    unregisterBuiltInModes(sourceName);
  }
});
import type { MuxAdapter, PaneSubmitMode } from "../src/subagent-sdk/mux.ts";
import { SubagentRuntime } from "../src/subagent-sdk/runtime.ts";
import { formatSubagentFailureFallback } from "../src/subagent-sdk/runtime/base.ts";
import {
  SUBAGENT_MESSAGE_ENTRY,
  SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
  SUBAGENT_STATE_ENTRY,
  cloneRuntimeSubagent,
  type RuntimeSubagent,
} from "../src/subagent-sdk/types.ts";
import { renderSubagentWidget } from "../src/subagent-sdk/ui.ts";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";

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

class NamedFakeMuxAdapter extends FakeMuxAdapter {
  constructor(
    readonly backend: string,
    private readonly available: boolean,
  ) {
    super();
  }

  override async isAvailable(): Promise<boolean> {
    return this.available;
  }

  override async createPane(options: {
    cwd: string;
    title: string;
    command: string;
    target: "pane" | "window";
  }): Promise<{ paneId: string; backend: string }> {
    const pane = await super.createPane(options);
    return { ...pane, backend: this.backend };
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
  persisted?: boolean;
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
      isPersisted: () => options.persisted ?? true,
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
  expect(resolved).toEqual(["bash", "read", "session_query"]);
});

timedTest("resolveModeTools supports explicit allow and deny rules", () => {
  const resolved = resolveModeTools(
    ["*", "!bash", "session_query"],
    ["read", "bash", "subagent"],
    ["read", "bash", "subagent", "session_query"],
  );
  expect(resolved).toEqual(["read", "session_query"]);
});

timedTest("structured child failure fallback mentions StructuredOutput tool", () => {
  expect(
    formatSubagentFailureFallback({
      outputFormat: {
        type: "json_schema",
        schema: Type.Object({ answer: Type.String() }),
      },
    }),
  ).toMatch(/StructuredOutput tool/i);
});

timedTest("resolveSubagentMode loads mode config from the child cwd", async () => {
  const parentCwd = await createTempDir("agent-subagent-parent-");
  const childCwd = path.join(parentCwd, "child");
  registerBuiltInModes(
    "test-subagent-child-reviewer",
    defineModesFile({
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
    }),
  );

  try {
    const mode = await resolveSubagentMode(
      new FakePi() as unknown as ExtensionAPI,
      createFakeContext({ cwd: parentCwd }),
      { mode: "reviewer", cwd: childCwd },
    );
    expect(mode.value).toBeTruthy();
    expect(mode.value?.cwd).toBe(childCwd);
    expect(mode.value?.model).toBe("mode-provider/review-model");
    expect(mode.value?.tools).toEqual(["read"]);
    expect(mode.value?.autoExit).toBe(false);
    expect(mode.value?.tmuxTarget).toBe("window");
    expect(mode.value?.systemPrompt).toBe("Review only");
    expect(mode.value?.systemPromptMode).toBe("replace");
  } finally {
    await fs.rm(parentCwd, { recursive: true, force: true });
  }
});

timedTest("resolveSubagentMode normalizes GPT-5 child tools to apply_patch", async () => {
  const parentCwd = await createTempDir("agent-subagent-gpt5-tools-");
  const childCwd = path.join(parentCwd, "child");
  registerBuiltInModes(
    "test-subagent-child-mapper",
    defineModesFile({
      version: 1,
      modes: {
        mapper: {
          provider: "codex-openai",
          modelId: "gpt-5.4-mini",
          tools: ["read", "bash", "edit", "write"],
        },
      },
    }),
  );

  const pi = new FakePi();
  pi.activeTools = ["read", "bash", "edit", "write", "apply_patch", "subagent"];
  pi.allTools = pi.activeTools.map((name) => ({ name }));

  try {
    const mode = await resolveSubagentMode(
      pi as unknown as ExtensionAPI,
      createFakeContext({ cwd: parentCwd }),
      {
        mode: "mapper",
        cwd: childCwd,
      },
    );

    expect(mode.value).toBeTruthy();
    expect(mode.value?.tools).toEqual(["apply_patch", "bash", "read"]);
    expect(mode.value?.tools.includes("edit")).toBe(false);
    expect(mode.value?.tools.includes("write")).toBe(false);
  } finally {
    await fs.rm(parentCwd, { recursive: true, force: true });
  }
});

timedTest(
  "resolveSubagentMode expands file system prompts relative to the defining modes file",
  async () => {
    const cwd = await createTempDir("agent-subagent-global-");
    const agentDir = await createTempDir("agent-subagent-global-config-");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

    process.env.PI_CODING_AGENT_DIR = agentDir;
    registerBuiltInModes(
      "test-subagent-global-reviewer",
      defineModesFile({
        version: 1,
        modes: {
          reviewer: {
            provider: "mode-provider",
            modelId: "review-model",
            systemPrompt: "Review only\nEscalate blockers\n",
          },
        },
      }),
    );

    try {
      const mode = await resolveSubagentMode(
        new FakePi() as unknown as ExtensionAPI,
        createFakeContext({ cwd }),
        { mode: "reviewer" },
      );

      expect(mode.value).toBeTruthy();
      expect(mode.value?.systemPrompt).toBe("Review only\nEscalate blockers\n");
      expect(mode.value?.systemPromptMode).toBe("append");
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
    const parentCwd = await createTempDir("agent-subagent-timeout-parent-");
    const childCwd = path.join(parentCwd, "child");
    registerBuiltInModes(
      "test-subagent-child-timeout",
      defineModesFile({
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
      }),
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

      expect(defaultWorker.value).toBeTruthy();
      expect(defaultWorker.value?.autoExit).toBe(true);
      expect(defaultWorker.value?.autoExitTimeoutMs).toBe(30_000);

      expect(configured.value).toBeTruthy();
      expect(configured.value?.autoExit).toBe(true);
      expect(configured.value?.autoExitTimeoutMs).toBe(45_000);

      expect(disabled.value).toBeTruthy();
      expect(disabled.value?.autoExit).toBe(false);
      expect(disabled.value?.autoExitTimeoutMs).toBe(undefined);
    } finally {
      await fs.rm(parentCwd, { recursive: true, force: true });
    }
  },
);

timedTest(
  "child bootstrap names child sessions with subagent name plus normalized prompt",
  async () => {
    const previousChildState = process.env.PI_SUBAGENT_CHILD_STATE;
    const cwd = await createTempDir("agent-subagent-child-name-");
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

      expect(fakePi.sessionNames.at(-1)).toBe(
        "[subagent:worker-one] Continue the review Inspect failing tests and summarize root cause",
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
  const cwd = await createTempDir("agent-subagent-child-wrapper-");
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

    expect(fakePi.registeredTools.has("StructuredOutput")).toBeTruthy();
    expect(fakePi.registeredTools.has("subagent")).toBe(false);
    expect((fakePi.handlers.get("agent_end") ?? []).length > 0).toBeTruthy();
  } finally {
    if (previousChildState === undefined) {
      delete process.env.PI_SUBAGENT_CHILD_STATE;
    } else {
      process.env.PI_SUBAGENT_CHILD_STATE = previousChildState;
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

timedTest("modes sync preserves StructuredOutput for structured child sessions", async () => {
  const previousChildState = process.env.PI_SUBAGENT_CHILD_STATE;
  const cwd = await createTempDir("agent-subagent-child-modes-");
  const sessionPath = path.join(cwd, "child.jsonl");

  process.env.PI_SUBAGENT_CHILD_STATE = JSON.stringify({
    sessionId: "child-session-id",
    sessionPath,
    parentSessionId: "parent-session-id",
    parentSessionPath: path.join(cwd, "parent.jsonl"),
    name: "commit",
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
    fakePi.allTools = [
      { name: "read" },
      { name: "bash" },
      { name: "subagent" },
      { name: "session_query" },
      { name: "StructuredOutput" },
    ];
    const ctx = createFakeContext({ cwd, sessionId: "child-session-id", sessionFile: sessionPath });

    syncModeTools(fakePi as unknown as ExtensionAPI, ctx, { tools: ["read", "bash"] });

    expect(fakePi.activeTools).toContain("StructuredOutput");
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
  "ephemeral child sessions match child bootstrap handlers without shared sessionId",
  async () => {
    const previousChildState = process.env.PI_SUBAGENT_CHILD_STATE;

    process.env.PI_SUBAGENT_CHILD_STATE = JSON.stringify({
      sessionId: "expected-child-session-id",
      parentSessionId: "parent-session-id",
      name: "worker-one",
      prompt: "Return structured output",
      autoExit: true,
      autoExitTimeoutMs: 30_000,
      handoff: false,
      persisted: false,
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
      createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(
        fakePi as unknown as ExtensionAPI,
      );
      const ctx = createFakeContext({
        cwd: process.cwd(),
        sessionId: "different-ephemeral-session-id",
        persisted: false,
        shutdown: () => {},
      });

      await emitHandlers(
        fakePi,
        "before_agent_start",
        { systemPrompt: "system", prompt: "task" },
        ctx,
      );

      const structuredOutputTool = fakePi.registeredTools.get("StructuredOutput");
      expect(structuredOutputTool).toBeTruthy();
      await structuredOutputTool.execute(
        "structured-tool-call",
        { answer: "done" },
        undefined,
        undefined,
        ctx,
      );
      await emitHandlers(fakePi, "session_shutdown", {}, ctx);

      const outcome = await readEphemeralChildSessionOutcomeBySessionId(
        "expected-child-session-id",
      );
      expect(outcome.failed).toBe(false);
      expect(outcome.structured).toEqual({ answer: "done" });
    } finally {
      if (previousChildState === undefined) {
        delete process.env.PI_SUBAGENT_CHILD_STATE;
      } else {
        process.env.PI_SUBAGENT_CHILD_STATE = previousChildState;
      }
      await fs.rm(getEphemeralChildOutcomePath("expected-child-session-id"), { force: true });
    }
  },
);

timedTest(
  "child bootstrap auto-exits immediately on idle with no manual terminal input",
  async () => {
    const previousChildState = process.env.PI_SUBAGENT_CHILD_STATE;
    const cwd = await createTempDir("agent-subagent-child-auto-exit-");
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
      expect(shutdownCount).toBe(1);
      expect(notifications).toEqual([]);
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
    const cwd = await createTempDir("agent-subagent-child-timeout-mode-");
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
      expect(isAutoExitTimeoutModeActive("child-session-id")).toBe(true);

      await emitHandlers(fakePi, "agent_end", {}, ctx);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(shutdownCount).toBe(0);

      await emitHandlers(fakePi, "before_agent_start", {}, ctx);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(shutdownCount).toBe(0);

      await emitHandlers(fakePi, "agent_end", {}, ctx);
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(shutdownCount).toBe(1);
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
  const cwd = await createTempDir("agent-subagent-child-parent-input-");
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
    expect(isAutoExitTimeoutModeActive("child-session-id")).toBe(false);

    await emitHandlers(fakePi, "agent_end", {}, ctx);
    expect(shutdownCount).toBe(1);
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
  const cwd = await createTempDir("agent-subagent-child-final-tool-");
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
    expect(structuredOutputTool).toBeTruthy();
    const structuredResult = await structuredOutputTool.execute(
      "structured-tool-call",
      { answer: "done" },
      undefined,
      undefined,
      ctx,
    );
    expect(structuredResult.terminate).toBe(true);
    expect(shutdownCount).toBe(1);

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
    expect(shutdownCount).toBe(1);

    await emitHandlers(fakePi, "agent_end", { messages: [] }, ctx);

    const structuredEntries = fakePi.appendedEntries.filter(
      (entry) => entry.customType === SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
    );
    expect(structuredEntries.length).toBe(1);
    const structuredEntry = structuredEntries[0];
    expect(structuredEntry).toBeTruthy();
    expect((structuredEntry.data as { status: string }).status).toBe("error");
    expect((structuredEntry.data as { error?: { code?: string } }).error?.code).toBe(
      "validation_failed",
    );
    expect(shutdownCount).toBe(1);
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
  "child bootstrap preserves captured structured output across empty follow-up turns",
  async () => {
    const previousChildState = process.env.PI_SUBAGENT_CHILD_STATE;
    const cwd = await createTempDir("agent-subagent-child-followup-turn-");
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
      expect(structuredOutputTool).toBeTruthy();
      const structuredResult = await structuredOutputTool.execute(
        "structured-tool-call",
        { answer: "done" },
        undefined,
        undefined,
        ctx,
      );
      expect(structuredResult.terminate).toBe(true);
      expect(shutdownCount).toBe(1);

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
          ],
        },
        ctx,
      );
      expect(shutdownCount).toBe(1);

      await emitHandlers(fakePi, "turn_start", { turnIndex: 2, timestamp: Date.now() }, ctx);
      await emitHandlers(
        fakePi,
        "turn_end",
        {
          turnIndex: 2,
          message: { role: "assistant", content: [], timestamp: Date.now() },
          toolResults: [],
        },
        ctx,
      );

      await emitHandlers(fakePi, "agent_end", { messages: [] }, ctx);

      const structuredEntries = fakePi.appendedEntries.filter(
        (entry) => entry.customType === SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
      );
      expect(structuredEntries.length).toBe(1);
      const structuredEntry = structuredEntries[0];
      expect(structuredEntry).toBeTruthy();
      expect((structuredEntry.data as { status: string }).status).toBe("captured");
      expect(shutdownCount).toBe(1);
      expect(fakePi.sentUserMessages.length).toBe(0);
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

timedTest(
  "child bootstrap captures structured output even if agent ends without turn_end",
  async () => {
    const previousChildState = process.env.PI_SUBAGENT_CHILD_STATE;
    const cwd = await createTempDir("agent-subagent-child-no-turn-end-");
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
      expect(structuredOutputTool).toBeTruthy();
      const structuredResult = await structuredOutputTool.execute(
        "structured-tool-call",
        { answer: "done" },
        undefined,
        undefined,
        ctx,
      );
      expect(structuredResult.terminate).toBe(true);
      expect(shutdownCount).toBe(1);

      await emitHandlers(fakePi, "agent_end", { messages: [] }, ctx);

      const structuredEntries = fakePi.appendedEntries.filter(
        (entry) => entry.customType === SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
      );
      expect(structuredEntries.length).toBe(1);
      expect((structuredEntries[0]?.data as { status: string }).status).toBe("captured");
      expect(shutdownCount).toBe(1);
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

timedTest(
  "ephemeral child writes structured outcome on successful turn_end before agent_end",
  async () => {
    const previousChildState = process.env.PI_SUBAGENT_CHILD_STATE;
    const cwd = await createTempDir("agent-subagent-child-ephemeral-success-");
    const sessionId = "child-session-id";

    process.env.PI_SUBAGENT_CHILD_STATE = JSON.stringify({
      sessionId,
      parentSessionId: "parent-session-id",
      name: "worker-one",
      prompt: "Return structured output",
      autoExit: true,
      autoExitTimeoutMs: 30_000,
      handoff: false,
      persisted: false,
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
      createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(
        fakePi as unknown as ExtensionAPI,
      );
      const ctx = createFakeContext({ cwd, sessionId, persisted: false, shutdown: () => {} });

      await emitHandlers(
        fakePi,
        "before_agent_start",
        { systemPrompt: "system", prompt: "task" },
        ctx,
      );
      await emitHandlers(fakePi, "turn_start", { turnIndex: 1, timestamp: Date.now() }, ctx);

      const structuredOutputTool = fakePi.registeredTools.get("StructuredOutput");
      expect(structuredOutputTool).toBeTruthy();
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
          ],
        },
        ctx,
      );

      const outcome = await readEphemeralChildSessionOutcomeBySessionId(sessionId);
      expect(outcome.failed).toBe(false);
      expect(outcome.structured).toEqual({ answer: "done" });
    } finally {
      if (previousChildState === undefined) {
        delete process.env.PI_SUBAGENT_CHILD_STATE;
      } else {
        process.env.PI_SUBAGENT_CHILD_STATE = previousChildState;
      }
      await fs.rm(getEphemeralChildOutcomePath(sessionId), { force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest("child bootstrap treats retryCount as total allowed turns", async () => {
  const previousChildState = process.env.PI_SUBAGENT_CHILD_STATE;
  const cwd = await createTempDir("agent-subagent-child-retry-budget-");
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

    expect(structuredEntries.map((entry) => entry.status)).toEqual([
      "retrying",
      "retrying",
      "error",
    ]);
    expect(structuredEntries.map((entry) => entry.attempts)).toEqual([1, 2, 3]);
    expect(fakePi.sentUserMessages.length).toBe(2);
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
  const cwd = await createTempDir("agent-subagent-child-retry-resume-");
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

    expect(structuredEntries.map((entry) => entry.status)).toEqual(["error"]);
    expect(structuredEntries.map((entry) => entry.attempts)).toEqual([3]);
    expect(fakePi.sentUserMessages.length).toBe(0);
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
  expect(idleWidget).toBeTruthy();
  expect(idleWidget.join("\n")).toMatch(/auto-exit/);
  expect(idleWidget.join("\n")).toMatch(/1m 30s|1m 29s/);

  const runningWidget = renderSubagentWidget([
    { ...widgetState, status: "running", autoExitDeadlineAt: undefined },
  ]);
  expect(runningWidget).toBeTruthy();
  expect(runningWidget.join("\n")).not.toMatch(/auto-exit/);

  const idleImmediateExitWidget = renderSubagentWidget([
    { ...widgetState, autoExitTimeoutActive: false, autoExitDeadlineAt: undefined },
  ]);
  expect(idleImmediateExitWidget).toBeTruthy();
  expect(idleImmediateExitWidget.join("\n")).not.toMatch(/auto-exit/);
});

timedTest("subagent manager arms idle countdown only after timeout mode activates", async () => {
  const dir = await createTempDir("agent-subagent-manager-timeout-mode-");
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
    expect(immediateExitState.status).toBe("idle");
    expect(immediateExitState.autoExitTimeoutActive).toBe(false);
    expect(immediateExitState.autoExitDeadlineAt).toBe(undefined);

    activateAutoExitTimeoutMode(sessionId);

    const delayedExitState = (await (runtime as any).syncLiveState(
      baseState,
      "updated",
    )) as RuntimeSubagent;
    expect(delayedExitState.status).toBe("idle");
    expect(delayedExitState.autoExitTimeoutActive).toBe(true);
    expect(delayedExitState.autoExitDeadlineAt).toBe(Date.parse(idleAt) + 90_000);
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

  expect(created.paneId).toBe("%7");
  expect(calls.map((call) => call.args)).toEqual([
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
  ]);
});

timedTest("TmuxAdapter sendText wraps multi-line text in bracketed paste markers", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const adapter = new TmuxAdapter(async (command, args) => {
    calls.push({ command, args });
    return { code: 0, stdout: "", stderr: "" };
  }, process.cwd());

  await adapter.sendText("%1", "line one\nline two\nline three", "steer");

  expect(calls.length).toBe(3);
  // load-buffer with temp file
  expect(calls[0]?.args[0]).toBe("load-buffer");
  expect(calls[0]?.args[1]).toBe("-b");
  expect(calls[0]?.args[2]).toMatch(/^pi-subagent-1-/);
  expect(calls[0]?.args[3]).toMatch(/^\/tmp\//);
  // paste-buffer with -p flag for bracketed paste
  expect(calls[1]?.args).toEqual(["paste-buffer", "-p", "-b", calls[0]?.args[2], "-d", "-t", "%1"]);
  // send-keys submit
  expect(calls[2]?.args).toEqual(["send-keys", "-t", "%1", "Enter"]);
});

timedTest("TmuxAdapter sendText uses M-Enter for followUp delivery", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const adapter = new TmuxAdapter(async (command, args) => {
    calls.push({ command, args });
    return { code: 0, stdout: "", stderr: "" };
  }, process.cwd());

  await adapter.sendText("%1", "single line message", "followUp");

  expect(calls[0]?.args[0]).toBe("load-buffer");
  expect(calls[1]?.args.slice(0, 3)).toEqual(["paste-buffer", "-p", "-b"]);
  expect(calls[1]?.args.slice(-3)).toEqual(["-d", "-t", "%1"]);
  expect(calls[2]?.args).toEqual(["send-keys", "-t", "%1", "M-Enter"]);
});

timedTest("TmuxAdapter sendText preserves special characters like tabs", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const adapter = new TmuxAdapter(async (command, args) => {
    calls.push({ command, args });
    return { code: 0, stdout: "", stderr: "" };
  }, process.cwd());

  await adapter.sendText("%1", "column1\tcolumn2\tcolumn3", "steer");

  expect(calls[0]?.args[0]).toBe("load-buffer");
  expect(calls[1]?.args.slice(0, 3)).toEqual(["paste-buffer", "-p", "-b"]);
  expect(calls[1]?.args.slice(-3)).toEqual(["-d", "-t", "%1"]);
  expect(calls[2]?.args).toEqual(["send-keys", "-t", "%1", "Enter"]);
});

timedTest("FallbackMuxAdapter uses first available backend and records pane backend", async () => {
  const tmux = new NamedFakeMuxAdapter("tmux", false);
  const pty = new NamedFakeMuxAdapter("pty", true);
  const adapter = new FallbackMuxAdapter([tmux, pty]);

  const created = await adapter.createPane({
    cwd: "/tmp/project",
    title: "worker",
    command: "pi --session fake",
    target: "window",
  });

  expect(created.backend).toBe("pty");
  expect(tmux.created).toHaveLength(0);
  expect(pty.created).toHaveLength(1);

  await adapter.sendText(created.paneId, "hello", "steer", created.backend);

  expect(pty.sent).toEqual([{ paneId: created.paneId, text: "hello", submitMode: "steer" }]);
});

timedTest("FallbackMuxAdapter routes legacy tmux pane ids without persisted backend", async () => {
  const tmux = new NamedFakeMuxAdapter("tmux", true);
  const pty = new NamedFakeMuxAdapter("pty", true);
  const adapter = new FallbackMuxAdapter([tmux, pty]);

  tmux.existingPanes.add("%42");
  await adapter.sendText("%42", "legacy", "followUp");

  expect(tmux.sent).toEqual([{ paneId: "%42", text: "legacy", submitMode: "followUp" }]);
  expect(pty.sent).toHaveLength(0);
});

timedTest("subagent tool metadata explains terminal inspection and wait-for-summary flow", () => {
  const fakePi = new FakePi();
  createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(
    fakePi as unknown as ExtensionAPI,
  );
  const tool = fakePi.registeredTools.get("subagent");
  expect(tool).toBeTruthy();

  expect(tool.description).toMatch(/no subagent read action/i);
  expect(tool.description).toMatch(/wait for the automatic completion summary/i);
  expect(tool.promptSnippet ?? "").toMatch(/no subagent read action/i);
  expect(tool.promptSnippet ?? "").toMatch(/automatic completion summary/i);
  expect(
    tool.promptGuidelines?.some((guideline) =>
      /backend terminal output when available/i.test(guideline),
    ),
  ).toBe(true);
  expect(
    tool.promptGuidelines?.some((guideline) =>
      /do not poll with `list` just to get the final result/i.test(guideline),
    ),
  ).toBe(true);

  const parameterDescriptions =
    (tool.parameters as { properties?: Record<string, { description?: string }> }).properties ?? {};
  expect(parameterDescriptions.action?.description ?? "").toMatch(/no subagent read action/i);
  expect(parameterDescriptions.name?.description ?? "").toMatch(
    /terminal title shown immediately on launch/i,
  );
  expect(parameterDescriptions.task?.description ?? "").toMatch(
    /rely on completion summaries or terminal output/i,
  );
  expect(parameterDescriptions.sessionId?.description ?? "").toMatch(/UUID v4/i);
  expect(parameterDescriptions.message?.description ?? "").toMatch(
    /use backend terminal output when available/i,
  );
});

timedTest(
  "subagent tool prompt guidelines include available modes xml and refresh on modes change",
  async () => {
    const cwd = await createTempDir("agent-subagent-modes-prompt-");
    const fakePi = new FakePi();
    createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(
      fakePi as unknown as ExtensionAPI,
    );

    try {
      registerBuiltInModes(
        "test-subagent-prompt-guidelines",
        defineModesFile({
          version: 1,
          modes: {
            review: {
              provider: "mode-provider",
              modelId: "review-model",
              thinkingLevel: "high",
              description: "Review & verify",
            },
          },
        }),
      );

      const ctx = createFakeContext({
        cwd,
        sessionId: "parent-session-id",
        sessionFile: path.join(cwd, "parent.jsonl"),
      });

      await emitHandlers(fakePi, "session_start", { reason: "new" }, ctx);

      const initialTool = fakePi.registeredTools.get("subagent");
      expect(initialTool).toBeTruthy();
      expect(
        initialTool.promptGuidelines?.some((guideline) =>
          /Available subagent modes/i.test(guideline),
        ),
      ).toBe(true);
      expect(
        initialTool.promptGuidelines?.some((guideline) => /<available_modes>/i.test(guideline)),
      ).toBe(true);
      expect(
        initialTool.promptGuidelines?.some((guideline) =>
          /description="Review &amp; verify"/i.test(guideline),
        ),
      ).toBe(true);

      registerBuiltInModes(
        "test-subagent-prompt-guidelines",
        defineModesFile({
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
        }),
      );

      await emitEventBus(fakePi, "modes:changed");

      const updatedTool = fakePi.registeredTools.get("subagent");
      expect(updatedTool).toBeTruthy();
      expect(
        updatedTool.promptGuidelines?.some((guideline) =>
          /<mode name="docs" model="mode-provider\/docs-model" thinkingLevel="low" description="Fast &lt;writing&gt;" \/>/i.test(
            guideline,
          ),
        ),
      ).toBe(true);
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

  expect(xml).toBe(
    [
      "<available_modes>",
      '  <mode name="alpha" model="mode-provider/alpha-model" />',
      '  <mode name="middle" thinkingLevel="low" description="Fast &lt;focused&gt; &amp; &quot;safe&quot;" />',
      '  <mode name="zeta" description="Last" />',
      "</available_modes>",
    ].join("\n"),
  );
});

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

  expect(states.size).toBe(1);
  expect(states.get("child-1")?.status).toBe("completed");
});

timedTest("reduceRuntimeSubagents restores latest child activity from session file", () => {
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
    ],
    "parent-a",
  );

  expect(states.get("child-1")?.activity).toBeUndefined();
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

  expect(states.size).toBe(1);
  expect(Array.from(states.keys())).toEqual(["child-valid"]);
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

  expect((original.structured as { result: string }).result).toBe("ok");
  expect(
    (original.outputFormat as { schema: { properties: { result: { type: string } } } }).schema
      .properties.result.type,
  ).toBe("string");
  expect((original.structuredError as { message: string }).message).toBe("error");
});

timedTest("createChildSessionFile bootstraps a persisted child session header", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await createTempDir("agent-subagent-bootstrap-dir-");
  const cwd = await createTempDir("agent-subagent-bootstrap-cwd-");
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const sessionPath = await createChildSessionFile({
      cwd,
      sessionId: "child-session-id",
      parentSessionPath: "/tmp/parent-session.jsonl",
    });

    const sessionManager = SessionManager.open(sessionPath);
    const header = sessionManager.getHeader();
    expect(header).toBeTruthy();
    expect(header?.id).toBe("child-session-id");
    expect(header?.cwd).toBe(cwd);
    expect(header?.parentSession).toBe("/tmp/parent-session.jsonl");
  } finally {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

timedTest("getDefaultSessionDir ignores literal undefined agent-dir env value", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const cwd = await createTempDir("agent-subagent-session-dir-");

  process.env.PI_CODING_AGENT_DIR = "undefined";

  try {
    const sessionDir = getDefaultSessionDir(cwd);
    expect(sessionDir.includes("undefined/sessions")).toBe(false);
    expect(path.isAbsolute(sessionDir)).toBe(true);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

timedTest("createChildSessionFile returns undefined for ephemeral child sessions", async () => {
  const cwd = await createTempDir("agent-subagent-ephemeral-cwd-");

  try {
    const sessionPath = await createChildSessionFile({
      cwd,
      sessionId: "ephemeral-child-session-id",
      persisted: false,
    });

    expect(sessionPath).toBe(undefined);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

timedTest("ephemeral child outcome persists structured output via temp file", async () => {
  const sessionId = "ephemeral-structured-child";

  try {
    writeEphemeralChildSessionOutcome(sessionId, {
      summary: "Structured run finished",
      structured: { summary: "All clear", risk: "low" },
      failed: false,
    });

    const outcome = await readEphemeralChildSessionOutcomeBySessionId(sessionId);
    expect(outcome.failed).toBe(false);
    expect(outcome.summary).toBe("Structured run finished");
    expect(outcome.structured).toEqual({ summary: "All clear", risk: "low" });
  } finally {
    cleanupSubagentPersistenceArtifacts(sessionId);
  }
});

timedTest("SubagentRuntime removes temp persistence artifacts after completion", async () => {
  const fakePi = new FakePi();
  const fakeMux = new FakeMuxAdapter();
  const runtime = new SubagentRuntime(
    fakePi as unknown as ExtensionAPI,
    fakeMux,
    () => "pi --no-session fake",
  );

  try {
    const ctx = createFakeContext({ cwd: process.cwd(), sessionFile: "/tmp/parent.jsonl" });
    const started = await runtime.spawn(
      {
        name: "worker-cleanup",
        task: "Inspect the failing tests",
        persisted: false,
      },
      ctx,
    );
    const sessionId = started.state.sessionId;

    await fs.mkdir(path.dirname(getParentInjectedInputMarkerPath(sessionId)), { recursive: true });
    await fs.writeFile(
      getParentInjectedInputMarkerPath(sessionId),
      JSON.stringify({ expiresAt: Date.now() + 5_000 }),
      "utf8",
    );
    activateAutoExitTimeoutMode(sessionId);
    writeEphemeralChildSessionOutcome(sessionId, {
      summary: "Done",
      failed: false,
    });

    expect(await fs.stat(getParentInjectedInputMarkerPath(sessionId))).toBeTruthy();
    expect(await fs.stat(getAutoExitTimeoutModeMarkerPath(sessionId))).toBeTruthy();
    expect(await fs.stat(getEphemeralChildOutcomePath(sessionId))).toBeTruthy();

    await (
      runtime as unknown as { finalizeInactiveSubagent(state: RuntimeSubagent): Promise<void> }
    ).finalizeInactiveSubagent(started.state);

    await expect(fs.stat(getParentInjectedInputMarkerPath(sessionId))).rejects.toThrow();
    await expect(fs.stat(getAutoExitTimeoutModeMarkerPath(sessionId))).rejects.toThrow();
    await expect(fs.stat(getEphemeralChildOutcomePath(sessionId))).rejects.toThrow();
  } finally {
    runtime.dispose();
    for (const state of runtime.listStates()) {
      cleanupSubagentPersistenceArtifacts(state.sessionId);
    }
  }
});

timedTest("readChildSessionOutcome extracts the last assistant summary", async () => {
  const dir = await createTempDir("agent-subagent-outcome-");
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
    expect(outcome.failed).toBe(false);
    expect(outcome.summary).toBe("Finished successfully");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

timedTest("readChildSessionOutcome marks missing assistant outcome as failed", async () => {
  const dir = await createTempDir("agent-subagent-outcome-missing-");
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
    ].join("\n") + "\n",
    "utf8",
  );

  try {
    const outcome = await readChildSessionOutcome(sessionPath);
    expect(outcome.failed).toBe(true);
    expect(outcome.summary).toBe(undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

timedTest("readChildSessionStatus distinguishes running and idle child sessions", async () => {
  const dir = await createTempDir("agent-subagent-status-");
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
    expect(await readChildSessionStatus(idlePath)).toBe("idle");
    expect(await readChildSessionStatus(runningPath)).toBe("running");
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
  expect(tool).toBeTruthy();

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
  expect(collapsedLines.length).toBe(1);
  expect(collapsed).toMatch(
    /π start · worker-one · reviewer · Continue the review Inspect failing tests · worker-one · idle/,
  );
  expect(collapsed).not.toMatch(/sessionPath:/);
  expect(collapsed).not.toMatch(/paneId:/);
  expect(collapsed).not.toMatch(/prompt:/);
  expect(expanded).toMatch(/π start/);
  expect(expanded).toMatch(/name: worker-one/);
  expect(expanded).toMatch(/sessionId: 12345678-1234-1234-1234-123456789abc/);
  expect(expanded).toMatch(/mode: reviewer/);
  expect(expanded).toMatch(/task:/);
  expect(expanded).toMatch(/Continue the review/);
  expect(expanded).toMatch(/Inspect failing tests/);
  expect(expanded).toMatch(/prompt:/);
  expect(expanded).toMatch(/sessionId: 12345678-1234-1234-1234-123456789abc/);
  expect(expanded).toMatch(/paneId: %5/);
  expect(expanded).toMatch(/status: idle/);
  expect(expanded).toMatch(/sessionPath: \/tmp\/subagent\.jsonl/);
  expect(expanded).toMatch(/parentSessionId: parent-session-id/);
  expect(expanded).toMatch(/startedAt: 1970-01-01T00:00:00\.001Z/);
  expect(expanded).toMatch(/updatedAt: 1970-01-01T00:00:00\.002Z/);
});

timedTest("subagent tool renders collapsed list summary counts and cancel status", () => {
  const fakePi = new FakePi();
  createSubagentExtension({ adapterFactory: () => new FakeMuxAdapter() })(
    fakePi as unknown as ExtensionAPI,
  );
  const tool = fakePi.registeredTools.get("subagent");
  expect(tool).toBeTruthy();

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

  expect(listCollapsed).toMatch(/π list · 3 agents · 1 running · 1 idle · 1 completed/);
  expect(listCollapsed).not.toMatch(/cancelled/);
  expect(listCollapsed).not.toMatch(/failed/);

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

  expect(cancelCollapsed).toMatch(/π cancel · cancelle · worker-stop · cancelled/);
});

timedTest("subagent tool execute preserves prompt and expanded start details", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await createTempDir("agent-subagent-tool-dir-");
  const cwd = await createTempDir("agent-subagent-tool-cwd-");
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const fakePi = new FakePi();
  const fakeMux = new FakeMuxAdapter();
  createSubagentExtension({ adapterFactory: () => fakeMux })(fakePi as unknown as ExtensionAPI);
  const tool = fakePi.registeredTools.get("subagent");
  expect(tool).toBeTruthy();

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

    expect((started.details as { prompt: string }).prompt).toBe(startTask);
    expect(started.content[0]?.text ?? "").toMatch(
      /will return with a summary automatically when it finishes/i,
    );
    expect(started.content[0]?.text ?? "").toMatch(/steer the work while running/i);
    const startedDetails = started.details as { prompt: string; state: RuntimeSubagent };
    expect(started.content[0]?.text ?? "").toMatch(
      new RegExp(`sessionId: ${startedDetails.state.sessionId}`),
    );
    expect(startedDetails.state.task).toBe(startTask);
    expect(started.content[0]?.text ?? "").toMatch(/cancel to stop it/i);

    const listed = await tool.execute(
      "tool-call-list",
      { action: "list" },
      undefined,
      undefined,
      ctx,
    );
    expect(listed.content[0]?.text ?? "").toMatch(/count: 1/);
    expect(listed.content[0]?.text ?? "").toMatch(
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

    expect(expanded).toMatch(/sessionId: /);
    expect(expanded).toMatch(/prompt:/);
    expect(expanded).toMatch(/promptGuidance:/);
    expect(expanded).toMatch(/will return with a summary automatically when it finishes/i);
    expect(expanded).toMatch(/Inspect the failing tests/);
    expect(expanded).toMatch(/sessionPath: /);
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
    const agentDir = await createTempDir("agent-subagent-tool-structured-dir-");
    const cwd = await createTempDir("agent-subagent-tool-structured-cwd-");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const fakePi = new FakePi();
    const fakeMux = new FakeMuxAdapter();
    createSubagentExtension({ adapterFactory: () => fakeMux })(fakePi as unknown as ExtensionAPI);
    const tool = fakePi.registeredTools.get("subagent");
    expect(tool).toBeTruthy();

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

      expect(sessionPath).toBeTruthy();
      expect(paneId).toBeTruthy();

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
      expect(started.content.length).toBe(1);
      expect(JSON.parse(started.content[0]?.text ?? "{}")).toEqual({
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
  expect(tool).toBeTruthy();

  await expect(
    tool.execute(
      "tool-call-invalid-start",
      { action: "start", name: "worker-one" },
      undefined,
      undefined,
      createFakeContext({ cwd: process.cwd() }),
    ),
  ).rejects.toThrow(
    /Invalid subagent start params: `task` is required.*There is no subagent read action later/i,
  );

  await expect(
    tool.execute(
      "tool-call-invalid-message",
      { action: "message", sessionId: "child-1" },
      undefined,
      undefined,
      createFakeContext({ cwd: process.cwd() }),
    ),
  ).rejects.toThrow(/Invalid subagent message params: `message` is required/i);
});

timedTest(
  "SubagentRuntime spawn, resume, message, cancel, and restore cover the lifecycle",
  async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await createTempDir("agent-subagent-dir-");
    const cwd = await createTempDir("agent-subagent-cwd-");
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
      registerBuiltInModes(
        "test-subagent-runtime-reviewer",
        defineModesFile({
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
        }),
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
      expect(started.state.status).toBe("running");
      expect(fakeMux.created.length).toBe(1);
      expect(fakeMux.created[0]?.target).toBe("window");
      expect(launched.length).toBe(1);
      const launch = launched[0]!;
      expect(launch.prompt).toBe("Inspect the failing tests");
      expect(fakeMux.sent.length).toBe(0);
      expect((launch.childState as { tools: string[] }).tools).toEqual(["read"]);
      expect((launch.childState as { prompt: string }).prompt).toBe("Inspect the failing tests");
      expect((launch.childState as { persisted: boolean }).persisted).toBe(true);
      expect((launch.childState as { autoExitTimeoutMs?: number }).autoExitTimeoutMs).toBe(30_000);
      expect(launch.options).toEqual({
        launchTarget: { kind: "session", sessionPath: started.state.sessionPath },
        tmuxTarget: "window",
        model: "mode-provider/review-model",
        thinkingLevel: undefined,
        modeName: "reviewer",
        systemPrompt: "Review only",
        systemPromptMode: "append",
      });
      expect(
        fakePi.appendedEntries.filter((entry) => entry.customType === SUBAGENT_STATE_ENTRY).length,
      ).toBe(1);
      const persistedStartedState = fakePi.appendedEntries.find(
        (entry) => entry.customType === SUBAGENT_STATE_ENTRY,
      )?.data as Record<string, unknown> | undefined;
      expect(persistedStartedState).toBeTruthy();
      expect("modeLabel" in persistedStartedState).toBe(false);
      expect(runtime.listStates().length).toBe(1);

      const runtimeSnapshot = runtime.listStates()[0];
      expect(runtimeSnapshot).toBeTruthy();
      runtimeSnapshot.status = "failed";
      runtimeSnapshot.paneId = "%999";
      expect(runtime.listStates()[0]?.status).toBe("running");
      expect(runtime.listStates()[0]?.paneId).not.toBe("%999");

      const delivered = await runtime.message(
        {
          sessionId: started.state.sessionId,
          message: "Focus on src/extensions first",
          delivery: "steer",
        },
        ctx,
      );
      expect(delivered.state.status).toBe("running");
      expect(delivered.autoResumed).toBe(false);
      expect(fakeMux.sent.length).toBe(1);
      expect(fakeMux.sent[0]?.submitMode).toBe("steer");
      expect(
        fakePi.appendedEntries.filter((entry) => entry.customType === SUBAGENT_MESSAGE_ENTRY)
          .length,
      ).toBe(2);
      const parentInputMarker = JSON.parse(
        await fs.readFile(getParentInjectedInputMarkerPath(started.state.sessionId), "utf8"),
      ) as { expiresAt: number };
      expect(parentInputMarker.expiresAt > Date.now()).toBeTruthy();

      const cancelled = await runtime.cancel({ sessionId: started.state.sessionId });
      expect(cancelled.status).toBe("cancelled");
      expect(fakeMux.killed.length).toBe(1);
      expect(runtime.listStates().length).toBe(1);
      expect(runtime.listStates()[0]?.status).toBe("cancelled");
      expect(fakePi.sentMessages.length).toBe(1);

      const resumed = await runtime.resume(
        {
          sessionId: started.state.sessionId,
          task: "Address the review feedback",
          mode: "reviewer",
        },
        ctx,
      );
      expect(resumed.state.status).toBe("running");
      expect(resumed.state.sessionId).toBe(started.state.sessionId);
      expect(resumed.state.paneId).toBe("%2");
      expect(fakeMux.created.length).toBe(2);
      expect(fakeMux.created[1]?.target).toBe("window");
      expect(launched.length).toBe(2);
      const resumedLaunch = launched[1];
      expect(resumedLaunch).toBeTruthy();
      expect(resumedLaunch.prompt).toBe("Address the review feedback");
      expect((resumedLaunch.childState as { prompt: string }).prompt).toBe(
        "Address the review feedback",
      );
      expect((resumedLaunch.childState as { persisted: boolean }).persisted).toBe(true);
      expect((resumedLaunch.childState as { autoExitTimeoutMs?: number }).autoExitTimeoutMs).toBe(
        30_000,
      );
      expect(resumedLaunch.options).toEqual({
        launchTarget: { kind: "session", sessionPath: started.state.sessionPath },
        tmuxTarget: "window",
        model: "mode-provider/review-model",
        thinkingLevel: undefined,
        modeName: "reviewer",
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
      expect(deliveredAfterAutoResume.autoResumed).toBe(true);
      expect(deliveredAfterAutoResume.resumePrompt).toBe(
        "Continue with the highest priority review item",
      );
      expect(deliveredAfterAutoResume.state.status).toBe("running");
      expect(deliveredAfterAutoResume.state.paneId).toBe("%3");
      expect(fakeMux.created.length).toBe(3);
      // sendText skipped when auto-resumed (message already set as resume prompt)
      expect(fakeMux.sent.length).toBe(1);
      expect(launched.length).toBe(3);
      expect(launched[2]?.prompt).toBe("Continue with the highest priority review item");
      expect(
        fakePi.appendedEntries.filter((entry) => entry.customType === SUBAGENT_MESSAGE_ENTRY)
          .length,
      ).toBe(2);

      const restoredSessionId = "restored-child";
      const childSessionDir = getDefaultSessionDir(cwd);
      const childSessionPath = path.join(
        childSessionDir,
        `${new Date().toISOString().replaceAll(/[:.]/g, "-")}_${restoredSessionId}.jsonl`,
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
      expect(
        runtime.listStates().find((state) => state.sessionId === restoredSessionId)?.status,
      ).toBe("completed");
      const completedStates = fakePi.appendedEntries.filter(
        (entry) => entry.customType === SUBAGENT_STATE_ENTRY,
      ) as Array<{ customType: string; data: RuntimeSubagent }>;
      expect(completedStates.at(-1)?.data.status).toBe("completed");
      expect(fakePi.sentMessages.length).toBe(2);
      expect(fakePi.sentMessages[1]?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
    } finally {
      runtime.dispose();
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest("SubagentRuntime launches ephemeral children when persisted=false", async () => {
  {
    const fakePi = new FakePi();
    const fakeMux = new FakeMuxAdapter();
    const runtime = new SubagentRuntime(
      fakePi as unknown as ExtensionAPI,
      fakeMux,
      () => "pi --no-session fake",
    );

    try {
      const ctx = createFakeContext({ cwd: process.cwd(), sessionFile: "/tmp/parent.jsonl" });
      const started = await runtime.spawn(
        {
          name: "worker-silent",
          task: "stay quiet",
          completion: false,
        },
        ctx,
      );

      await runtime.cancel({ sessionId: started.state.sessionId });

      expect(fakePi.sentMessages).toHaveLength(0);
    } finally {
      runtime.dispose();
    }
  }

  {
    const fakePi = new FakePi();
    const fakeMux = new FakeMuxAdapter();
    const runtime = new SubagentRuntime(
      fakePi as unknown as ExtensionAPI,
      fakeMux,
      () => "pi --no-session fake",
    );

    try {
      const ctx = createFakeContext({ cwd: process.cwd(), sessionFile: "/tmp/parent.jsonl" });
      const started = await runtime.spawn(
        {
          name: "worker-follow-up",
          task: "send follow up",
          completion: { deliverAs: "followUp", triggerTurn: false },
        },
        ctx,
      );

      await runtime.cancel({ sessionId: started.state.sessionId });

      expect(fakePi.sentMessages).toHaveLength(1);
      expect(fakePi.sentMessages[0]?.options).toEqual({ deliverAs: "followUp" });
    } finally {
      runtime.dispose();
    }
  }

  const fakePi = new FakePi();
  const fakeMux = new FakeMuxAdapter();
  const launched: Array<{
    state: RuntimeSubagent;
    childState: ChildBootstrapState;
    prompt: string;
    options: unknown;
  }> = [];
  const runtime = new SubagentRuntime(
    fakePi as unknown as ExtensionAPI,
    fakeMux,
    (state, childState, prompt, options) => {
      launched.push({ state, childState, prompt, options });
      return "pi --no-session fake";
    },
  );

  try {
    const ctx = createFakeContext({ cwd: process.cwd(), sessionFile: "/tmp/parent.jsonl" });
    const started = await runtime.spawn(
      {
        name: "worker-ephemeral",
        task: "Inspect the failing tests",
        persisted: false,
      },
      ctx,
    );

    expect(started.state.persisted).toBe(false);
    expect(started.state.sessionPath).toBe(undefined);
    expect(fakeMux.created.length).toBe(1);
    expect(launched.length).toBe(1);
    expect(launched[0]?.childState.persisted).toBe(false);
    expect(launched[0]?.childState.sessionPath).toBe(undefined);
    expect(launched[0]?.options).toEqual({
      launchTarget: { kind: "ephemeral" },
      tmuxTarget: "pane",
      modeName: "worker",
      model: undefined,
      thinkingLevel: undefined,
      systemPrompt: undefined,
      systemPromptMode: "append",
    });

    fakeMux.existingPanes.delete(started.state.paneId);
    await expect(
      runtime.resume(
        {
          sessionId: started.state.sessionId,
          task: "Resume the ephemeral child",
        },
        ctx,
      ),
    ).rejects.toThrow(/ephemeral.*cannot be resumed/i);
  } finally {
    runtime.dispose();
  }
});

timedTest("SubagentRuntime infers ephemeral children from ephemeral parents", async () => {
  const fakePi = new FakePi();
  const fakeMux = new FakeMuxAdapter();
  const launched: Array<{ childState: ChildBootstrapState }> = [];
  const runtime = new SubagentRuntime(
    fakePi as unknown as ExtensionAPI,
    fakeMux,
    (_state, childState) => {
      launched.push({ childState });
      return "pi --no-session fake";
    },
  );

  try {
    const ctx = createFakeContext({ cwd: process.cwd(), persisted: false });
    const started = await runtime.spawn(
      {
        name: "worker-inferred-ephemeral",
        task: "Inspect the failing tests",
      },
      ctx,
    );

    expect(started.state.persisted).toBe(false);
    expect(started.state.sessionPath).toBe(undefined);
    expect(launched[0]?.childState.persisted).toBe(false);
  } finally {
    runtime.dispose();
  }
});

timedTest(
  "subagent tool execute auto-resumes dead child sessions before delivering a message",
  async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await createTempDir("agent-subagent-tool-message-dir-");
    const cwd = await createTempDir("agent-subagent-tool-message-cwd-");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const fakePi = new FakePi();
    const fakeMux = new FakeMuxAdapter();
    createSubagentExtension({ adapterFactory: () => fakeMux })(fakePi as unknown as ExtensionAPI);
    const tool = fakePi.registeredTools.get("subagent");
    expect(tool).toBeTruthy();

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

      expect(messaged.content[0]?.text ?? "").toMatch(/sessionId: /);
      expect(messaged.content[0]?.text ?? "").toMatch(/Resumed with new task/i);
      const details = messaged.details as {
        state: RuntimeSubagent;
        autoResumed?: boolean;
        resumePrompt?: string;
        delivery: string;
        message: string;
      };
      expect(details.autoResumed).toBe(true);
      expect(details.resumePrompt).toBe("Focus on the root cause");
      expect(details.state.status).toBe("running");
      expect(fakeMux.created.length).toBe(2);
      // sendText skipped when auto-resumed (message already set as resume prompt)
      expect(fakeMux.sent.length).toBe(0);

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

      expect(collapsed).toMatch(/worker-one · running · resumed · Focus on the root cause/);
      expect(expanded).toMatch(/autoResumed: true/);
      expect(expanded).toMatch(/resumePrompt:[\s\S]*Focus on the root cause/);
      expect(expanded).toMatch(/note:.*delivery parameter ignored/);
      expect(expanded).toMatch(/message:/);
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
  expect(tool).toBeTruthy();

  await expect(
    tool.execute(
      "tool-call-message-unknown-session",
      { action: "message", sessionId: "missing-child", message: "Ping", delivery: "steer" },
      undefined,
      undefined,
      createFakeContext({ cwd: process.cwd() }),
    ),
  ).rejects.toThrow(
    /subagent message failed: sessionId missing-child was not found in this parent session\. Use subagent list or a prior result to get the full UUID v4 sessionId\./i,
  );
});
