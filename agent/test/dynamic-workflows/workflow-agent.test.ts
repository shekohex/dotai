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

vi.mock("../../src/subagent-sdk/sdk.js", () => ({
  createSubagentSDK: vi.fn(() => ({
    start: sdkStart,
    resume: sdkResume,
    dispose: sdkDispose,
    onChildEvent: vi.fn(() => () => {}),
  })),
}));

const cleanupPaths: string[] = [];

beforeEach(() => {
  sdkStart.mockReset();
  sdkResume.mockReset();
  sdkDispose.mockReset();
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
