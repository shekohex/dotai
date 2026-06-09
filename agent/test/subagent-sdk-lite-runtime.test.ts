import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { Type } from "typebox";
import { createLiteSessionManager } from "../src/subagent-sdk/lite-session-manager.ts";
import { createLiteSessionResources } from "../src/subagent-sdk/lite-session-resources.ts";
import { buildLiteResumePrompt } from "../src/subagent-sdk/lite-resume-prompt.ts";
import { LiteRuntime } from "../src/subagent-sdk/lite-runtime.ts";
import { STRUCTURED_OUTPUT_TOOL_NAME } from "../src/subagent-sdk/bootstrap-core.ts";
import { createStructuredOutputTool } from "../src/subagent-sdk/bootstrap.ts";
import { readChildSessionOutcome } from "../src/subagent-sdk/persistence.ts";
import type { RuntimeSubagent } from "../src/subagent-sdk/types.ts";
import { createTempDir } from "./test-utils/temp-paths.ts";

const cleanupPaths: string[] = [];
const STALE_CONTEXT_ERROR_MESSAGE =
  "This extension ctx is stale after session replacement or reload.";

function createRuntimeSubagent(overrides: Partial<RuntimeSubagent>): RuntimeSubagent {
  return {
    event: "started",
    sessionId: "lite-session",
    sessionPath: "/tmp/lite-session.jsonl",
    persisted: true,
    parentSessionId: "parent-session",
    parentSessionPath: "/tmp/parent-session.jsonl",
    name: "lite-worker",
    mode: "worker",
    modeLabel: "worker",
    cwd: "/tmp/project",
    paneId: "lite",
    task: "Run lite task",
    handoff: false,
    autoExit: true,
    autoExitTimeoutMs: 30_000,
    autoExitTimeoutActive: false,
    status: "running",
    startedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })),
  );
});

test("createLiteSessionManager allocates persistent child session for persisted parent", async () => {
  const cwd = await createTempDir("agent-lite-runtime-cwd-");
  cleanupPaths.push(cwd);
  const parentSessionPath = path.join(cwd, "parent.jsonl");

  const { sessionManager, sessionPath, persisted } = createLiteSessionManager({
    cwd,
    sessionId: "child-session-id",
    parentSessionPath,
  });

  expect(persisted).toBe(true);
  expect(sessionPath).toBeDefined();
  expect(sessionManager.isPersisted()).toBe(true);
  expect(sessionManager.getSessionFile()).toBe(sessionPath);
  if (sessionPath === undefined) throw new Error("sessionPath missing");
  await expect(fs.access(sessionPath)).resolves.toBeUndefined();
});

test("createLiteSessionManager uses in-memory child session when parent is ephemeral", async () => {
  const cwd = await createTempDir("agent-lite-runtime-cwd-");
  cleanupPaths.push(cwd);

  const { sessionManager, sessionPath, persisted } = createLiteSessionManager({
    cwd,
    sessionId: "child-session-id",
  });

  expect(persisted).toBe(false);
  expect(sessionPath).toBeUndefined();
  expect(sessionManager.isPersisted()).toBe(false);
});

test("buildLiteResumePrompt includes task context", () => {
  expect(buildLiteResumePrompt("Return final JSON")).toBe(
    "Continue the task.\n\nTask:\n\nReturn final JSON",
  );
});

test("LiteRuntime resume fails when persisted sessionPath is missing", async () => {
  const cwd = await createTempDir("agent-lite-runtime-cwd-");
  cleanupPaths.push(cwd);
  const runtime = new LiteRuntime({} as never);

  await expect(
    runtime.resume(
      {
        sessionId: "missing-session",
        sessionPath: path.join(cwd, "missing.jsonl"),
        task: "Continue",
      },
      { cwd } as never,
    ),
  ).rejects.toThrow(/subagent resume failed: sessionPath is not accessible/u);
});

test("LiteRuntime restore routes state through subagent UI hooks", async () => {
  let renderedStateCount: number | undefined;
  const runtime = new LiteRuntime({} as never, {
    kind: "lite",
    hooks: {
      persistState() {
        return Promise.resolve();
      },
      persistMessage() {
        return Promise.resolve();
      },
      emitStatusMessage() {},
      renderWidget(_ctx, subagents) {
        renderedStateCount = subagents.length;
      },
      dispose() {
        renderedStateCount = -1;
      },
    },
  });

  await runtime.restore({
    cwd: "/tmp/lite-ui",
    hasUI: true,
    sessionManager: { getSessionId: () => "lite-ui-session" },
  } as never);
  expect(renderedStateCount).toBe(0);
  runtime.dispose();

  expect(renderedStateCount).toBe(-1);
});

test("LiteRuntime tool activity updates render live subagent widget", async () => {
  let renderedActivity: string | undefined;
  const runtime = new LiteRuntime({} as never, {
    kind: "lite",
    hooks: {
      persistState() {
        return Promise.resolve();
      },
      persistMessage() {
        return Promise.resolve();
      },
      emitStatusMessage() {},
      renderWidget(_ctx, subagents) {
        renderedActivity = subagents[0]?.activity?.label;
      },
    },
  });
  const harness = runtime as unknown as {
    states: Map<string, RuntimeSubagent>;
    handleSessionEvent(
      sessionId: string,
      event: { type: "tool_execution_start"; toolName: string },
    ): void;
  };
  harness.states.set("lite-session", createRuntimeSubagent({ sessionId: "lite-session" }));

  await runtime.restore({
    cwd: "/tmp/lite-ui",
    hasUI: true,
    sessionManager: { getSessionId: () => "lite-ui-session" },
  } as never);
  harness.handleSessionEvent("lite-session", { type: "tool_execution_start", toolName: "read" });

  expect(renderedActivity).toBe("read");
});

