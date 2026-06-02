import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { AgentUsage } from "../../src/extensions/dynamic-workflows/agent.js";
import { WorkflowManager } from "../../src/extensions/dynamic-workflows/workflow-manager.js";

/** Agent runner that reports fixed usage so token accounting is exercised. */
function fakeAgent(usage: Partial<AgentUsage> = {}, result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        ...usage,
      });
      return result;
    },
  };
}

const oneAgentScript = `export const meta = { name: 'tracked_demo', description: 'one agent' }
phase('Work')
const a = await agent('do it', { label: 'a' })
return { a }`;

/** Run each manager test in its own temp cwd so .pi/workflows/runs is isolated. */
function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-mgr-"));
    try {
      await fn(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

test(
  "runSync registers the run so /workflows (listRuns) can see it",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: fakeAgent({ input: 100, output: 40, total: 140 }),
    });

    // Regression guard for the reported bug: a foreground (sync) run was invisible
    // to the manager, so the navigator/task panel showed "no tasks".
    const events: string[] = [];
    for (const ev of ["agentStart", "agentEnd", "phase", "complete"]) {
      manager.on(ev, () => events.push(ev));
    }
    let progressCalls = 0;
    const result = await manager.runSync(oneAgentScript, undefined, {
      onProgress: () => {
        progressCalls++;
      },
    });

    assert.equal(result.agentCount, 1);
    assert.ok(progressCalls > 0, "onProgress should fire while the run executes");
    assert.ok(
      events.includes("agentStart") && events.includes("complete"),
      "manager emits live events",
    );

    const runs = manager.listRuns();
    assert.equal(runs.length, 1, "the sync run is persisted and listable");
    assert.equal(runs[0].workflowName, "tracked_demo");
    assert.equal(runs[0].status, "completed");
    assert.equal(runs[0].tokenUsage?.total, 140, "token usage is persisted for the navigator");
  }),
);

test(
  "runSync persists the run immediately (visible while still running)",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    let listedWhileRunning = 0;
    manager.on("agentStart", () => {
      listedWhileRunning = manager.listRuns().filter((r) => r.status === "running").length;
    });
    await manager.runSync(oneAgentScript);
    assert.equal(listedWhileRunning, 1, "the run shows as running in listRuns mid-flight");
  }),
);

test(
  "each agent's mode/main model is recorded for /workflows display",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: fakeAgent(),
      mainModel: "anthropic/claude-opus-4-8",
    });
    const script = `export const meta = { name: 'mode_demo', description: 'per-agent modes' }
const a = await agent('explore', { label: 'scan', mode: 'search' })
const b = await agent('reason', { label: 'judge' })
return { a, b }`;
    await manager.runSync(script);

    const run = manager.listRuns().find((r) => r.workflowName === "mode_demo");
    const byLabel = Object.fromEntries((run?.agents ?? []).map((a) => [a.label, a.model]));
    assert.equal(byLabel.scan, "search", "explicit per-agent mode is recorded");
    assert.equal(byLabel.judge, "anthropic/claude-opus-4-8", "default agent shows the main model");
  }),
);
