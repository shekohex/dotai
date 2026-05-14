import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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

function createGoalHarness(
  options: {
    idle?: boolean;
    pendingMessages?: boolean;
    confirm?: boolean;
    contextUsagePercent?: number | null;
    contextUsageTokens?: number | null;
    contextWindow?: number;
  } = {},
) {
  const entries: ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]> = [];
  const handlers = new Map<string, GoalEventHandler[]>();
  const sentMessages: SentGoalMessage[] = [];
  const emittedEvents: Array<{ eventName: string; data: unknown }> = [];
  const tools = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
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
    getActiveTools: () => [],
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
      tools.set(tool.name, (params) =>
        tool.execute("tool-call", params as never, undefined, undefined, ctx),
      );
    },
    sendMessage(message, messageOptions) {
      sentMessages.push({ message, options: messageOptions });
    },
    sendUserMessage() {},
    setActiveTools() {},
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
    notify() {},
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
  };
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

describe("goal extension", () => {
  test("bundled definitions include goal extension", () => {
    expect(groupedExtensionsC.some((definition) => definition.id === "goal")).toBe(true);
  });

  test("goal tool supports get create and update actions", async () => {
    const harness = createGoalHarness();

    const created = (await harness.runTool({
      action: "create",
      objective: "ship it",
      token_budget: 20,
    })) as { details: Record<string, unknown>; content: Array<{ text: string }> };

    expect((created.details.goal as { objective?: string }).objective).toBe("ship it");
    expect((created.details.goal as { tokenBudget?: number }).tokenBudget).toBe(20);

    const got = (await harness.runTool({ action: "get" })) as { details: Record<string, unknown> };
    expect((got.details.goal as { objective?: string }).objective).toBe("ship it");

    const completed = (await harness.runTool({ action: "update", status: "complete" })) as {
      details: Record<string, unknown>;
    };
    expect(String(completed.details.completionBudgetReport)).toMatch(
      /^Goal achieved\. Report final budget usage to the user:/,
    );
  });

  test("goal tool can create new goal after previous goal is complete", async () => {
    const harness = createGoalHarness();

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

    await harness.runTool({ action: "create", objective: "ship it", token_budget: 10 });
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
      message:
        "Final shipped summary\n\nGoal achieved. Report final budget usage to the user: tokens used: 0 of 10.",
      meta: {
        sourceExtension: "goal",
        eventName: "goal:complete",
      },
    });
  });

  test("command start queues continuation and persists entry", async () => {
    const harness = createGoalHarness();
    await harness.runCommand("ship it");

    expect(harness.snapshot().goal?.objective).toBe("ship it");
    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]?.message.details).toEqual({
      kind: "command_start",
      goalId: harness.snapshot().goal?.goalId,
    });
    expect(parseGoalCustomEntry(harness.entries[0]?.data)?.kind).toBe("set");
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

  test("budget crossing sends one hidden steering message", async () => {
    const harness = createGoalHarness();
    await harness.runTool({ action: "create", objective: "ship it", token_budget: 10 });

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("toolUse", { input: 8, output: 3 }),
      toolResults: [],
    });

    expect(harness.snapshot().goal?.status).toBe("budgetLimited");
    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]?.message.details).toEqual({
      kind: "budget_limit",
      goalId: harness.snapshot().goal?.goalId,
    });
    expect(
      harness.emittedEvents.find((event) => event.eventName === "notify:publish")?.data,
    ).toMatchObject({
      title: "Goal unmet",
      message: "Goal budget exhausted\n\nGoal unmet. tokens used: 11 of 10.",
      tags: ["goal", "unmet", "budget"],
      meta: {
        sourceExtension: "goal",
        eventName: "goal:budget_exhausted",
      },
    });

    await harness.emit("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "tool-call",
      toolName: "bash",
      args: {},
      result: {},
      isError: false,
    });

    expect(harness.sentMessages).toHaveLength(1);
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

  test("does not continue during compaction but resumes after compaction when usage is unknown", async () => {
    const harness = createGoalHarness({ contextUsagePercent: 100, contextUsageTokens: 1000 });
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("session_before_compact", { type: "session_before_compact" });
    await harness.emit("compaction_start", { type: "compaction_start", reason: "overflow" });
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
    await harness.emit("compaction_end", {
      type: "compaction_end",
      reason: "overflow",
      aborted: false,
      willRetry: false,
    });

    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]?.message.details).toEqual({
      kind: "continuation",
      goalId: harness.snapshot().goal?.goalId,
    });
  });
});
