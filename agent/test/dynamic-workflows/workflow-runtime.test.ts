import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { test } from "vitest";
import type { AgentUsage } from "../../src/extensions/dynamic-workflows/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../../src/extensions/dynamic-workflows/errors.js";
import { type JournalEntry, runWorkflow } from "../../src/extensions/dynamic-workflows/workflow.js";
import { SUBAGENT_STRUCTURED_OUTPUT_ENTRY } from "../../src/subagent-sdk/types.js";

/** Agent runner that counts real invocations and echoes a per-call result. */
function countingAgent() {
  const state = { calls: 0 };
  return {
    state,
    runner: {
      async run(prompt: string) {
        state.calls++;
        return `ran:${prompt}`;
      },
    },
  };
}

/** Minimal fake agent runner that reports a fixed usage via onUsage. */
function fakeAgent(usage: Partial<AgentUsage>, result: unknown = "ok") {
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

const twoAgentScript = `export const meta = { name: 'usage_demo', description: 'two agents' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

test("runWorkflow accumulates real per-agent usage", async () => {
  const result = await runWorkflow(twoAgentScript, {
    agent: fakeAgent({ input: 100, output: 40, total: 140, cost: 0.002 }),
    persistLogs: false,
  });

  assert.equal(result.agentCount, 2);
  assert.equal(result.tokenUsage?.input, 200);
  assert.equal(result.tokenUsage?.output, 80);
  assert.equal(result.tokenUsage?.total, 280);
  assert.ok(Math.abs((result.tokenUsage?.cost ?? 0) - 0.004) < 1e-9);
});

test("runWorkflow falls back to an estimate when provider reports total === 0", async () => {
  const result = await runWorkflow(twoAgentScript, {
    agent: fakeAgent({ total: 0 }, "a result string"),
    persistLogs: false,
  });

  // No real usage -> input/output stay 0, but total is a positive estimate.
  assert.equal(result.tokenUsage?.input, 0);
  assert.equal(result.tokenUsage?.output, 0);
  assert.ok((result.tokenUsage?.total ?? 0) > 0, "estimate should be positive");
  assert.equal(result.tokenUsage?.cost, 0);
});

test("runWorkflow routes modes: explicit opts.mode > phase mode > default", async () => {
  const seen: Array<string | undefined> = [];
  const capturingAgent = {
    async run(_prompt: string, options: { mode?: string; onUsage?: (u: AgentUsage) => void }) {
      seen.push(options.mode);
      return "ok";
    },
  };

  const script = `export const meta = {
    name: 'routing', description: 'mode routing',
    phases: [{ title: 'A', mode: 'search' }, { title: 'B' }]
  }
  phase('A')
  await agent('explicit wins', { label: 'e', mode: 'review' })
  await agent('phase routed', { label: 'p' })
  phase('B')
  await agent('no mode -> default', { label: 'n' })
  return {}`;

  await runWorkflow(script, { agent: capturingAgent, persistLogs: false });

  assert.deepEqual(seen, ["review", "search", undefined]);
});

const resumeScript = `export const meta = { name: 'resume_demo', description: 'resume' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

test("resume replays cached results without re-running agents", async () => {
  // First run: capture the journal.
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  const r1 = await runWorkflow(resumeScript, {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 2);
  const completedJournal = journal.filter((entry) => entry.status === "completed");
  assert.equal(completedJournal.length, 2);
  assert.deepEqual(
    completedJournal.map((e) => e.index),
    [0, 1],
  );

  // Resume: same script, all calls cached -> agent runner never invoked.
  const second = countingAgent();
  const r2 = await runWorkflow(resumeScript, {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 0, "no live runs on a full cache hit");
  // Compare by value: results are created in separate vm realms, so deepStrictEqual
  // would reject them on prototype identity alone.
  assert.equal(JSON.stringify(r2.result), JSON.stringify(r1.result));
});

test("resume re-runs only the changed call (hash mismatch)", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(resumeScript, {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });

  // Edit the second agent's prompt; its hash changes, so only it re-runs.
  const editedScript = resumeScript.replace("'second'", "'second-edited'");
  const second = countingAgent();
  await runWorkflow(editedScript, {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 1, "only the edited call re-runs");
});

test("resume retries retryable failed agents using the persisted child session", async () => {
  const script = `export const meta = { name: 'retry_failed', description: 'retry failed' }
const a = await agent('first', { label: 'a' })
return { a }`;
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    persistLogs: false,
    agent: {
      async run(
        _prompt: string,
        options: { onStart?: (state: { sessionId: string; sessionPath: string }) => void },
      ) {
        options.onStart?.({ sessionId: "session-a", sessionPath: "/tmp/session-a.jsonl" });
        throw new Error("Network connection lost.");
      },
    },
    onAgentJournal: (entry) => journal.push(entry),
  });

  const failed = journal.find((entry) => entry.status === "failed");
  assert.equal(failed?.retryable, true);

  let resumeSession: { sessionId: string; sessionPath: string } | undefined;
  const result = await runWorkflow<{ a: string }>(script, {
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    agent: {
      async run(
        _prompt: string,
        options: { resumeSession?: { sessionId: string; sessionPath: string } },
      ) {
        resumeSession = options.resumeSession;
        return "resumed";
      },
    },
  });

  assert.deepEqual(resumeSession, { sessionId: "session-a", sessionPath: "/tmp/session-a.jsonl" });
  assert.equal(result.result.a, "resumed");
});

test("resume retries transient Node transport errors", async () => {
  const script = `export const meta = { name: 'retry_transport', description: 'retry transport' }
const a = await agent('first', { label: 'a' })
return { a }`;
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    persistLogs: false,
    agent: {
      async run(
        _prompt: string,
        options: { onStart?: (state: { sessionId: string; sessionPath: string }) => void },
      ) {
        options.onStart?.({ sessionId: "session-a", sessionPath: "/tmp/session-a.jsonl" });
        throw new Error("read ECONNRESET");
      },
    },
    onAgentJournal: (entry) => journal.push(entry),
  });

  const failed = journal.find((entry) => entry.status === "failed");
  assert.equal(failed?.retryable, true);

  let resumeSession: { sessionId: string; sessionPath: string } | undefined;
  const result = await runWorkflow<{ a: string }>(script, {
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    agent: {
      async run(
        _prompt: string,
        options: { resumeSession?: { sessionId: string; sessionPath: string } },
      ) {
        resumeSession = options.resumeSession;
        return "resumed";
      },
    },
  });

  assert.deepEqual(resumeSession, { sessionId: "session-a", sessionPath: "/tmp/session-a.jsonl" });
  assert.equal(result.result.a, "resumed");
});

