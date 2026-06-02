import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { AgentUsage } from "../../src/extensions/dynamic-workflows/agent.js";
import { type JournalEntry, runWorkflow } from "../../src/extensions/dynamic-workflows/workflow.js";

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
  assert.equal(journal.length, 2);
  assert.deepEqual(
    journal.map((e) => e.index),
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
  assert.deepEqual(
    journal.map((e) => e.index).sort((a, b) => a - b),
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
