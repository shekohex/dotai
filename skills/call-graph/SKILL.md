---
name: call-graph
description: Trace and present verified call graphs for execution flows, request paths, architecture traces, function callers, upstream/downstream behavior, and production/test wiring. Use when the user asks for a call graph, how something works, what calls a symbol, where a request goes, or a production/test flow comparison; skip trivial single-fact questions and unrelated diagrams.
---

# Call Graph

Treat the graph as a source map, not a conceptual illustration. Never guess paths, symbols, callers, test topology, or line numbers.

## Workflow

1. Determine requested scope and read repository instructions.
2. Find the real entry point, callers, and callees with focused source navigation.
3. Inspect production wiring, including conditions, queues, stores, retries, and fallbacks.
4. Inspect tests only when requested or when test wiring may differ.
5. Build the hierarchy with actual symbol names.
6. Verify every unique node and capture `path:line` evidence.
7. Read [references/output-format.md](references/output-format.md), then render the answer using its contract.
8. Explain only conditions, retries, errors, and gotchas the graph cannot show.

Prefer language-server navigation, `rg`, `ast-grep`, compiler output, type checking, and targeted tests. Stop when every shown node is verified and requested scope is covered.

## Designing New Flows

When graphing a proposed design rather than existing code:

1. Name records, IDs, variants, and structured errors.
2. Draw success data flow first: the `A` channel.
3. Mark cardinality: one value, stream, or time-bounded value.
4. Annotate each `E` break point as retry, escape hatch, or defect.
5. Annotate each node's `R` dependencies.
6. Mark untrusted boundaries where schema converts `unknown` to trusted data.
7. Add cross-cutting behavior without changing the core graph.
8. Scope acquired resources and show differing test wiring.

For Effect code, keep the happy path in `Effect.gen` and enumerate its errors in the following `.pipe()`. Handle errors inline only when sibling effects require divergent failure strategies.
