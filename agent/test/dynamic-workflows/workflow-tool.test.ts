import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  backgroundStartedText,
  createWorkflowTool,
} from "../../src/extensions/dynamic-workflows/workflow-tool.js";
import type { WorkflowManager } from "../../src/extensions/dynamic-workflows/workflow-manager.js";

test("backgroundStartedText tells the user it auto-continues and they can wait", () => {
  const text = backgroundStartedText("audit", "abc-123");
  assert.match(text, /audit/);
  assert.match(text, /abc-123/);
  // The key reassurance the user asked for.
  assert.match(text, /wait here/i);
  assert.match(text, /continues automatically|resume the conversation/i);
  // Still offers the non-blocking "go do other things" path and tracking.
  assert.match(text, /other things/i);
  assert.match(text, /\/workflows status abc-123/);
});

test("workflow tool accepts absolute scriptFile instead of inline script", async () => {
  const scriptFile = join(mkdtempSync(join(tmpdir(), "workflow-tool-")), "audit.workflow.js");
  const workflowScript = [
    "export const meta = { name: 'audit', description: 'Audit workflow' };",
    "export default async function main() {",
    "  await agent('audit code');",
    "  return { ok: true };",
    "}",
  ].join("\n");
  writeFileSync(scriptFile, workflowScript, "utf8");

  let startedScript: string | undefined;
  const manager = {
    setExtensionContext() {},
    startInBackground(script: string) {
      startedScript = script;
      return { runId: "run-file", promise: Promise.resolve({}) };
    },
  } as unknown as WorkflowManager;
  const tool = createWorkflowTool({ manager });

  const result = await tool.execute(
    "tool-call",
    { scriptFile, background: true },
    undefined,
    undefined,
    {} as ExtensionContext,
  );

  assert.equal(startedScript, workflowScript);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /run-file/);
});

test("workflow tool passes background execution limits to manager", async () => {
  const script = [
    "export const meta = { name: 'audit', description: 'Audit workflow' };",
    "await agent('audit code');",
  ].join("\n");

  let executionOptions: unknown;
  const manager = {
    setExtensionContext() {},
    startInBackground(_script: string, _args: unknown, exec: unknown) {
      executionOptions = exec;
      return { runId: "run-limits", promise: Promise.resolve({}) };
    },
  } as unknown as WorkflowManager;
  const tool = createWorkflowTool({ manager });

  await tool.execute(
    "tool-call",
    {
      script,
      background: true,
      maxAgents: 7,
      agentTimeoutMs: 21_600_000,
      subagentBackend: "process",
    },
    undefined,
    undefined,
    {} as ExtensionContext,
  );

  assert.deepEqual(executionOptions, {
    maxAgents: 7,
    agentTimeoutMs: 21_600_000,
    subagentBackend: "process",
  });
});

test("workflow tool requires exactly one script source", () => {
  const tool = createWorkflowTool();

  assert.throws(
    () => tool.prepareArguments?.({ script: "export const meta = {}", scriptFile: "/tmp/a.js" }),
    /Provide exactly one of `script` or `scriptFile`/i,
  );
  assert.throws(
    () => tool.prepareArguments?.({ scriptFile: "relative.js" }),
    /Use path like \/home\/coder\/project\/workflows\/audit\.workflow\.js/i,
  );
});
