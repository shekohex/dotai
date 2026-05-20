import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { groupedExtensionsC } from "../src/extensions/definitions-group-c.js";
import goalExtension from "../src/extensions/goal/index.js";
import { parseGoalCustomEntry, reconstructGoal } from "../src/extensions/goal/state.js";
import { GOAL_EXTENSION_ENTRY_TYPE } from "../src/extensions/goal/types.js";

type GoalEventHandler = (event: object, ctx: ExtensionContext) => unknown | Promise<unknown>;

interface SentGoalMessage {
  message: Parameters<ExtensionAPI["sendMessage"]>[0];
  options: Parameters<ExtensionAPI["sendMessage"]>[1];
}

interface GoalRenderCallContext {
  lastComponent: unknown;
  state: unknown;
  isPartial: boolean;
  argsComplete: boolean;
  expanded: boolean;
  isError: boolean;
  cwd: string;
}

interface GoalRenderableTool {
  renderCall?: (
    args: Record<string, unknown>,
    theme: ExtensionCommandContext["ui"]["theme"],
    context: GoalRenderCallContext,
  ) => unknown;
}

function createGoalHarness(
  options: {
    idle?: boolean;
    pendingMessages?: boolean;
    confirm?: boolean;
    contextUsagePercent?: number | null;
    contextUsageTokens?: number | null;
    contextWindow?: number;
    initialEntries?: ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]>;
    notify?: (message: string, level?: string) => void;
  } = {},
) {
  const entries: ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]> = [
    ...(options.initialEntries ?? []),
  ];
  const handlers = new Map<string, GoalEventHandler[]>();
  const sentMessages: SentGoalMessage[] = [];
  const emittedEvents: Array<{ eventName: string; data: unknown }> = [];
  const tools = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const registeredTools = new Map<string, GoalRenderableTool>();
  let activeTools: string[] = [];
  const runtime = {
    abortCount: 0,
    idle: options.idle ?? true,
    pendingMessages: options.pendingMessages ?? false,
    confirm: options.confirm ?? true,
    contextUsagePercent: options.contextUsagePercent,
    contextUsageTokens: options.contextUsageTokens,
    contextWindow: options.contextWindow ?? 1000,
  };
  let commandHandler:
    | ((args: string, ctx: ExtensionCommandContext) => void | Promise<void>)
    | null = null;
  let ctx: ExtensionCommandContext;
  let entryIndex = 0;

  const on = ((event: string, handler: GoalEventHandler) => {
    const currentHandlers = handlers.get(event) ?? [];
    currentHandlers.push(handler);
    handlers.set(event, currentHandlers);
  }) as ExtensionAPI["on"];

  const registerCommand: ExtensionAPI["registerCommand"] = (name, definition) => {
    if (name === "goal") {
      commandHandler = definition.handler;
    }
  };

  const pi: ExtensionAPI = {
    appendEntry(customType: string, data: unknown) {
      entries.push({
        type: "custom",
        id: `entry-${++entryIndex}`,
        parentId: null,
        timestamp: new Date(0).toISOString(),
        customType,
        data,
      });
    },
    events: {
      emit(eventName, data) {
        emittedEvents.push({ eventName, data });
      },
      on() {
        return () => {};
      },
    },
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    getActiveTools: () => activeTools,
    getAllTools: () => [],
    getCommands: () => [],
    getFlag: () => undefined,
    getSessionName: () => undefined,
    getThinkingLevel: () => "medium",
    on,
    registerCommand,
    registerFlag() {},
    registerMessageRenderer() {},
    registerProvider() {},
    registerShortcut() {},
    registerTool(tool) {
      registeredTools.set(tool.name, tool as GoalRenderableTool);
      tools.set(tool.name, (params) =>
        tool.execute("tool-call", params as never, undefined, undefined, ctx),
      );
    },
    sendMessage(message, messageOptions) {
      sentMessages.push({ message, options: messageOptions });
    },
    sendUserMessage() {},
    setActiveTools(toolNames) {
      activeTools = toolNames;
    },
    setLabel() {},
    setModel: async () => false,
    setSessionName() {},
    setThinkingLevel() {},
    unregisterProvider() {},
  };

  const sessionManager: ExtensionCommandContext["sessionManager"] = {
    getBranch: () => entries,
    getCwd: () => "/tmp",
    getEntries: () => entries,
    getEntry: () => undefined,
    getHeader: () => null,
    getLabel: () => undefined,
    getLeafEntry: () => undefined,
    getLeafId: () => null,
    getSessionDir: () => "/tmp",
    getSessionFile: () => undefined,
    getSessionId: () => "session",
    getSessionName: () => undefined,
    getTree: () => [],
  };

  const ui: ExtensionCommandContext["ui"] = {
    addAutocompleteProvider() {},
    confirm: async () => runtime.confirm,
    custom: async () => {
      throw new Error("custom UI not implemented in goal harness");
    },
    editor: async () => undefined,
    getAllThemes: () => [],
    getEditorComponent: () => undefined,
    getEditorText: () => "",
    getTheme: () => undefined,
    getToolsExpanded: () => false,
    input: async () => undefined,
    notify: options.notify ?? (() => {}),
    onTerminalInput: () => () => {},
    pasteToEditor() {},
    select: async () => undefined,
    setEditorComponent() {},
    setEditorText() {},
    setFooter() {},
    setHeader() {},
    setHiddenThinkingLabel() {},
    setStatus() {},
    setTheme: () => ({ success: false }),
    setTitle() {},
    setToolsExpanded() {},
    setWidget() {},
    setWorkingIndicator() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    theme: {} as ExtensionCommandContext["ui"]["theme"],
  };

  ctx = {
    abort() {
      runtime.abortCount += 1;
    },
    compact() {},
    cwd: "/tmp",
    fork: async () => ({ cancelled: false }),
    getContextUsage: () => {
      if (runtime.contextUsagePercent === undefined) {
        return undefined;
      }

      return {
        tokens: runtime.contextUsageTokens ?? null,
        percent: runtime.contextUsagePercent ?? null,
        contextWindow: runtime.contextWindow,
      };
    },
    getSystemPrompt: () => "",
    hasUI: true,
    hasPendingMessages: () => runtime.pendingMessages,
    isIdle: () => runtime.idle,
    model: undefined,
    modelRegistry: {} as ExtensionCommandContext["modelRegistry"],
    navigateTree: async () => ({ cancelled: false }),
    newSession: async () => ({ cancelled: false }),
    reload: async () => {},
    sessionManager,
    shutdown() {},
    signal: undefined,
    switchSession: async () => ({ cancelled: false }),
    ui,
    waitForIdle: async () => {},
  };

  goalExtension(pi);

  async function runCommand(args: string): Promise<void> {
    if (!commandHandler) {
      throw new Error("goal command not registered");
    }

    await commandHandler(args, ctx);
  }

  async function emit(event: string, payload: object): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await handler(payload, ctx));
    }
    return results;
  }

  async function runTool(params: Record<string, unknown>) {
    const tool = tools.get("goal");
    if (!tool) {
      throw new Error("goal tool not registered");
    }

    return tool(params);
  }

  return {
    emit,
    entries,
    runCommand,
    runTool,
    registeredTools,
    sentMessages,
    setIdle(idle: boolean) {
      runtime.idle = idle;
    },
    setPendingMessages(pendingMessages: boolean) {
      runtime.pendingMessages = pendingMessages;
    },
    setContextUsage(percent: number | null | undefined, tokens: number | null = null) {
      runtime.contextUsagePercent = percent;
      runtime.contextUsageTokens = tokens;
    },
    get abortCount() {
      return runtime.abortCount;
    },
    snapshot: () => reconstructGoal(entries),
    emittedEvents,
    tools,
    get activeTools() {
      return activeTools;
    },
  };
}

