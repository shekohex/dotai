# Subagent SDK

`src/subagent-sdk/` (~40 files) is the in-process machinery the parent agent uses to spawn **child agent sessions**. The parent exposes a single `subagent` tool; on invoke, the SDK picks a backend, launches a child (either a separate `pi` process in a terminal pane, or an in-process "lite" session), relays events, persists state, optionally captures structured output, and returns the result.

The parent-side glue is `src/extensions/subagent/`; the SDK itself is backend-agnostic and reusable.

## Mental model

```
parent session
  └─ subagent tool (src/extensions/subagent/tool.ts)
       └─ createSubagentSDK(pi, { adapter, buildLaunchCommand })   // src/subagent-sdk/sdk.ts
            ├─ choose mux backend (herdr → tmux → pty)            // default-mux.ts
            ├─ launch child:
            │     • process runtime → child `pi` in a pane         // runtime/*.ts + launch.ts
            │     • lite runtime   → in-process createAgentSession // lite-runtime.ts
            ├─ child bootstrap (bootstrap*.ts): StructuredOutput tool + IPC bridge + lifecycle handlers
            ├─ IPC relay (ipc.ts, unix socket, JSONL)  [process path]
            └─ completion → capture pane output, read outcome file, return to parent
```

## Mux backends

`createDefaultMuxAdapter` (`default-mux.ts`) is a `FallbackMuxAdapter` (`fallback-mux.ts`) that tries backends in order and uses the first that's available:

| Backend   | File       | When used                                                                                                    | Pane id format  |
| --------- | ---------- | ------------------------------------------------------------------------------------------------------------ | --------------- |
| **Herdr** | `herdr.ts` | When the herdr workspace manager is present.                                                                 | `w\d+:p\d+`     |
| **Tmux**  | `tmux.ts`  | When `$TMUX` is set (inside a tmux session). Uses `tmux` CLI (`load-buffer`/`paste-buffer`, `capture-pane`). | `%<digits>`     |
| **Pty**   | `pty.ts`   | Always available — in-process PTY via `zigpty` + `@xterm/headless`. Last resort.                             | `pty:<pid>:...` |

Consumers can override the chain via `adapterFactory` in the subagent extension options.

## Lite vs process runtime

| Dimension         | Lite                                                                              | Process                                                        |
| ----------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Child mechanism   | In-process `createAgentSession` (same Node process)                               | Separate `pi` subprocess in a mux pane                         |
| Session manager   | `createLiteSessionManager` (`lite-session-manager.ts`) — in-memory or file-backed | File-backed child session path                                 |
| IPC               | Direct event forwarding via `SubagentRuntimeEventBus` (`events.ts`)               | Unix socket JSONL (`bootstrap-ipc.ts` + `ipc.ts`)              |
| Structured output | Retry loop in `lite-runtime.ts` + `lite-structured-output.ts`                     | Child-side `StructuredOutput` tool + `bootstrap-structured.ts` |
| Isolation         | Shared process, isolated `AgentSession` + resource loader                         | Full subprocess isolation                                      |
| UI                | `lite-runtime-ui.ts`                                                              | shared `ui.ts` dashboard via `runtime-hooks.ts`                |

Lite is chosen when the SDK is created with `{ backend: { kind: "lite" } }`; the default extension wiring uses the process (mux-backed) path.

## Key files

| File                                                | Role                                                                                                                                                                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sdk.ts`                                            | `createSubagentSDK` — top-level factory producing a lite or process SDK.                                                                                                                                                |
| `launch.ts`                                         | `buildLaunchCommand` — assembles the child `pi` shell command (`--session`, `--model`, `--continue`, env vars carrying bootstrap state).                                                                                |
| `bootstrap.ts`                                      | `installChildBootstrap` — child-side entry; reads `CHILD_STATE_ENV`/`CHILD_STATE_FILE_ENV`, wires structured output + IPC + lifecycle handlers. `isChildSession()` detects child mode.                                  |
| `bootstrap-core.ts`                                 | Bootstrap runtime state + structured-output state machine.                                                                                                                                                              |
| `bootstrap-ipc.ts`                                  | `registerChildIpcBridge` — forwards child events to the parent over a unix socket.                                                                                                                                      |
| `bootstrap-handlers.ts`                             | Registers child lifecycle handlers (`session_start`, `turn_*`, `agent_end`, `shutdown`).                                                                                                                                |
| `bootstrap-structured.ts`                           | Structured-output capture, retry, persistence on the child side.                                                                                                                                                        |
| `ipc.ts`                                            | `createSubagentIpcServer` / `connectSubagentIpcClient` — JSONL-framed unix socket.                                                                                                                                      |
| `persistence.ts` / `persistence-helpers.ts`         | Child session-file creation, outcome reading, ephemeral outcome files, auto-exit markers.                                                                                                                               |
| `modes.ts`                                          | `resolveSubagentMode` — resolves the mode spec, filters tools (patch-apply-aware), selects the model.                                                                                                                   |
| `prompt.ts`                                         | Subagent role prompt template.                                                                                                                                                                                          |
| `status.ts`                                         | `isTerminalSubagentStatus` (completed/failed/cancelled).                                                                                                                                                                |
| `runtime/*.ts`                                      | Process-runtime implementation: `base.ts` (spawn/restore skeleton), `execution.ts` (resume, state bundles), `messaging.ts` (message delivery + auto-resume), `monitoring.ts` (pane polling, output capture, auto-exit). |
| `sdk-spawn.ts`                                      | `createSpawnFunction` — blocking spawn with structured-output retry + `waitForCompletion`.                                                                                                                              |
| `sdk-handle.ts`                                     | `SDKSubagentHandle` — per-session `getState`/`sendMessage`/`cancel`/`waitForCompletion`/`captureOutput`.                                                                                                                |
| `schema-definitions.ts`, `types.ts`, `sdk-types.ts` | TypeBox schemas for cross-boundary data (`RuntimeSubagent`, `ChildBootstrapState`, structured-output entries).                                                                                                          |

## Structured output

When a `json_schema` is requested, the call **blocks** until the child returns schema-valid output (with retries). On the process path the child registers a `StructuredOutput` tool (`bootstrap-structured.ts`) and the parent awaits `waitForCompletion` (`sdk-spawn.ts`); on the lite path the retry loop lives in `lite-runtime.ts` + `lite-structured-output.ts`. Validation failures retry up to a budget.

## Parent extension

`src/extensions/subagent/` consumes the SDK:

- `extension.ts` — `installChildBootstrap(pi)` (so this process can also act as a child), builds the SDK via `createSubagentSDK(pi, { adapter, buildLaunchCommand })`, registers the `subagent` tool, and re-syncs tool registration (prompt guidelines signature) on `session_start`/`before_agent_start`.
- `tool.ts` — defines the `subagent` tool (`SubagentToolParamsSchema`) and delegates to `executeSubagentToolAction`.
- `execution.ts` — handles `start` / `message` / `cancel` / `list` / `resume` actions; `message` auto-resumes a completed child when needed.
- `shared.ts` — parameter validation + tool-activation scheduling.

## Gotchas

- **Pane orphaning:** if the parent dies mid-flight on the process path, the child pane is left behind (tmux/herdr) unless an auto-exit timeout fires. Lite sessions share the process and die with it.
- **Structured output blocking:** a `json_schema` subagent call blocks the parent turn until the child validates or exhausts retries.
- **Mode tool filtering:** `resolveSubagentMode` is aware of which tools can apply patches, so a read-only subagent mode won't be handed patch tools.
