# Dynamic Workflows API Reference

## `workflow` Tool

The `workflow` tool executes a deterministic JavaScript script that orchestrates subagents. Provide exactly one script source: inline `script` or absolute-path `scriptFile`.

### Parameters

```typescript
{
  script?: string;       // Raw JavaScript, no Markdown fences. Mutually exclusive with scriptFile.
  scriptFile?: string;   // Absolute path to a JavaScript workflow file. Mutually exclusive with script.
  args?: unknown;        // Optional JSON value exposed as global `args`.
  background?: boolean;  // Default: true. Run in background, deliver result later.
  maxAgents?: number;    // Default: 1000. Hard cap on agents in this run.
  agentTimeoutMs?: number; // Default: 1800000 (30 minutes).
  subagentBackend?: "lite" | "process"; // Default: "process".
}
```

Use `scriptFile` when a workflow file already exists:

```json
{
  "scriptFile": "/home/coder/project/workflows/audit.workflow.js",
  "args": { "scope": "src/extensions" }
}
```

Use `script` when generating a one-off workflow inline:

```json
{
  "script": "export const meta = { name: 'audit', description: 'Audit' };\nconst result = await agent('Audit code', { label: 'audit' });\nreturn result;"
}
```

### Background vs Inline

- **Background (default):** Tool returns immediately with a run ID. The turn ends so the user is not blocked. When the workflow finishes, the result is delivered back into the conversation automatically.
- **Inline (`background: false`):** The call blocks until completion. Use only when the result is needed in the same turn.

### `meta` Export

The script's first statement must be:

```javascript
export const meta = {
  name: "short_snake_case",
  description: "non-empty human description",
  phases: [{ title: "Phase Name", mode: "optional_mode" }],
};
```

- `name` and `description` are required non-empty strings.
- `phases` is optional. Each phase may have `title` and optionally `mode`.
- `whenToUse` is an optional string.

### Available Globals

| Global        | Signature                                                         | Description                                                                                                                                                              |
| ------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent`       | `(prompt: string, opts?: AgentOptions) => Promise<unknown>`       | Spawn a subagent with the given prompt. Returns its result or structured output.                                                                                         |
| `parallel`    | `(thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>`   | Execute functions concurrently. **Must pass functions, not promises.** Results are returned in input order. Failed branches return `null` and log the failure.           |
| `pipeline`    | `(items: unknown[], ...stages: StageFn[]) => Promise<unknown[]>`  | Run each item through stages sequentially. Different items may run concurrently. Each stage receives `(previousValue, originalItem, index)`. Failed items return `null`. |
| `phase`       | `(title: string) => void`                                         | Set the current phase for status display and mode routing.                                                                                                               |
| `log`         | `(message: string) => void`                                       | Append a message to the workflow log.                                                                                                                                    |
| `args`        | `unknown`                                                         | Optional JSON value passed to the tool call. Exposed inside the script as this global.                                                                                   |
| `cwd`         | `string`                                                          | The current working directory.                                                                                                                                           |
| `process.cwd` | `() => string`                                                    | Same as `cwd`.                                                                                                                                                           |
| `budget`      | `{ total: number \| null, spent(): number, remaining(): number }` | Token budget tracking. `remaining()` returns `Infinity` when no budget is set.                                                                                           |
| `workflow`    | `(nameOrScript: string, args?: unknown) => Promise<unknown>`      | Run a saved workflow inline by name, or pass a script string. Nesting is limited to **one level deep**. Global agent/total caps apply across nesting.                    |

Standard utilities: `JSON`, `Math`, `Array`, `Object`, `String`, `Number`, `Boolean`, `Set`, `Map`, `Promise`.

### AgentOptions

```typescript
{
  label?: string;            // 2–5 word unique name for status display.
  phase?: string;             // Override current phase for this agent.
  schema?: JSONSchema;        // Plain JSON Schema (not TypeBox). Agent returns validated object.
  mode?: string;              // Subagent mode (e.g. "review", "worker"). Omit for generic worker.
  outputRetryCount?: number;  // Structured output retry count.
  toolNames?: string[];       // Tools to expose to this agent.
  isolation?: "worktree";     // Run in a throwaway git worktree.
  agentType?: string;         // Persona hint injected into instructions.
  timeoutMs?: number;         // Override default agent timeout.
  resume?: AgentResult | { sessionId: string; sessionPath: string };
                              // Continue a previous agent session.
}
```

### Resuming Agent Sessions

`agent()` returns its normal text or structured result plus hidden resume metadata when the child session is persisted. Pass that prior result as `opts.resume` to continue the same child session with a follow-up prompt:

```javascript
const build = await agent("Implement the feature", {
  label: "build 1",
  mode: "build",
});

const fix = await agent("Fix these review findings:\n" + JSON.stringify(findings), {
  label: "build 2",
  mode: "build",
  resume: build,
});
```

`resume` works for text results and structured outputs. Structured outputs remain ordinary objects for JSON serialization and property access. Text results with hidden resume metadata behave like strings for `String(result)`, template strings, JSON serialization, and string methods, but `typeof result === "string"` is false during workflow execution. Use `String(result)` before strict string checks.

Explicit session refs are supported for advanced cases:

```javascript
await agent("Continue existing work", {
  label: "manual resume",
  resume: { sessionId: "...", sessionPath: "..." },
});
```

Avoid resuming the same prior result concurrently from multiple `parallel()` branches. Do not use `resume` with `isolation: "worktree"`; worktree sessions are intentionally throwaway.

### Subagent Backends

Workflow subagents can run on two backends:

| Backend   | Behavior                                                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lite`    | In-process runtime. Fast, low overhead, persists session files, but has no live tmux pane/window.                                                                                                    |
| `process` | Default runtime. Launches real child Pi sessions through the mux backend. Inside tmux, this creates inspectable tmux panes/windows according to mode settings; outside tmux it can fall back to pty. |

Use `lite` when lower overhead matters more than live process visibility:

```javascript
await workflow("my-saved-workflow", { task: "..." });
```

Or pass the workflow tool parameter:

```json
{
  "script": "export const meta = ...",
  "subagentBackend": "lite"
}
```

Settings can also set the default:

```json
{
  "dynamic_workflows": {
    "subagentBackend": "lite"
  }
}
```

### Limits and Defaults

| Limit                      | Value      |
| -------------------------- | ---------- |
| Max agents per run         | 1000       |
| Max concurrency            | 16         |
| Default agent timeout      | 30 minutes |
| Default mode               | `worker`   |
| Default output retry count | 3          |
| Default background         | `true`     |
| Default subagent backend   | `process`  |
| Workflow nesting depth     | 1 level    |

### Saved Workflows

Save a workflow by pressing `s` in the workflow menu, or store JavaScript files under `~/.pi/workflows/saved/`. Invoke a saved workflow inline with `await workflow('saved-name', argsObject)`.

To share via a skill, put workflow JavaScript files in the skill folder and reference them in `SKILL.md`.

### Commands

| Command                     | Description                               |
| --------------------------- | ----------------------------------------- |
| `/workflow on`              | Enable the workflow tool for the session. |
| `/workflow off`             | Disable the workflow tool.                |
| `/workflows list`           | List active and completed workflow runs.  |
| `/workflows status <runId>` | Inspect a specific run.                   |
| `/workflows stop <runId>`   | Cancel a running workflow.                |

### Determinism Requirements

Workflow scripts must be deterministic. The following are blocked:

- `Date.now()`
- `Math.random()`
- `new Date()`
- Dynamic imports (`import()`, `require()`)
- File system access (`fs`)

Use `args` to pass external data into the script.