function goalTestTheme(): ExtensionCommandContext["ui"]["theme"] {
  const format = (_token: ThemeColor, text: string) => text;
  return {
    fg: format,
    bg: format,
    bold: (value: string) => value,
    dim: (value: string) => value,
    italic: (value: string) => value,
    underline: (value: string) => value,
    inverse: (value: string) => value,
    strikethrough: (value: string) => value,
  } as ExtensionCommandContext["ui"]["theme"];
}

function renderGoalCallText(
  tool: GoalRenderableTool,
  args: Record<string, unknown>,
  lastComponent?: unknown,
): string {
  const component = tool.renderCall?.(args, goalTestTheme(), {
    lastComponent,
    state: {},
    isPartial: true,
    argsComplete: false,
    expanded: false,
    isError: false,
    cwd: "/tmp",
  });

  if (!(component instanceof Text)) {
    throw new Error("expected text component");
  }

  return component.render(200).join("\n");
}

function assistantMessage(
  stopReason: "stop" | "aborted" | "length" | "toolUse",
  usage: { input: number; output: number },
) {
  return {
    role: "assistant",
    content: [],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usage.input + usage.output,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    timestamp: 1,
  };
}

function waitForContinuationRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 75));
}

function waitForCompactionResume(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 175));
}

describe("goal extension", () => {
  test("bundled definitions include goal extension", () => {
    expect(groupedExtensionsC.some((definition) => definition.id === "goal")).toBe(true);
  });

  test("goal tool is hidden until goal command enables it", async () => {
    const harness = createGoalHarness();

    expect(harness.tools.has("goal")).toBe(false);
    expect(harness.activeTools.includes("goal")).toBe(false);

    await harness.runCommand("on");

    expect(harness.tools.has("goal")).toBe(true);
    expect(harness.activeTools.includes("goal")).toBe(true);

    await harness.runCommand("off");

    expect(harness.tools.has("goal")).toBe(true);
    expect(harness.activeTools.includes("goal")).toBe(false);
  });

  test("goal command first use enables goal tool", async () => {
    const harness = createGoalHarness();

    await harness.runCommand("");

    expect(harness.tools.has("goal")).toBe(true);
    expect(harness.activeTools.includes("goal")).toBe(true);
  });

  test("goal tool enabled state restores from session entries", async () => {
    const firstHarness = createGoalHarness();
    await firstHarness.runCommand("on");

    const restoredHarness = createGoalHarness({ initialEntries: firstHarness.entries });
    await restoredHarness.emit("session_start", { type: "session_start", reason: "resume" });

    expect(restoredHarness.tools.has("goal")).toBe(true);
    expect(restoredHarness.activeTools.includes("goal")).toBe(true);
  });

  test("goal tool disabled state restores from session entries", async () => {
    const firstHarness = createGoalHarness();
    await firstHarness.runCommand("on");
    await firstHarness.runCommand("off");

    const restoredHarness = createGoalHarness({ initialEntries: firstHarness.entries });
    await restoredHarness.emit("session_start", { type: "session_start", reason: "resume" });

    expect(restoredHarness.activeTools.includes("goal")).toBe(false);
  });

  test("goal tool supports get create and update actions", async () => {
    const harness = createGoalHarness();
    await harness.runCommand("on");

    const created = (await harness.runTool({
      action: "create",
      objective: "ship it",
    })) as { details: Record<string, unknown>; content: Array<{ text: string }> };

    expect((created.details.goal as { objective?: string }).objective).toBe("ship it");
    expect(created.details.goal).not.toHaveProperty("tokenBudget");
    expect(
      harness.emittedEvents.find((event) => event.eventName === "goal:progress")?.data,
    ).toMatchObject({
      status: "active",
      sessionId: "session",
      cwd: "/tmp",
      timeUsedSeconds: 0,
    });

    const got = (await harness.runTool({ action: "get" })) as { details: Record<string, unknown> };
    expect((got.details.goal as { objective?: string }).objective).toBe("ship it");

    const completed = (await harness.runTool({ action: "update", status: "complete" })) as {
      details: Record<string, unknown>;
    };
    expect(completed.details.completionUsageReport).toBeNull();
    expect(harness.emittedEvents.at(-1)).toMatchObject({
      eventName: "goal:progress",
      data: { status: "clear", sessionId: "session", cwd: "/tmp" },
    });
  });

  test("goal tool creates goal from absolute objective file", async () => {
    const harness = createGoalHarness();
    await harness.runCommand("on");
    const directory = mkdtempSync(join(tmpdir(), "agent-goal-objective-"));
    const objectiveFile = join(directory, "objective.md");
    writeFileSync(objectiveFile, "ship it exactly\nwith next line");

    const created = (await harness.runTool({
      action: "create",
      objectiveFile,
    })) as { details: Record<string, unknown> };

    expect((created.details.goal as { objective?: string }).objective).toBe(
      "ship it exactly\nwith next line",
    );
  });

  test("goal tool rejects ambiguous or relative objective file inputs", async () => {
    const harness = createGoalHarness();
    await harness.runCommand("on");

    const both = (await harness.runTool({
      action: "create",
      objective: "ship it",
      objectiveFile: "/tmp/objective.md",
    })) as { details: Record<string, unknown>; content: Array<{ text: string }> };
    expect(both.content[0]?.text).toContain("Provide exactly one objective source");

    const relative = (await harness.runTool({
      action: "create",
      objectiveFile: "objective.md",
    })) as { details: Record<string, unknown>; content: Array<{ text: string }> };
    expect(relative.content[0]?.text).toContain("objectiveFile must be an absolute path");
  });

  test("goal tool rejects objective files over objective character limit", async () => {
    const harness = createGoalHarness();
    await harness.runCommand("on");
    const directory = mkdtempSync(join(tmpdir(), "agent-goal-objective-"));
    const objectiveFile = join(directory, "objective.md");
    writeFileSync(objectiveFile, "x".repeat(8001));

    const created = (await harness.runTool({
      action: "create",
      objectiveFile,
    })) as { content: Array<{ text: string }> };

    expect(created.content[0]?.text).toContain(
      "objectiveFile content must be 8000 characters or fewer",
    );
  });

  test("goal tool render call previews recent objective lines and line count", async () => {
    const harness = createGoalHarness();
    await harness.runCommand("on");
    const tool = harness.registeredTools.get("goal");
    if (tool === undefined) {
      throw new Error("goal tool not registered");
    }

    const text = renderGoalCallText(tool, {
      action: "create",
      objective: ["one", "two", "three", "four", "five", "six"].join("\n"),
    });

    expect(text).toContain("creating 6 lines");
    expect(text).not.toContain("one");
    expect(text).toContain("two");
    expect(text).toContain("six");
  });

  test("goal tool can create new goal after previous goal is complete", async () => {
    const harness = createGoalHarness();
    await harness.runCommand("on");

    await harness.runTool({ action: "create", objective: "first goal" });
    await harness.runTool({ action: "update", status: "complete" });
    const created = (await harness.runTool({
      action: "create",
      objective: "second goal",
    })) as { details: Record<string, unknown> };

    expect((created.details.goal as { objective?: string }).objective).toBe("second goal");
  });

  test("completing goal emits notify publish event", async () => {
    const harness = createGoalHarness();
    await harness.runCommand("on");

    await harness.runTool({ action: "create", objective: "ship it" });
    harness.entries.push({
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: assistantMessage("stop", { input: 5, output: 7 }),
    } as never);
    (
      harness.entries[harness.entries.length - 1] as { message: { content: string } }
    ).message.content = "Final shipped summary";
    await harness.runTool({ action: "update", status: "complete" });

    expect(
      harness.emittedEvents.find((event) => event.eventName === "notify:publish")?.data,
    ).toMatchObject({
      title: "Goal complete",
      message: "Final shipped summary",
      meta: {
        sourceExtension: "goal",
        eventName: "goal:complete",
      },
    });
  });

  test("command start queues continuation and persists entry", async () => {
    const harness = createGoalHarness();
    await harness.runCommand("ship it");

    expect(harness.activeTools.includes("goal")).toBe(true);
    expect(harness.snapshot().goal?.objective).toBe("ship it");
    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]?.message.details).toEqual({
      kind: "command_start",
      goalId: harness.snapshot().goal?.goalId,
    });
    expect(harness.entries.some((entry) => parseGoalCustomEntry(entry.data)?.kind === "set")).toBe(
      true,
    );
  });

  test("goal command reads objective from at-prefixed file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-goal-command-objective-"));
    const objectiveFile = join(directory, "objective.md");
    writeFileSync(objectiveFile, "ship from file\nwith exact content");
    const harness = createGoalHarness();

    await harness.runCommand(`@${objectiveFile}`);

    expect(harness.snapshot().goal?.objective).toBe("ship from file\nwith exact content");
  });

  test("goal command rejects oversized at-prefixed objective files", async () => {
    const notifications: Array<{ message: string; level?: string }> = [];
    const directory = mkdtempSync(join(tmpdir(), "agent-goal-command-objective-"));
    const objectiveFile = join(directory, "objective.md");
    writeFileSync(objectiveFile, "x".repeat(8001));
    const harness = createGoalHarness({
      notify: (message, level) => notifications.push({ message, level }),
    });

    await harness.runCommand(`@${objectiveFile}`);

    expect(harness.snapshot().goal).toBeNull();
    expect(notifications).toContainEqual({
      message: "Objective file content must be 8000 characters or fewer.",
      level: "error",
    });
  });

  test("completed turns account tokens and continue active goals", async () => {
    const harness = createGoalHarness();
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("stop", { input: 30, output: 12 }),
      toolResults: [],
    });

    expect(harness.snapshot().goal?.usage.tokensUsed).toBe(42);
    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]?.message.details).toEqual({
      kind: "continuation",
      goalId: harness.snapshot().goal?.goalId,
    });
  });

  test("aborted turns pause goals", async () => {
    const harness = createGoalHarness();
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("aborted", { input: 8, output: 2 }),
      toolResults: [],
    });

    expect(harness.snapshot().goal?.status).toBe("paused");
    expect(harness.sentMessages).toHaveLength(0);
  });

  test("completed turns keep accounting without enforcing token budgets", async () => {
    const harness = createGoalHarness();
    await harness.runCommand("on");
    const created = (await harness.runTool({ action: "create", objective: "ship it" })) as {
      details: Record<string, unknown>;
    };

    expect(created.details.goal).not.toHaveProperty("tokenBudget");

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("toolUse", { input: 8, output: 3 }),
      toolResults: [],
    });

    expect(harness.snapshot().goal?.status).toBe("active");
    expect(harness.snapshot().goal?.usage.tokensUsed).toBe(11);
    expect(harness.sentMessages).toHaveLength(0);

    await harness.emit("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "tool-call",
      toolName: "bash",
      args: {},
      result: {},
      isError: false,
    });

    expect(harness.sentMessages).toHaveLength(0);
  });

  test("stale queued continuation aborts before start", async () => {
    const harness = createGoalHarness();
    await harness.runCommand("ship it");
    const queued = harness.sentMessages[0];
    if (typeof queued?.message.content !== "string") {
      throw new Error("expected queued continuation content");
    }

    await harness.runTool({ action: "update", status: "complete" });
    const results = await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: queued.message.content,
      systemPrompt: "base prompt",
      systemPromptOptions: {},
    });

    const result = results[0] as { systemPrompt?: string } | undefined;
    expect(harness.abortCount).toBe(1);
    expect(result?.systemPrompt ?? "").toContain("stale");
  });

  test("agent end waits for idle before continuing", async () => {
    const harness = createGoalHarness({ idle: false, pendingMessages: true });
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [assistantMessage("stop", { input: 30, output: 12 })],
    });

    expect(harness.sentMessages).toHaveLength(0);
    harness.setIdle(true);
    harness.setPendingMessages(false);
    await waitForContinuationRetry();

    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]?.message.details).toEqual({
      kind: "continuation",
      goalId: harness.snapshot().goal?.goalId,
    });
  });

  test("does not continue while context usage is near limit", async () => {
    const harness = createGoalHarness({ contextUsagePercent: 100, contextUsageTokens: 1000 });
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("stop", { input: 30, output: 12 }),
      toolResults: [],
    });

    expect(harness.sentMessages).toHaveLength(0);
  });

  test("does not continue during compaction but resumes from session compact when usage is unknown", async () => {
    const harness = createGoalHarness({ contextUsagePercent: 100, contextUsageTokens: 1000 });
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("session_before_compact", { type: "session_before_compact" });
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [assistantMessage("stop", { input: 30, output: 12 })],
    });

    expect(harness.sentMessages).toHaveLength(0);

    harness.setContextUsage(null);
    await harness.emit("session_compact", {
      type: "session_compact",
      compactionEntry: {},
      fromExtension: false,
    });
    await waitForCompactionResume();

    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]?.message.details).toEqual({
      kind: "continuation",
      goalId: harness.snapshot().goal?.goalId,
    });
  });
});
