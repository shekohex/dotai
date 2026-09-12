---
name: dynamic-workflows
description: Create or run Pi JavaScript workflows with coordinated subagents. Use for requested multi-agent workflow orchestration.
---

# Dynamic Workflows

The `workflow` tool runs a JavaScript harness that spawns and coordinates subagents via `agent()`, `parallel()`, and `pipeline()`. Each subagent gets its own context window and focused goal.

## Quick Start

If the `workflow` tool is not available, ask the user to run `/workflow on` to enable it. Then call the tool with exactly one script source:

- `script`: raw JavaScript inline
- `scriptFile`: absolute path to a JavaScript workflow file

Prefer `scriptFile` when a workflow file already exists; do not rewrite it inline.

Inline `script` example:

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
- Give every `agent()` prompt a concrete return contract. Text agents return final text verbatim; if the script will parse JSON or fields, prefer `schema`.

## Choose details as needed

- Read [references/API.md](references/API.md) when authoring or changing tool parameters, schemas, agent options, modes, resume behavior, or failure handling.
- Read [references/PATTERNS.md](references/PATTERNS.md) when choosing orchestration topology. Do not load all patterns for a saved workflow invocation.

Give each agent a bounded outcome and return contract. Isolate concurrent edits and keep dependent work sequential. Handle failed or missing branch results explicitly before claiming workflow success.

Completion means the requested workflow result is inspected and its acceptance criteria are met. Starting a background run is a launch result, not proof that its work completed. Continue handling results when the user requested completion or monitoring.
