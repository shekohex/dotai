import assert from "node:assert/strict";
import { test } from "vitest";
import {
  keyToAction,
  NavigatorModel,
  NavigatorState,
  renderNavigator,
} from "../../src/extensions/dynamic-workflows/workflow-ui.js";

/** Fake manager exposing one running run with two phases. */
function fakeManager() {
  const snapshot = {
    name: "audit",
    phases: ["Scan", "Report"],
    currentPhase: "Report",
    logs: [],
    agents: [
      {
        id: 1,
        label: "scan a",
        phase: "Scan",
        prompt: "scan the code",
        status: "done",
        resultPreview: "found 2",
        tokens: 100,
      },
      {
        id: 2,
        label: "scan b",
        phase: "Scan",
        prompt: "scan more",
        status: "done",
        resultPreview: "found 1",
        tokens: 50,
      },
      {
        id: 3,
        label: "write report",
        phase: "Report",
        prompt: "write it",
        status: "running",
        tokens: 0,
      },
    ],
    agentCount: 3,
    runningCount: 1,
    doneCount: 2,
    errorCount: 0,
    tokenUsage: { input: 100, output: 50, total: 150, cost: 0 },
  };
  return {
    listRuns: () => [
      {
        runId: "run-1",
        workflowName: "audit",
        status: "running",
        phases: ["Scan", "Report"],
        agents: snapshot.agents,
        logs: [],
        tokenUsage: snapshot.tokenUsage,
      },
    ],
    getRun: (id: string) =>
      id === "run-1" ? { runId: "run-1", status: "running", snapshot } : undefined,
  } as any;
}

test("NavigatorModel reads runs, phases, agents, and detail", () => {
  const model = new NavigatorModel(fakeManager());
  const runs = model.runs();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].done, 2);
  assert.equal(runs[0].total, 3);
  assert.equal(runs[0].tokens, 150);

  const phases = model.phases("run-1");
  assert.deepEqual(
    phases.map((p) => p.title),
    ["Scan", "Report"],
  );
  assert.equal(phases[0].total, 2);
  assert.equal(phases[0].tokens, 150);

  const agents = model.agents("run-1", "Scan");
  assert.deepEqual(
    agents.map((a) => a.label),
    ["scan a", "scan b"],
  );
  assert.equal(model.agentDetail("run-1", 3)?.label, "write report");
});

test("NavigatorState drills runs -> phases -> agents -> detail and back", () => {
  const model = new NavigatorModel(fakeManager());
  const state = new NavigatorState();
  assert.equal(state.kind, "runs");

  assert.ok(state.drill(model));
  assert.equal(state.kind, "phases");
  assert.equal(state.runId, "run-1");

  assert.ok(state.drill(model)); // into Scan phase
  assert.equal(state.kind, "agents");
  assert.equal(state.phase, "Scan");

  assert.ok(state.drill(model)); // into first agent
  assert.equal(state.kind, "detail");
  assert.equal(state.agentId, 1);

  assert.ok(state.back());
  assert.equal(state.kind, "agents");
  assert.ok(state.back());
  assert.ok(state.back());
  assert.equal(state.kind, "runs");
  assert.equal(state.back(), false, "back at top returns false (caller closes)");
});

test("NavigatorState cursor wraps and detail scroll clamps at 0", () => {
  const model = new NavigatorModel(fakeManager());
  const state = new NavigatorState();
  state.move(-1, 1); // single run, wraps to itself
  assert.equal(state.cursor, 0);

  state.drill(model);
  state.drill(model); // agents in Scan (2 items)
  state.move(1, 2);
  assert.equal(state.cursor, 1);
  state.move(1, 2); // wrap
  assert.equal(state.cursor, 0);

  state.drill(model); // detail
  state.move(-1, 0); // scroll up clamps
  assert.equal(state.scroll, 0);
  state.move(1, 0);
  assert.equal(state.scroll, 1);
});

test("keyToAction maps keys per view", () => {
  assert.deepEqual(keyToAction("up", "runs"), { type: "move", delta: -1 });
  assert.deepEqual(keyToAction("j", "agents"), { type: "move", delta: 1 });
  assert.deepEqual(keyToAction("enter", "runs"), { type: "drill" });
  assert.deepEqual(keyToAction("enter", "detail"), { type: "none" });
  assert.deepEqual(keyToAction("escape", "phases"), { type: "back" });
  assert.deepEqual(keyToAction("q", "runs"), { type: "close" });
  assert.deepEqual(keyToAction("p", "runs"), { type: "pause" });
  assert.deepEqual(keyToAction("x", "agents"), { type: "stop" });
  assert.deepEqual(keyToAction("s", "runs"), { type: "save" });
});

test("renderNavigator shows the selected row and a footer hint", () => {
  const model = new NavigatorModel(fakeManager());
  const state = new NavigatorState();
  const runsView = renderNavigator(state, model, 80).join("\n");
  assert.match(runsView, /Workflows/);
  assert.match(runsView, /❯ ◆ audit/); // selected run marked
  assert.match(runsView, /enter open/); // footer hint

  state.drill(model);
  state.drill(model); // agents
  const agentsView = renderNavigator(state, model, 80).join("\n");
  assert.match(agentsView, /audit › Scan/);
  assert.match(agentsView, /status\s+agent/);
  assert.match(agentsView, /❯\s+1\s+✓ done\s+scan a/);
  assert.match(agentsView, /Recent events/);

  state.drill(model); // detail
  const detailView = renderNavigator(state, model, 80).join("\n");
  assert.match(detailView, /Prompt/);
  assert.match(detailView, /scan the code/);
  assert.match(detailView, /j\/k scroll/);
});
