import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { SubagentHandle, SubagentSDK } from "../../src/subagent-sdk/sdk-types.js";
import type { RuntimeSubagent } from "../../src/subagent-sdk/types.js";

const sdkStart = vi.fn<SubagentSDK["start"]>();
const sdkResume = vi.fn<SubagentSDK["resume"]>();
const sdkDispose = vi.fn<SubagentSDK["dispose"]>();
const sdkFactory = vi.fn();

vi.mock("../../src/subagent-sdk/sdk.js", () => ({
  createSubagentSDK: sdkFactory,
}));

const cleanupPaths: string[] = [];

beforeEach(() => {
  sdkStart.mockReset();
  sdkResume.mockReset();
  sdkDispose.mockReset();
  sdkFactory.mockReset();
  sdkFactory.mockReturnValue({
    start: sdkStart,
    resume: sdkResume,
    dispose: sdkDispose,
    onChildEvent: vi.fn(() => () => {}),
  });
});

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) rmSync(target, { recursive: true, force: true });
});

test("WorkflowAgent starts fresh when resume session file is missing", async () => {
  const { WorkflowAgent } = await import("../../src/extensions/dynamic-workflows/agent.js");
  sdkStart.mockResolvedValue(createStartValue("fresh-session", "fresh result"));
  const cwd = mkdtempSync(join(tmpdir(), "workflow-agent-missing-session-"));
  cleanupPaths.push(cwd);

  const result = await new WorkflowAgent({
    cwd,
    pi: {} as ExtensionAPI,
    ctx: createContext(cwd),
  }).run("prompt", {
    resumeSession: { sessionId: "old-session", sessionPath: join(cwd, "missing.jsonl") },
  });

  assert.equal(result, "fresh result");
  assert.equal(sdkResume.mock.calls.length, 0);
  assert.equal(sdkStart.mock.calls.length, 1);
});

test("WorkflowAgent falls back to start when resume session becomes inaccessible", async () => {
  const { WorkflowAgent } = await import("../../src/extensions/dynamic-workflows/agent.js");
  const cwd = mkdtempSync(join(tmpdir(), "workflow-agent-inaccessible-session-"));
  cleanupPaths.push(cwd);
  const sessionPath = join(cwd, "session.jsonl");
  sdkResume.mockRejectedValue(new Error("subagent resume failed: sessionPath is not accessible"));
  sdkStart.mockResolvedValue(createStartValue("fresh-session", "fresh result"));
  writeFileSync(sessionPath, "");

  const result = await new WorkflowAgent({
    cwd,
    pi: {} as ExtensionAPI,
    ctx: createContext(cwd),
  }).run("prompt", {
    resumeSession: { sessionId: "old-session", sessionPath },
  });

  assert.equal(result, "fresh result");
  assert.equal(sdkResume.mock.calls.length, 1);
  assert.equal(sdkStart.mock.calls.length, 1);
});

test("WorkflowAgent uses process subagent backend by default", async () => {
  const { WorkflowAgent } = await import("../../src/extensions/dynamic-workflows/agent.js");
  sdkStart.mockResolvedValue(createStartValue("process-session", "process result"));
  const cwd = mkdtempSync(join(tmpdir(), "workflow-agent-process-default-backend-"));
  cleanupPaths.push(cwd);

  await new WorkflowAgent({
    cwd,
    pi: { exec: async () => ({ code: 0, stdout: "", stderr: "" }) } as ExtensionAPI,
    ctx: createContext(cwd),
  }).run("prompt");

  const options = sdkFactory.mock.calls[0]?.[1];
  assert.equal("adapter" in options, true);
  assert.equal(typeof options.buildLaunchCommand, "function");
});

test("WorkflowAgent can use process subagent backend", async () => {
  const { WorkflowAgent } = await import("../../src/extensions/dynamic-workflows/agent.js");
  sdkStart.mockResolvedValue(createStartValue("process-session", "process result"));
  const cwd = mkdtempSync(join(tmpdir(), "workflow-agent-process-backend-"));
  cleanupPaths.push(cwd);

  await new WorkflowAgent({
    cwd,
    pi: { exec: async () => ({ code: 0, stdout: "", stderr: "" }) } as ExtensionAPI,
    ctx: createContext(cwd),
    subagentBackend: "process",
  }).run("prompt");

  const options = sdkFactory.mock.calls[0]?.[1];
  assert.equal("adapter" in options, true);
  assert.equal(typeof options.buildLaunchCommand, "function");
});

test("WorkflowAgent reuses one SDK until disposed", async () => {
  const { WorkflowAgent } = await import("../../src/extensions/dynamic-workflows/agent.js");
  sdkStart.mockResolvedValueOnce(createStartValue("first-session", "first result"));
  sdkStart.mockResolvedValueOnce(createStartValue("second-session", "second result"));
  const cwd = mkdtempSync(join(tmpdir(), "workflow-agent-shared-sdk-"));
  cleanupPaths.push(cwd);

  const agent = new WorkflowAgent({
    cwd,
    pi: {} as ExtensionAPI,
    ctx: createContext(cwd),
  });

  assert.equal(await agent.run("first"), "first result");
  assert.equal(await agent.run("second"), "second result");
  assert.equal(sdkFactory.mock.calls.length, 1);
  assert.equal(sdkDispose.mock.calls.length, 0);

  agent.dispose();
  assert.equal(sdkDispose.mock.calls.length, 1);
});

function createStartValue(
  sessionId: string,
  result: string,
): Awaited<ReturnType<SubagentSDK["start"]>> {
  const state: RuntimeSubagent = {
    id: sessionId,
    name: "agent",
    task: "task",
    status: "completed",
    sessionId,
    modeLabel: "agent",
    summary: result,
  };
  const handle: SubagentHandle = {
    sessionId,
    getState: () => state,
    sendMessage: async () => ({ status: "sent", message: "" }),
    cancel: async () => state,
    waitForCompletion: async () => state,
    captureOutput: async () => ({ lines: [], text: "" }),
    onEvent: () => () => {},
    on: () => () => {},
  };
  return { handle, prompt: "prompt", state };
}

function createContext(cwd: string): ExtensionContext {
  return { cwd } as ExtensionContext;
}
