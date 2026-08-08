# Output Format

Use this contract:

````markdown
graph: <short title>

Production:
```ts
EntryPoint
  → ComponentA
    → ComponentA.method
      → [condition] ComponentB
        → {queue_or_store}
```

Tests:
```ts
TestEntryPoint
  → ComponentATestLayer
    → ComponentA.method
      → ComponentBTestLayer
```

src:
  EntryPoint → path/to/file.ts:LINE
  ComponentA → path/to/component.ts:LINE
  ComponentA.method → path/to/component.ts:LINE
  ComponentB → path/to/other.ts:LINE
````

## Rules

- Lead with the graph. Use plain text, not Mermaid.
- Use a `ts` fence and two-space-indented `→` children.
- Give the root no arrow; indentation represents call hierarchy.
- Use actual functions, methods, services, jobs, queues, and stores.
- Show `Production` always. Show `Tests` only when its graph differs.
- Include one `path:line` entry for every unique node shown.
- Keep conditions concise in square brackets: `[condition]`.
- Use braces for infrastructure endpoints: `{queue_or_store}`.
- Mark planned nodes `[new]`; never invent future paths or line numbers.
- Omit the graph for trivial single-fact questions.
- If evidence is incomplete, state the missing edge instead of guessing.