test("resume starts worktree isolated retryable agents without child session", async () => {
  const script = `export const meta = { name: 'retry_worktree', description: 'retry worktree' }
const a = await agent('first', { label: 'a', isolation: 'worktree' })
return { a }`;
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    persistLogs: false,
    agent: {
      async run(
        _prompt: string,
        options: { onStart?: (state: { sessionId: string; sessionPath: string }) => void },
      ) {
        options.onStart?.({ sessionId: "session-a", sessionPath: "/tmp/session-a.jsonl" });
        throw new Error("Network connection lost.");
      },
    },
    onAgentJournal: (entry) => journal.push(entry),
  });

  const failed = journal.find((entry) => entry.status === "failed");
  assert.equal(failed?.retryable, true);

  let resumeSession: { sessionId: string; sessionPath: string } | undefined;
  const result = await runWorkflow<{ a: string }>(script, {
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    agent: {
      async run(
        _prompt: string,
        options: { resumeSession?: { sessionId: string; sessionPath: string } },
      ) {
        resumeSession = options.resumeSession;
        return "started fresh";
      },
    },
  });

  assert.equal(resumeSession, undefined);
  assert.equal(result.result.a, "started fresh");
});

test("resume replays cached non-retryable failed agents as null", async () => {
  const script = `export const meta = { name: 'skip_failed', description: 'skip failed' }
const a = await agent('first', { label: 'a' })
return { a }`;
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    persistLogs: false,
    agent: {
      async run() {
        throw new Error("logic failed");
      },
    },
    onAgentJournal: (entry) => journal.push(entry),
  });

  const failed = journal.find((entry) => entry.status === "failed");
  assert.equal(failed?.retryable, false);

  const starts: string[] = [];
  const ends: unknown[] = [];
  const result = await runWorkflow<{ a: null }>(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    onAgentStart: (event) => starts.push(event.label),
    onAgentEnd: (event) => ends.push(event.result),
  });

  assert.deepEqual(starts, ["a"]);
  assert.deepEqual(ends, [null]);
  assert.equal(result.result.a, null);
});

