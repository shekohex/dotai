---
name: dynamic-workflows
description: >-
  Orchestrate multi-agent workflows using the `workflow` tool with
  fan-out/fan-in, adversarial verification, tournaments, and loops.
  Use when the user asks for workflows, multi-agent orchestration,
  fan-out, parallel subagents, dynamic workflows, or needs to
  decompose large tasks into coordinated subagent runs.
---

# Dynamic Workflows

The `workflow` tool runs a JavaScript harness that spawns and coordinates subagents via `agent()`, `parallel()`, and `pipeline()`. Each subagent gets its own context window and focused goal, combating agentic laziness, self-preferential bias, and goal drift.

## Quick Start

If the `workflow` tool is not available, ask the user to run `/workflow on` to enable it. Then call the tool with a raw JavaScript script:

```javascript
export const meta = {
  name: "verify_claims",
  description: "Verify every factual claim in a document",
  phases: [{ title: "Extract" }, { title: "Verify" }, { title: "Report" }],
};

phase("Extract");
const claims = await agent("List every factual claim...", {
  label: "extract claims",
  schema: {
    type: "object",
    properties: { claims: { type: "array", items: { type: "string" } } },
    required: ["claims"],
  },
});

phase("Verify");
const verified = await parallel(
  claims.claims.map(
    (c, i) => () => agent("Verify this claim against the codebase: " + c, { label: "verify " + i }),
  ),
);

phase("Report");
return { claims: claims.claims, verified };
```

Rules:

- First statement must be `export const meta = { name, description, phases }`
- Plain JavaScript only — no TypeScript, imports, `require()`, `Date.now()`, `Math.random()`, or `new Date()`
- `parallel()` takes **functions**, not promises: `parallel(items.map(item => () => agent(...)))`
- Every workflow must call `agent()` at least once
- Use `{ label: 'short name' }` on every `agent()` call

## Tool Parameters

| Parameter        | Type      | Description                                                                                |
| ---------------- | --------- | ------------------------------------------------------------------------------------------ |
| `script`         | `string`  | **Required.** Raw JavaScript workflow.                                                     |
| `args`           | `unknown` | Optional JSON value. Exposed inside the script as the global `args`.                       |
| `background`     | `boolean` | Default `true`. Returns immediately; result delivered when finished. Set `false` to block. |
| `maxAgents`      | `number`  | Max agents allowed. Default `1000`.                                                        |
| `agentTimeoutMs` | `number`  | Timeout per agent. Default `1800000` (30 min).                                             |

## Script Globals

| Global                                                     | Description                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `agent(prompt, opts)`                                      | Spawn a subagent. Returns its result.                                            |
| `parallel(thunks)`                                         | Run functions concurrently. Returns results in input order.                      |
| `pipeline(items, ...stages)`                               | Run each item through stages sequentially; different items may run concurrently. |
| `phase(title)`                                             | Set current phase for status display and mode routing.                           |
| `log(message)`                                             | Append to workflow logs.                                                         |
| `args`                                                     | Value passed via tool `args` parameter.                                          |
| `cwd` / `process.cwd()`                                    | Working directory.                                                               |
| `budget`                                                   | Read-only `{ total, spent(), remaining() }` for token budgets.                   |
| `workflow(name, args)`                                     | Run a saved workflow inline (nesting limited to one level).                      |
| `JSON`, `Math`, `Array`, `Object`, `Set`, `Map`, `Promise` | Standard JS utilities.                                                           |

## Agent Options

| Option             | Description                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `label`            | Short unique name (2–5 words) for status display.                                                          |
| `phase`            | Override current phase for this agent.                                                                     |
| `schema`           | Plain JSON Schema. Agent returns validated object.                                                         |
| `mode`             | Subagent mode name (e.g. `review`, `worker`). Omit for generic worker.                                     |
| `outputRetryCount` | Retries for structured output.                                                                             |
| `toolNames`        | Tools to expose to this agent.                                                                             |
| `isolation`        | `"worktree"` runs agent in a throwaway git worktree.                                                       |
| `agentType`        | Persona hint injected into agent instructions.                                                             |
| `timeoutMs`        | Override default agent timeout.                                                                            |
| `resume`           | Continue a prior agent session using a previous `agent()` result or explicit `{ sessionId, sessionPath }`. |

## Resuming Agents

Use `resume` when one logical subagent should keep context across multiple turns, such as build → review → fix loops.

```javascript
const build = await agent("Implement the requested change", {
  label: "build pass",
  mode: "build",
});

const review = await agent("Review the current diff and return findings", {
  label: "review pass",
  mode: "review",
  schema: {
    type: "object",
    properties: {
      findings: { type: "array", items: { type: "string" } },
    },
    required: ["findings"],
  },
});

await agent("Fix these findings:\n" + JSON.stringify(review.findings), {
  label: "fix pass",
  mode: "build",
  resume: build,
});
```

See [references/API.md](references/API.md) for details and edge cases.

## Mode Routing

Assign a `mode` to phases in `meta.phases`:

```javascript
phases: [
  { title: "Review", mode: "review" },
  { title: "Fix", mode: "build" },
];
```

Agents inherit the current phase's mode unless overridden with `opts.mode`.

## Workflows

- See [references/API.md](references/API.md) for full API reference and limits.
- See [references/PATTERNS.md](references/PATTERNS.md) for patterns, use cases, and tips.
