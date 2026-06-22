---
name: executor
description: >-
  Load before using the `execute` tool, external systems, and
  configured MCP/OpenAPI/GraphQL integrations. Use `tools.search({ ... })`,
  then `tools.describe.tool({ path })`, then call `tools[path](args)`.
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
- call the exact full path through bracket access
- pass objects to helper tools

Helpers:

- `tools.search({ query, namespace?, limit? })`
- `tools.describe.tool({ path })`
- `tools[path](args)` where `path` is exact path from search/describe

## Required Flow

1. Search.
2. Pick `matches[0]?.path`.
3. Describe that path.
4. Call the full namespaced tool.
5. Return normalized data.

## Canonical Pattern

```ts
const { items } = await tools.search({ query: "linear issues", limit: 5 });
const path = items[0]?.path;
if (!path) return "No matching tools found.";

const details = await tools.describe.tool({ path });

const result = await tools[path]({
  project: "<project-id>",
  limit: 5,
});

if (!result.ok) return { error: result.error };
return result.data?.structuredContent ?? result.data;
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
- call `tools[path](args)` exactly; do not guess dotted proxy paths
- use `tools.search({ query: "connections", limit })` to find connection inventory tools
- let `execute` handle inline interaction in UI sessions

## Don’t

- do not call `tools()`
- do not use `Object.keys(tools)` for discovery
- do not guess namespaces like `tools.linear`
- do not rely on namespace-only search; include a query term
- do not pass a raw string to `tools.search`
- do not use `includeSchemas` with `tools.describe.tool()`
- do not use `fetch` when Executor already has the integration

## When To Use Executor

Use Executor for:

- SaaS APIs
- external systems
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
