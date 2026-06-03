import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { AgentUsage } from "../../src/extensions/dynamic-workflows/agent.js";
import {
  mergeJournalEntry,
  WorkflowManager,
} from "../../src/extensions/dynamic-workflows/workflow-manager.js";
import { WorkflowErrorCode } from "../../src/extensions/dynamic-workflows/errors.js";
import type { JournalEntry } from "../../src/extensions/dynamic-workflows/workflow-journal.js";

/** Agent runner that reports fixed usage so token accounting is exercised. */
function fakeAgent(usage: Partial<AgentUsage> = {}, result: unknown = "ok") {
  return {
    async run(
      _prompt: string,
      options: {
        onStart?: (state: { sessionId: string; sessionPath?: string }) => void;
        onUsage?: (u: AgentUsage) => void;
      },
    ) {
      options.onStart?.({ sessionId: "session-a", sessionPath: "/tmp/session-a.jsonl" });
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

function abortableAgent() {
  return {
    run(_prompt: string, options: { signal?: AbortSignal }) {
      return new Promise<string>((resolve, reject) => {
        if (options.signal?.aborted === true) {
          reject(new Error("Cancelled"));
          return;
        }
        options.signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("Cancelled"));
          },
          { once: true },
        );
      });
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
  "runSync persists agent journal lifecycle with child session path",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    await manager.runSync(oneAgentScript);

    const run = manager.listRuns().find((entry) => entry.workflowName === "tracked_demo");
    assert.ok(run, "run is persisted");
    assert.equal(run.journal?.length, 1);
    assert.equal(run.journal?.[0]?.status, "completed");
    assert.equal(run.journal?.[0]?.label, "a");
    assert.equal(run.journal?.[0]?.sessionId, "session-a");
    assert.equal(run.journal?.[0]?.sessionPath, "/tmp/session-a.jsonl");
    assert.equal(run.journal?.[0]?.result, "ok");

    const persistedText = readFileSync(
      join(cwd, ".pi", "workflows", "runs", `${run.runId}.json`),
      "utf8",
    );
    assert.match(persistedText, /"sessionPath": "\/tmp\/session-a\.jsonl"/);
  }),
);

test(
  "listRuns preserves runs with legacy invalid journal entries",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const runsDir = join(cwd, ".pi", "workflows", "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, "legacy.json"),
      JSON.stringify({
        runId: "legacy",
        workflowName: "legacy_demo",
        script: oneAgentScript,
        status: "completed",
        phases: [],
        agents: [],
        logs: [],
        startedAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
        journal: [{ index: 0, hash: "old-hash", result: "ok" }],
      }),
    );

    const run = manager.listRuns().find((entry) => entry.runId === "legacy");

    assert.ok(run, "legacy run remains listable");
    assert.deepEqual(run.journal, []);
  }),
);

test("mergeJournalEntry preserves session metadata only for matching hashes", () => {
  const existing: JournalEntry = {
    index: 0,
    hash: "old-hash",
    label: "a",
    prompt: "old prompt",
    status: "started",
    sessionId: "old-session",
    sessionPath: "/tmp/old-session.jsonl",
  };
  const entry: JournalEntry = {
    index: 0,
    hash: "new-hash",
    label: "a",
    prompt: "new prompt",
    status: "completed",
    result: "ok",
    tokens: 0,
  };

  const merged = mergeJournalEntry(existing, entry);

  assert.equal(merged.hash, "new-hash");
  assert.equal(merged.sessionId, undefined);
  assert.equal(merged.sessionPath, undefined);
});

test("mergeJournalEntry does not inherit omitted failed session metadata", () => {
  const existing: JournalEntry = {
    index: 0,
    hash: "same-hash",
    label: "a",
    prompt: "prompt",
    status: "started",
    sessionId: "session-a",
    sessionPath: "/tmp/session-a.jsonl",
  };
  const entry: JournalEntry = {
    index: 0,
    hash: "same-hash",
    label: "a",
    prompt: "prompt",
    status: "failed",
    error: 'Agent "a" timed out after 1ms',
    retryable: true,
  };

  const merged = mergeJournalEntry(existing, entry);

  assert.equal(merged.sessionId, undefined);
  assert.equal(merged.sessionPath, undefined);
});

test(
  "runSync persists timeout failures without child session refs",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        run(
          _prompt: string,
          options: { onStart?: (state: { sessionId: string; sessionPath?: string }) => void },
        ) {
          options.onStart?.({ sessionId: "session-a", sessionPath: "/tmp/session-a.jsonl" });
          return new Promise(() => {});
        },
      },
    });

    await manager.runSync(oneAgentScript, undefined, { agentTimeoutMs: 1 });

    const run = manager.listRuns().find((entry) => entry.workflowName === "tracked_demo");
    assert.equal(run?.journal?.[0]?.status, "failed");
    assert.equal(run?.journal?.[0]?.sessionId, undefined);
    assert.equal(run?.journal?.[0]?.sessionPath, undefined);
  }),
);

test(
  "resume starts fresh after persisted timeout failure omits child session refs",
  withTempCwd(async (cwd) => {
    const runsDir = join(cwd, ".pi", "workflows", "runs");
    const runId = "timeout-resume";
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, `${runId}.json`),
      JSON.stringify({
        runId,
        workflowName: "tracked_demo",
        script: oneAgentScript,
        status: "failed",
        phases: [],
        agents: [],
        logs: [],
        startedAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
        journal: [
          {
            index: 0,
            hash: "9bd83d2e25aa68d7b6476d13d9980c7e252863562dc98f25f2201c9026cf1027",
            label: "a",
            prompt: "do it",
            status: "started",
            sessionId: "session-a",
            sessionPath: "/tmp/session-a.jsonl",
          },
          {
            index: 0,
            hash: "9bd83d2e25aa68d7b6476d13d9980c7e252863562dc98f25f2201c9026cf1027",
            label: "a",
            prompt: "do it",
            status: "failed",
            error: 'Agent "a" timed out after 1ms',
            retryable: true,
          },
        ],
      }),
    );
    let resumeSession: { sessionId: string; sessionPath: string } | undefined;
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(
          _prompt: string,
          options: { resumeSession?: { sessionId: string; sessionPath: string } },
        ) {
          resumeSession = options.resumeSession;
          return "fresh";
        },
      },
    });
    const completed = new Promise<void>((resolve) => manager.once("complete", () => resolve()));

    assert.equal(manager.resume(runId), true);
    await completed;

    const run = manager.listRuns().find((entry) => entry.runId === runId);
    assert.equal(resumeSession, undefined);
    assert.equal(run?.journal?.[0]?.status, "completed");
    assert.equal(run?.journal?.[0]?.result, "fresh");
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

test(
  "stopping a background workflow does not emit uncaught EventEmitter error",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: abortableAgent() });
    const { runId, promise } = manager.startInBackground(oneAgentScript);

    assert.equal(manager.stop(runId), true);
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: unknown }).code, WorkflowErrorCode.WORKFLOW_ABORTED);
      return true;
    });

    const run = manager.listRuns().find((entry) => entry.runId === runId);
    assert.equal(run?.status, "aborted");
  }),
);