test("resume rethrows cached fatal failed agents", async () => {
  const script = `export const meta = { name: 'fatal_failed', description: 'fatal failed' }
const a = await agent('first', { label: 'a' })
return { a }`;
  const journal: JournalEntry[] = [];
  await assert.rejects(
    runWorkflow(script, {
      persistLogs: false,
      agent: {
        async run() {
          throw new WorkflowError("fatal budget", WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED, {
            recoverable: false,
          });
        },
      },
      onAgentJournal: (entry) => journal.push(entry),
    }),
    /fatal budget/,
  );

  const failed = journal.find((entry) => entry.status === "failed");
  assert.equal(failed?.retryable, false);
  assert.equal(failed?.recoverable, false);
  assert.equal(failed?.code, WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED);
  let liveCalls = 0;

  await assert.rejects(
    runWorkflow(script, {
      persistLogs: false,
      resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
      agent: {
        async run() {
          liveCalls++;
          return "live";
        },
      },
    }),
    /fatal budget/,
  );
  assert.equal(liveCalls, 0);
});

test("resume preserves prior recoverable failure when later call was interrupted", async () => {
  const script = `export const meta = { name: 'resume_failed_prefix', description: 'resume failed prefix' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;
  const journal: JournalEntry[] = [];
  const controller = new AbortController();
  await assert.rejects(
    runWorkflow(script, {
      persistLogs: false,
      signal: controller.signal,
      agent: {
        async run(
          prompt: string,
          options: { onStart?: (state: { sessionId: string; sessionPath: string }) => void },
        ) {
          if (prompt === "first") throw new Error("logic failed");
          options.onStart?.({ sessionId: "session-b", sessionPath: "/tmp/session-b.jsonl" });
          controller.abort();
          throw new Error("Cancelled");
        },
      },
      onAgentJournal: (entry) => journal.push(entry),
    }),
    /Cancelled/,
  );

  const firstFailure = journal.find((entry) => entry.index === 0 && entry.status === "failed");
  const secondStarted = journal.find((entry) => entry.index === 1 && entry.status === "started");
  assert.equal(firstFailure?.retryable, false);
  assert.equal(secondStarted?.sessionId, "session-b");

  const liveCalls: string[] = [];
  let resumeSession: { sessionId: string; sessionPath: string } | undefined;
  const result = await runWorkflow<{ a: null; b: string }>(script, {
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    agent: {
      async run(
        prompt: string,
        options: { resumeSession?: { sessionId: string; sessionPath: string } },
      ) {
        liveCalls.push(prompt);
        resumeSession = options.resumeSession;
        return "resumed second";
      },
    },
  });

  assert.deepEqual(liveCalls, ["second"]);
  assert.deepEqual(resumeSession, { sessionId: "session-b", sessionPath: "/tmp/session-b.jsonl" });
  assert.equal(result.result.a, null);
  assert.equal(result.result.b, "resumed second");
});

test("resume replays completed text from a started child session", async () => {
  const script = `export const meta = { name: 'resume_started_text', description: 'resume started text' }
const a = await agent('first', { label: 'a' })
return { a }`;
  const cwd = mkdtempSync(join(tmpdir(), "workflow-started-text-"));
  const sessionPath = writeAssistantTextSession(cwd, "session-a", "already done");
  const journal: JournalEntry[] = [];
  const controller = new AbortController();

  try {
    await assert.rejects(
      runWorkflow(script, {
        persistLogs: false,
        signal: controller.signal,
        agent: {
          async run(
            _prompt: string,
            options: { onStart?: (state: { sessionId: string; sessionPath: string }) => void },
          ) {
            options.onStart?.({ sessionId: "session-a", sessionPath });
            controller.abort();
            throw new Error("Cancelled");
          },
        },
        onAgentJournal: (entry) => journal.push(entry),
      }),
      /Cancelled/,
    );

    let liveCalls = 0;
    const replayedJournal: JournalEntry[] = [];
    const result = await runWorkflow<{ a: string }>(script, {
      persistLogs: false,
      resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
      agent: {
        async run() {
          liveCalls++;
          return "live";
        },
      },
      onAgentJournal: (entry) => replayedJournal.push(entry),
    });

    assert.equal(liveCalls, 0);
    assert.equal(result.result.a, "already done");
    assert.equal(replayedJournal.at(-1)?.status, "completed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resume replays completed structured output from a started child session", async () => {
  const schema = Type.Object({ answer: Type.String() });
  const script = `export const meta = { name: 'resume_started_structured', description: 'resume started structured' }
const a = await agent('first', { label: 'a', schema: args.schema })
return { a }`;
  const cwd = mkdtempSync(join(tmpdir(), "workflow-started-structured-"));
  const sessionPath = writeStructuredSession(cwd, "session-a", { answer: "already structured" });
  const journal: JournalEntry[] = [];
  const controller = new AbortController();
  try {
    await assert.rejects(
      runWorkflow(script, {
        args: { schema },
        persistLogs: false,
        signal: controller.signal,
        agent: {
          async run(
            _prompt: string,
            options: { onStart?: (state: { sessionId: string; sessionPath: string }) => void },
          ) {
            options.onStart?.({ sessionId: "session-a", sessionPath });
            controller.abort();
            throw new Error("Cancelled");
          },
        },
        onAgentJournal: (entry) => journal.push(entry),
      }),
      /Cancelled/,
    );

    let liveCalls = 0;
    const result = await runWorkflow<{ a: { answer: string } }>(script, {
      args: { schema },
      persistLogs: false,
      resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
      agent: {
        async run() {
          liveCalls++;
          return { answer: "live" };
        },
      },
    });

    assert.equal(liveCalls, 0);
    assert.deepEqual(result.result.a, { answer: "already structured" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("timeout failures do not persist child session refs for resume", async () => {
  const script = `export const meta = { name: 'timeout_session_ref', description: 'timeout session ref' }
const a = await agent('first', { label: 'a', timeoutMs: 1 })
return { a }`;
  const journal: JournalEntry[] = [];

  await runWorkflow(script, {
    persistLogs: false,
    agent: {
      run(
        _prompt: string,
        options: { onStart?: (state: { sessionId: string; sessionPath: string }) => void },
      ) {
        options.onStart?.({ sessionId: "session-a", sessionPath: "/tmp/session-a.jsonl" });
        return new Promise(() => {});
      },
    },
    onAgentJournal: (entry) => journal.push(entry),
  });

  const failed = journal.find((entry) => entry.status === "failed");
  assert.equal(failed?.retryable, true);
  assert.equal(failed?.sessionId, undefined);
  assert.equal(failed?.sessionPath, undefined);

  let resumeSession: { sessionId: string; sessionPath: string } | undefined;
  const result = await runWorkflow<{ a: string }>(script, {
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
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

  assert.equal(resumeSession, undefined);
  assert.equal(result.result.a, "fresh");
});

test("callSeq is deterministic under parallel()", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'par', description: 'parallel order' }
  const xs = await parallel(['p0','p1','p2'].map((p) => () => agent(p, { label: p })))
  return xs`;
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  const completedJournal = journal.filter((entry) => entry.status === "completed");
  assert.deepEqual(
    completedJournal.map((e) => e.index).sort((a, b) => a - b),
    [0, 1, 2],
  );
});

