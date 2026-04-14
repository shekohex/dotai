---
name: executor
description: >-
  Load before using the `execute` tool, remote systems, and
  configured MCP/OpenAPI/GraphQL integrations. Use `tools.search({ ... })`,
  then `tools.describe.tool({ path })`, then call the full
  `tools.<namespace>.<tool>(args)` path.
metadata:
  short-description: Required calling pattern for Executor `execute`
---

# Executor

Load this skill before any `execute` call.

## Source Of Truth

Read the current `execute` tool description in the prompt first.
That is the session-specific contract.

## Mental Model

Inside `execute`:

- `tools` is a lazy proxy
- discover first, call second
- call the exact full path
- pass objects to helper tools

Helpers:

- `tools.search({ query, namespace?, limit? })`
- `tools.describe.tool({ path })`
- `tools.executor.sources.list({ query?, limit? })`

## Required Flow

1. Search.
2. Pick `matches[0]?.path`.
3. Describe that path.
4. Call the full namespaced tool.
5. Return normalized data.

## Canonical Pattern

```ts
const matches = await tools.search({ query: "linear issues", limit: 5 });
const path = matches[0]?.path;
if (!path) return "No matching tools found.";

const details = await tools.describe.tool({ path });

const result = await tools.mcp_linear_app.list_issues({
  project: "<project-id>",
  limit: 5,
});

return result?.structuredContent ?? result;
```

## Result Unwrap

Some tools return MCP-style payloads.
Prefer `structuredContent`. If missing, parse the first text block if it is JSON.

```ts
const unwrap = (value: any) => {
  if (value?.structuredContent) return value.structuredContent;

  const text = value?.content?.find?.((item: any) => item?.type === "text")?.text;
  if (typeof text !== "string") return value;

  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
};
```

## Do

- start with `tools.search({ ... })` when path is not certain
- use `tools.describe.tool({ path })` before unfamiliar calls
- call `tools.<namespace>.<tool>(args)` exactly
- use `tools.executor.sources.list({})` to confirm namespaces or source inventory
- let `execute` handle inline interaction in UI sessions

## Don’t

- do not call `tools()`
- do not use `Object.keys(tools)` for discovery
- do not guess namespaces like `tools.linear`
- do not pass a raw string to `tools.search`
- do not use `includeSchemas` with `tools.describe.tool()`
- do not use `fetch` when Executor already has the integration

## When To Use Executor

Use Executor for:

- SaaS APIs
- remote systems
- configured integrations
- auth or approval managed actions

Use Pi native tools for:

- repo files
- code edits
- refactors
- local tests and builds

## Interaction Rule

If `execute` pauses and the session has UI, let it finish inline.
Only call `resume` if `execute` returns an execution ID and explicitly cannot complete inline.

## Recovery

If `execute` goes sideways, check:

1. Did you load this skill first?
2. Did you search instead of guessing?
3. Did you describe the tool before calling it?
4. Did you use the full namespaced path?
5. Did you unwrap `structuredContent` or JSON text before returning?