test("LiteRuntime renderWidget clears stale cached UI context", async () => {
  let renderedCount = 0;
  let sessionManagerAccessCount = 0;
  let contextStale = false;
  const runtime = new LiteRuntime({} as never, {
    kind: "lite",
    hooks: {
      persistState() {
        return Promise.resolve();
      },
      persistMessage() {
        return Promise.resolve();
      },
      emitStatusMessage() {},
      renderWidget() {
        renderedCount += 1;
      },
    },
  });
  const ctx = {
    cwd: "/tmp/lite-ui",
    hasUI: true,
    get sessionManager() {
      sessionManagerAccessCount += 1;
      if (contextStale) {
        throw new Error(STALE_CONTEXT_ERROR_MESSAGE);
      }
      return { getSessionId: () => "lite-ui-session" };
    },
  };

  await runtime.restore(ctx as never);
  contextStale = true;
  runtime.renderWidget();
  runtime.renderWidget();

  expect(renderedCount).toBe(1);
  expect(sessionManagerAccessCount).toBe(2);
});

test("lite StructuredOutput tool persists structured output to child session", async () => {
  const cwd = await createTempDir("agent-lite-structured-cwd-");
  const agentDir = await createTempDir("agent-lite-structured-agent-");
  cleanupPaths.push(cwd, agentDir);
  const parentSessionPath = path.join(cwd, "parent.jsonl");
  await fs.writeFile(parentSessionPath, "", "utf8");
  const { sessionManager, sessionPath } = createLiteSessionManager({
    cwd,
    sessionId: "child-session-id",
    parentSessionPath,
  });
  if (sessionPath === undefined) throw new Error("sessionPath missing");
  const structuredCapture: { value?: unknown } = {};

  const resources = await createLiteSessionResources({
    cwd,
    agentDir,
    mode: {
      modeName: "worker",
      spec: { tools: [], autoExit: true },
      tools: [],
      autoExit: true,
      tmuxTarget: "pane",
      cwd,
      systemPromptMode: "append",
    },
    params: {
      outputFormat: { type: "json_schema", schema: Type.Object({ answer: Type.String() }) },
    },
    sessionManager,
    structuredCapture,
  });
  const structuredOutputTool = resources.customTools.find(
    (tool) => tool.name === STRUCTURED_OUTPUT_TOOL_NAME,
  );
  if (structuredOutputTool === undefined) throw new Error("StructuredOutput tool missing");

  await structuredOutputTool.execute(
    "tool-call-id",
    { answer: "persisted" },
    undefined,
    undefined,
    { shutdown() {} } as never,
  );

  await expect(readChildSessionOutcome(sessionPath)).resolves.toMatchObject({
    failed: false,
    structured: { answer: "persisted" },
  });
});

test("lite StructuredOutput rejects invalid schema shape so runtime retries", async () => {
  const schema = Type.Object({ answer: Type.String() });
  const structuredCapture: { value?: unknown } = {};
  const structuredOutputTool = createStructuredOutputTool(schema, (params) => {
    structuredCapture.value = params;
  });
  const promptCalls: string[] = [];
  const runtime = new LiteRuntime({} as never, {
    kind: "lite",
    hooks: {
      persistState() {
        return Promise.resolve();
      },
      persistMessage() {
        return Promise.resolve();
      },
      emitStatusMessage() {},
      renderWidget() {},
    },
  });
  const sessionId = "lite-structured-retry";
  const state = createRuntimeSubagent({
    sessionId,
    outputFormat: { type: "json_schema", schema, retryCount: 2 },
  });
  const fakeSession = {
    async prompt(prompt: string) {
      promptCalls.push(prompt);
      await structuredOutputTool.execute(
        `tool-call-${promptCalls.length}`,
        promptCalls.length === 1 ? ({ answer: 123 } as never) : { answer: "ok" },
        undefined,
        undefined,
        { shutdown() {} } as never,
      );
    },
    getLastAssistantText() {
      return "done";
    },
    getSessionStats() {
      return {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      };
    },
    dispose() {},
  };
  const live = {
    session: fakeSession,
    unsubscribe() {},
    structuredCapture,
    abortController: new AbortController(),
  };
  const harness = runtime as unknown as {
    states: Map<string, RuntimeSubagent>;
    sessions: Map<string, typeof live>;
    runPromptWithStructuredRetries(
      sessionId: string,
      prompt: string,
      live: typeof live,
    ): Promise<void>;
    completeSession(sessionId: string, live: typeof live): Promise<void>;
  };
  harness.states.set(sessionId, state);
  harness.sessions.set(sessionId, live);

  await harness.runPromptWithStructuredRetries(sessionId, "initial", live);
  await harness.completeSession(sessionId, live);

  expect(promptCalls).toHaveLength(2);
  expect(promptCalls[1]).toMatch(/Retries left: 1/u);
  expect(harness.states.get(sessionId)).toMatchObject({
    status: "completed",
    structured: { answer: "ok" },
    structuredError: undefined,
  });
});
