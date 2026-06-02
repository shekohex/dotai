import assert from "node:assert/strict";
import { test } from "vitest";
import {
  parseCommandArgs,
  registerAllSavedWorkflows,
  registerSavedWorkflow,
} from "../../src/extensions/dynamic-workflows/saved-commands.js";
import { registerWorkflowCommands } from "../../src/extensions/dynamic-workflows/workflow-commands.js";

test("parseCommandArgs splits key=value, collects positionals, applies defaults", () => {
  const parsed = parseCommandArgs("hello world topic=birds depth=2", {
    topic: { type: "string" },
    angles: { type: "number", default: 4 },
  });
  assert.equal(parsed.topic, "birds");
  assert.equal(parsed.depth, "2");
  assert.equal(parsed._, "hello world");
  assert.equal(parsed._raw, "hello world topic=birds depth=2");
  assert.equal(parsed.angles, 4); // default filled in
});

function fakePi() {
  const registered: string[] = [];
  const pi: any = {
    getCommands: () => registered.map((name) => ({ name })),
    registerCommand: (name: string) => registered.push(name),
    sendMessage: async () => {},
  };
  return { pi, registered };
}

test("registerSavedWorkflow registers a /<name> command", () => {
  const { pi, registered } = fakePi();
  registerSavedWorkflow(pi, process.cwd(), {
    name: "myflow",
    description: "demo",
    script: "export const meta = { name: 'x', description: 'y' }\nawait agent('hi')",
    location: "project",
    path: "/tmp/x.json",
    savedAt: "now",
  });
  assert.deepEqual(registered, ["myflow"]);
});

test("registerAllSavedWorkflows registers every saved workflow", () => {
  const { pi, registered } = fakePi();
  const storage: any = {
    list: () => [
      { name: "a", description: "", script: "", location: "project", path: "", savedAt: "" },
      { name: "b", description: "", script: "", location: "user", path: "", savedAt: "" },
    ],
  };
  registerAllSavedWorkflows(pi, process.cwd(), storage);
  assert.deepEqual(registered.sort(), ["a", "b"]);
});

test("/workflows save persists a run's script and registers it as a command", async () => {
  const { pi, registered } = fakePi();
  const notified: Array<{ message: string; type?: string }> = [];
  const saved: any[] = [];
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  pi.registerCommand = (name: string, opts: any) => {
    registered.push(name);
    if (name === "workflows") handler = opts.handler;
  };

  const manager: any = {
    listRuns: () => [
      { runId: "run-1", workflowName: "demo", status: "completed", script: "SCRIPT", agents: [] },
    ],
  };
  const storage: any = {
    save: (wf: any) => {
      saved.push(wf);
      return { ...wf, path: "/tmp/demo.json", savedAt: "now" };
    },
  };

  registerWorkflowCommands(pi, manager, { storage, cwd: process.cwd() });
  const ctx = {
    ui: { notify: (message: string, type?: string) => notified.push({ message, type }) },
  };
  assert.ok(handler, "workflows command registered");
  await handler("save myflow", ctx);

  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, "myflow");
  assert.equal(saved[0].script, "SCRIPT");
  assert.ok(registered.includes("myflow"), "new command registered");
  assert.match(notified.at(-1)?.message ?? "", /Saved \/myflow/);
});