test("workflow() runs a nested saved workflow and shares the global agent counter", async () => {
  const child = `export const meta = { name: 'child', description: 'c' }
const r = await agent('child task', { label: 'c' })
return { child: r }`;
  const parent = `export const meta = { name: 'parent', description: 'p' }
const a = await agent('parent task', { label: 'p' })
const nested = await workflow('child', { foo: 1 })
return { a, nested }`;

  const result = await runWorkflow<{ a: string; nested: { child: string } }>(parent, {
    agent: countingAgent().runner,
    persistLogs: false,
    loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
  });

  // Parent agent + child agent both counted on the shared counter.
  assert.equal(result.agentCount, 2);
  assert.equal(result.result.nested.child, "ran:child task");
});

test("workflow() nesting is one level deep (second level throws)", async () => {
  const map: Record<string, string> = {
    gc: `export const meta = { name: 'gc', description: 'g' }
await agent('gc', { label: 'g' })
return 1`,
    child: `export const meta = { name: 'child', description: 'c' }
await workflow('gc')
return 2`,
  };
  const parent = `export const meta = { name: 'parent', description: 'p' }
let err = null
try { await workflow('child') } catch (e) { err = String(e && e.message || e) }
return { err }`;

  const result = await runWorkflow<{ err: string }>(parent, {
    agent: countingAgent().runner,
    persistLogs: false,
    loadSavedWorkflow: (name) => map[name],
  });
  assert.match(result.result.err, /one level deep/);
});

