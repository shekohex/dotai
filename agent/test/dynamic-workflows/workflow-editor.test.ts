import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildForcedWorkflowPrompt,
  colorizeWorkflow,
  createWorkflowModeState,
  endsWithTrigger,
  hasTrigger,
  installWorkflowInputHooks,
  RAINBOW,
  tokenizeAnsi,
} from "../../src/extensions/dynamic-workflows/workflow-editor.js";

const CURSOR_MARKER = "\x1b_pi:c\x07";
// Built from escaped source so the regex literal carries no raw control bytes.
const ANSI_RE = new RegExp("\\u001b\\[[0-9;]*[A-Za-z]|\\u001b_[^\\u0007]*\\u0007", "g");
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

test("hasTrigger matches workflow/workflows anywhere, case-insensitive", () => {
  for (const t of ["run a workflow", "WORKFLOWS", "myworkflow", "the Workflow tool"]) {
    assert.equal(hasTrigger(t), true, t);
  }
  for (const t of ["workflo", "flow", "work", ""]) {
    assert.equal(hasTrigger(t), false, t);
  }
});

test("endsWithTrigger detects a trigger immediately before the cursor", () => {
  assert.equal(endsWithTrigger("please run workflow"), true);
  assert.equal(endsWithTrigger("workflows"), true);
  assert.equal(endsWithTrigger("workflow now"), false);
  assert.equal(endsWithTrigger("work"), false);
});

test("slash commands are excluded: /workflow(s) is not a trigger", () => {
  assert.equal(hasTrigger("/workflows"), false);
  assert.equal(hasTrigger("/workflow"), false);
  assert.equal(hasTrigger("run /workflows status"), false);
  // A real trigger elsewhere still counts even if a slash command is also present.
  assert.equal(hasTrigger("a workflow then /workflows"), true);
  // Backspace toggle must not fire right after a slash command.
  assert.equal(endsWithTrigger("/workflows"), false);
  assert.equal(endsWithTrigger("type /workflow"), false);
});

test("colorizeWorkflow skips a slash-prefixed /workflow but paints a bare one", () => {
  assert.equal(colorizeWorkflow("/workflows", 0), "/workflows", "slash command left plain");
  const out = colorizeWorkflow("a workflow and /workflow", 0);
  // Exactly one occurrence colored (the bare 'workflow', not the slash one).
  const colorRuns = out.match(new RegExp("\\u001b\\[38;5;\\d+m", "g")) ?? [];
  assert.equal(colorRuns.length, "workflow".length, "only the bare word is colored");
  assert.equal(stripAnsi(out), "a workflow and /workflow");
});

test("tokenizeAnsi keeps CSI and APC sequences as single escape tokens", () => {
  const line = `a\x1b[7mb\x1b[0m${CURSOR_MARKER}c`;
  const tokens = tokenizeAnsi(line);
  const escs = tokens.filter((t) => t.esc !== undefined).map((t) => t.esc);
  assert.deepEqual(escs, ["\x1b[7m", "\x1b[0m", CURSOR_MARKER]);
  const visible = tokens
    .filter((t) => t.ch !== undefined)
    .map((t) => t.ch)
    .join("");
  assert.equal(visible, "abc");
});

test("colorizeWorkflow paints the trigger and preserves visible text + escapes", () => {
  const input = `please run workflow now`;
  const out = colorizeWorkflow(input, 0);
  assert.match(out, new RegExp("\\u001b\\[38;5;\\d+m"), "applies a 256-color foreground");
  assert.equal(stripAnsi(out), input, "visible text is unchanged");
});

test("colorizeWorkflow leaves non-trigger lines untouched", () => {
  const input = "just some plain text";
  assert.equal(colorizeWorkflow(input, 3), input);
});

test("colorizeWorkflow does not corrupt the cursor escape or CURSOR_MARKER", () => {
  // Cursor sits on the 'f' of workflow: inverse-video around that grapheme.
  const input = `workflow ${CURSOR_MARKER}\x1b[7m \x1b[0m`;
  const out = colorizeWorkflow(input, 2);
  assert.ok(out.includes(CURSOR_MARKER), "marker survives");
  assert.ok(out.includes("\x1b[7m"), "inverse-video survives");
  assert.equal(stripAnsi(out), "workflow  ");
});

