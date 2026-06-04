import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { Type } from "typebox";
import { createLiteSessionManager } from "../src/subagent-sdk/lite-session-manager.ts";
import { createLiteSessionResources } from "../src/subagent-sdk/lite-session-resources.ts";
import { buildLiteResumePrompt } from "../src/subagent-sdk/lite-resume-prompt.ts";
import { LiteRuntime } from "../src/subagent-sdk/lite-runtime.ts";
import { STRUCTURED_OUTPUT_TOOL_NAME } from "../src/subagent-sdk/bootstrap-core.ts";
import { readChildSessionOutcome } from "../src/subagent-sdk/persistence.ts";
import { createTempDir } from "./test-utils/temp-paths.ts";

const cleanupPaths: string[] = [];

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
    },
  });

  await runtime.restore({ cwd: "/tmp/lite-ui", hasUI: true } as never);

  expect(renderedStateCount).toBe(0);
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