test("runWorkflow budget gates on accumulated tokens", async () => {
  // Each agent reports 100 tokens; a 100 budget allows one then exhausts
  // (the next agent sees remaining() === 0 at start and throws).
  const script = `export const meta = { name: 'budget_demo', description: 'budget' }
const a = await agent('first', { label: 'a' })
let second = null
try { second = await agent('second', { label: 'b' }) } catch (e) { second = 'blocked' }
return { a, second }`;

  const result = await runWorkflow<{ a: unknown; second: unknown }>(script, {
    agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
    tokenBudget: 100,
    persistLogs: false,
  });

  assert.equal(result.result.second, "blocked");
});

test("runWorkflow does not persist empty log files", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-empty-logs-"));
  try {
    const runId = "empty-logs";
    await runWorkflow(
      `export const meta = { name: 'empty_logs', description: 'empty logs' }
return 1`,
      {
        cwd,
        runId,
        persistLogs: true,
      },
    );

    assert.equal(existsSync(join(cwd, ".pi/workflows/runs", `${runId}.log`)), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runWorkflow persists user logs without adding persistence notice", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-user-logs-"));
  try {
    const runId = "user-logs";
    await runWorkflow(
      `export const meta = { name: 'user_logs', description: 'user logs' }
log('hello from workflow')
return 1`,
      {
        cwd,
        runId,
        persistLogs: true,
      },
    );

    const text = readFileSync(join(cwd, ".pi/workflows/runs", `${runId}.log`), "utf-8");
    assert.match(text, /hello from workflow/);
    assert.doesNotMatch(text, /Logs persisted to/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function writeAssistantTextSession(cwd: string, sessionId: string, text: string): string {
  const sessionPath = join(cwd, `${sessionId}.jsonl`);
  writeSessionEntries(cwd, sessionId, sessionPath, [
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-06-03T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Do work" }] },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-06-03T00:00:00.000Z",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text }],
      },
    },
  ]);
  return sessionPath;
}

function writeStructuredSession(cwd: string, sessionId: string, structured: unknown): string {
  const sessionPath = join(cwd, `${sessionId}.jsonl`);
  writeSessionEntries(cwd, sessionId, sessionPath, [
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-06-03T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Do work" }] },
    },
    {
      type: "custom",
      id: "s1",
      parentId: "u1",
      timestamp: "2026-06-03T00:00:00.000Z",
      customType: SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
      data: {
        status: "captured",
        attempts: 0,
        retryCount: 3,
        structured,
        updatedAt: 0,
      },
    },
  ]);
  return sessionPath;
}

function writeSessionEntries(
  cwd: string,
  sessionId: string,
  sessionPath: string,
  entries: Array<Record<string, unknown>>,
): void {
  const timestamp = "2026-06-03T00:00:00.000Z";
  const header = { type: "session", version: 3, id: sessionId, timestamp, cwd };
  writeFileSync(
    sessionPath,
    [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8",
  );
}