test("colorizeWorkflow flows: a tick shift changes the colors", () => {
  const a = colorizeWorkflow("workflow", 0);
  const b = colorizeWorkflow("workflow", 1);
  assert.notEqual(a, b);
  assert.ok(RAINBOW.length > 1);
});

test("buildForcedWorkflowPrompt forces the `workflow` tool and forbids alternatives", () => {
  const out = buildForcedWorkflowPrompt("audit the routes");
  assert.match(out, /audit the routes/);
  assert.match(out, /workflows mode/i);
  assert.match(out, /MUST/);
  assert.match(out, /tool named exactly `workflow`/);
  // Explicitly rules out the fallbacks the model wrongly used before.
  assert.match(out, /subagent/i);
  assert.match(out, /pi-subagents/i);
});

test("installWorkflowInputHooks restricts tools to `workflow` while armed, then restores", () => {
  const handlers: Record<string, (e: any) => any> = {};
  let activeTools = ["read", "bash", "workflow", "subagent"];
  const pi: any = {
    on: (event: string, handler: any) => {
      handlers[event] = handler;
    },
    getActiveTools: () => activeTools,
    setActiveTools: (t: string[]) => {
      activeTools = t;
    },
  };
  const state = createWorkflowModeState();
  installWorkflowInputHooks(pi, state);
  assert.equal(typeof handlers.input, "function", "registers an input hook");
  assert.equal(typeof handlers.turn_end, "function", "registers a turn_end hook");

  // Disarmed → passthrough, tools untouched.
  assert.deepEqual(handlers.input({ source: "interactive", text: "hi" }), { action: "continue" });
  assert.deepEqual(activeTools, ["read", "bash", "workflow", "subagent"]);

  // Armed → transform, consume the arm, and restrict tools to just `workflow`.
  state.active = true;
  const res = handlers.input({ source: "interactive", text: "do it" });
  assert.equal(res.action, "transform");
  assert.match(res.text, /do it/);
  assert.equal(state.active, false, "arm is consumed after submit");
  assert.deepEqual(
    activeTools,
    ["workflow"],
    "only the workflow tool is active during the forced turn",
  );

  // turn_end restores the user's full tool set.
  handlers.turn_end({});
  assert.deepEqual(
    activeTools,
    ["read", "bash", "workflow", "subagent"],
    "tools restored after the turn",
  );

  // Non-interactive sources are never transformed/restricted even if armed.
  state.active = true;
  assert.deepEqual(handlers.input({ source: "rpc", text: "workflow" }), { action: "continue" });
  assert.deepEqual(activeTools, ["read", "bash", "workflow", "subagent"]);
});

test("installWorkflowInputHooks does not restrict tools after conversation started", () => {
  const handlers: Record<string, (event: any, ctx?: any) => any> = {};
  let activeTools = ["read", "bash", "workflow", "subagent"];
  const pi: any = {
    on: (event: string, handler: any) => {
      handlers[event] = handler;
    },
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => {
      activeTools = tools;
    },
  };
  const ctx = {
    sessionManager: {
      getBranch: () => [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    },
  };
  const state = createWorkflowModeState();
  installWorkflowInputHooks(pi, state);

  state.active = true;
  assert.deepEqual(handlers.input({ source: "interactive", text: "use workflow here" }, ctx), {
    action: "continue",
  });
  assert.equal(state.active, false, "arm is consumed without transforming");
  assert.deepEqual(activeTools, ["read", "bash", "workflow", "subagent"]);
});

test("installWorkflowInputHooks does not transform when workflow tool is disabled", () => {
  const handlers: Record<string, (event: any, ctx?: any) => any> = {};
  let activeTools = ["read", "bash", "subagent"];
  const pi: any = {
    on: (event: string, handler: any) => {
      handlers[event] = handler;
    },
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => {
      activeTools = tools;
    },
  };
  const state = createWorkflowModeState();
  installWorkflowInputHooks(pi, state);

  state.active = true;
  assert.deepEqual(handlers.input({ source: "interactive", text: "use workflow here" }), {
    action: "continue",
  });
  assert.equal(state.active, false, "arm is consumed without transforming");
  assert.deepEqual(activeTools, ["read", "bash", "subagent"]);
});
