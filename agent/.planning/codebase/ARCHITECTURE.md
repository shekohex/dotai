<!-- refreshed: 2026-05-07 -->

# Architecture

**Analysis Date:** 2026-05-07

## System Overview

```text
┌─────────────────────────────────────────────────────────────┐
│                  CLI bootstrap / host runtime               │
│  `src/cli.ts` → upstream `@mariozechner/pi-coding-agent`    │
├──────────────────┬──────────────────┬───────────────────────┤
│ Extension assembly│  Feature modules │   Shared runtime      │
│ `src/extensions/` │ `src/extensions/*`│ `src/subagent-sdk/`   │
└────────┬─────────┴────────┬─────────┴──────────┬────────────┘
         │                  │                     │
         ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│       Bundled resources / local project state / externals   │
│ `src/resources/` · `.pi/` · `.planning/` · tmux · MCP       │
└─────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
| --------- | -------------- | ---- |
| CLI entrypoint | Starts upstream host, installs bundled resources, passes bundled extension factories | `src/cli.ts` |
| Extension registry | Groups bundled extension factories and names them for loader output | `src/extensions/index.ts` |
| Core UI layer | Owns footer/header/status/tool rendering hooks for the host UI | `src/extensions/coreui/index.ts` |
| Mode system | Loads and validates mode registry, exposes flags, applies mode-dependent prompts | `src/mode-utils.ts`, `src/extensions/modes/index.ts` |
| GSD workflow layer | Drives planning, execution, verification, and `.planning` file updates | `src/extensions/gsd/index.ts` |
| Review layer | Tracks review sessions, restores state, and coordinates review subagents | `src/extensions/review/index.ts` |
| Subagent runtime | Spawns child sessions, monitors tmux panes, persists state, exposes SDK | `src/subagent-sdk/index.ts` |
| Bundled assets | Copies markdown/json assets into runtime resource search paths | `src/extensions/bundled-resources.ts`, `scripts/copy-bundled-resources.mjs` |

## Pattern Overview

**Overall:** Event-driven extension composition over an upstream session host.

**Key Characteristics:**

- `src/cli.ts` calls upstream `main(...)` once and injects `bundledExtensionFactories` from `src/extensions/index.ts`.
- Most behavior lives in extension factories that register commands, tools, renderers, and session/event listeners.
- Shared state is kept inside small runtime singletons or session-entry state, not in a database.
- Boundary data is validated with TypeBox in modules such as `src/mode-utils.ts`, `src/extensions/gsd/state/schema.ts`, `src/subagent-sdk/schema-definitions.ts`, and `src/extensions/interview/schema.ts`.

## Layers

**Bootstrap layer:**

- Purpose: Start the agent, prepare runtime resources, and hand control to upstream host.
- Location: `src/cli.ts`, `bin/pi.js`, `bin/pi.cmd`, `scripts/prepare-bin.mjs`
- Contains: CLI shim, post-build executable wrappers, host handoff.
- Depends on: `@mariozechner/pi-coding-agent`, bundled extension factories.
- Used by: package entrypoint and local `npm run pi` workflow.

**Extension composition layer:**

- Purpose: Collect bundled extensions and attach stable names.
- Location: `src/extensions/index.ts`, `src/extensions/definitions*.ts`, `src/extensions/inline-extension-names.ts`
- Contains: extension factory lists, naming patch, inline extension loader patch.
- Depends on: upstream `ExtensionFactory`, resource-loader patching.
- Used by: `src/cli.ts` and the upstream extension loader.

**Feature extension layer:**

- Purpose: Implement commands, tools, message renderers, and event reactions.
- Location: `src/extensions/*`
- Contains: command handlers, tool definitions, UI widgets, session listeners, helper state.
- Depends on: upstream extension API, `src/subagent-sdk/`, `src/mode-utils.ts`, `src/utils/`.
- Used by: host runtime after extension registration.

**Shared runtime layer:**

- Purpose: Provide reusable subagent spawning, tmux integration, persistence, and structured-output capture.
- Location: `src/subagent-sdk/`
- Contains: runtime classes, tmux adapter, bootstrapping hooks, persistent state schema, SDK facade.
- Depends on: upstream session API, tmux, `typebox`, local helpers.
- Used by: GSD, review, subagent features, and any module that launches child sessions.

**Resource/data layer:**

- Purpose: Store bundled prompts, themes, docs, skill files, and planning templates.
- Location: `src/resources/`
- Contains: markdown prompts, JSON themes, GSD docs/templates/workflows, skill packs.
- Depends on: local filesystem and build scripts.
- Used by: bundled resource discovery, GSD workflows, mode defaults, and prompt loading.

## Data Flow

### Primary Request Path

1. CLI starts host runtime (`src/cli.ts`) and installs bundled resource search paths before handing over to upstream `main(...)`.
2. Upstream loads extensions from `bundledExtensionFactories` (`src/extensions/index.ts`) and each extension registers commands/tools/event listeners.
3. A user command or tool call enters a feature module, which may read session state, emit UI updates, spawn subagents, or write project files.
4. Feature modules persist results through session entries or local files, then let upstream render the next agent turn or UI refresh.

### Subagent Spawn / Resume Flow

1. A feature requests a child session through `src/subagent-sdk/sdk.ts` or the higher-level GSD helpers in `src/extensions/gsd/subagents.ts`.
2. `src/subagent-sdk/runtime/execution.ts` resolves mode, prompt, session persistence, and child bootstrap state.
3. `src/subagent-sdk/launch.ts` builds a shell command, writes temporary file-backed env payloads, and targets tmux.
4. Child bootstrap logic in `src/subagent-sdk/bootstrap.ts`, `src/subagent-sdk/bootstrap-core.ts`, `src/subagent-sdk/bootstrap-handlers.ts`, and `src/subagent-sdk/bootstrap-structured.ts` installs child-specific tools, status entries, and structured-output behavior.
5. Parent runtime polls tmux / session state and updates session entries through the runtime hooks in `src/subagent-sdk/runtime/*`.

### Bundled Resource Flow

1. `src/extensions/bundled-resources.ts` patches `DefaultResourceLoader.reload()` so bundled skills, prompts, and themes become visible to the upstream loader.
2. `scripts/copy-bundled-resources.mjs` copies `src/resources/` into `dist/resources/` during build.
3. Install-time code in `scripts/postinstall.mjs` seeds default settings and modes into `~/.pi/agent/` if missing.

**State Management:**

- Session-scoped state lives in upstream session entries and per-extension runtime caches.
- Project-scoped planning state lives in `.planning/` and is parsed/written by `src/extensions/gsd/state/*`.
- User-scoped settings live under `~/.pi/agent/` or the upstream agent runtime directory.
- Subagent state is persisted both in session entries and in child-session bootstrap files written by `src/subagent-sdk/persistence.ts` and `src/subagent-sdk/launch.ts`.

## Key Abstractions

**Extension factory:**

- Purpose: Register one feature bundle with the host.
- Examples: `src/extensions/coreui/index.ts`, `src/extensions/gsd/index.ts`, `src/extensions/review/index.ts`, `src/extensions/executor/index.ts`
- Pattern: Factory receives `ExtensionAPI`, registers commands/tools/events, then closes over local runtime state.

**Mode registry:**

- Purpose: Define model/provider/tool combinations and their default prompts.
- Examples: `src/default-modes.ts`, `src/mode-utils.ts`, `src/extensions/modes/index.ts`, `src/extensions/gsd/modes.ts`
- Pattern: Built-in defaults are merged into a validated `ModesFile`, then exposed through flags and command completions.

**Subagent runtime:**

- Purpose: Create, monitor, restore, message, and cancel child sessions.
- Examples: `src/subagent-sdk/runtime/base.ts`, `src/subagent-sdk/runtime/execution.ts`, `src/subagent-sdk/runtime/messaging.ts`, `src/subagent-sdk/runtime/monitoring.ts`
- Pattern: A runtime class hierarchy owns child state maps, polling timers, and tmux interactions.

**Planning snapshot:**

- Purpose: Read `.planning` project state into typed views for orchestration and UI.
- Examples: `src/extensions/gsd/state/read.ts`, `src/extensions/gsd/state/runtime.ts`, `src/extensions/gsd/state/progress.ts`, `src/extensions/gsd/state/stats.ts`
- Pattern: File-based reads and writes, with TypeBox schemas at every boundary.

**Tool definition:**

- Purpose: Provide executable tools with custom rendering and progress updates.
- Examples: `src/extensions/patch/index.ts`, `src/extensions/interview/index.ts`, `src/extensions/websearch.ts`, `src/extensions/executor/tools.ts`
- Pattern: `defineTool(...)` or `pi.registerTool(...)` with custom `renderCall`, `renderResult`, and `execute` handlers.

## Entry Points

**CLI / package entry:**

- Location: `src/cli.ts`, `bin/pi.js`, `bin/pi.cmd`
- Triggers: `npm run pi`, installed `pi` command, package manager bin resolution.
- Responsibilities: install bundled resource paths, pass extension factories to upstream main.

**Extension assembly:**

- Location: `src/extensions/index.ts`, `src/extensions/definitions-group-a.ts`, `src/extensions/definitions-group-b.ts`, `src/extensions/definitions-group-c.ts`
- Triggers: upstream extension loading.
- Responsibilities: define bundled extension order and stable display names.

**Subagent SDK:**

- Location: `src/subagent-sdk/index.ts`
- Triggers: GSD, review, and subagent features that spawn or restore child sessions.
- Responsibilities: expose runtime, tmux adapter, launch helpers, and child-session bootstrap utilities.

**High-value feature entrypoints:**

- `src/extensions/gsd/index.ts` — `/gsd` command, planning lifecycle, and workflow launch handling.
- `src/extensions/review/index.ts` — review command/session orchestration.
- `src/extensions/interview/index.ts` — interview tool registration and browser-backed form flow.
- `src/extensions/executor/index.ts` — executor connection and `execute`/`resume` tool registration.

## Architectural Constraints

- **Threading:** Single Node.js event loop; concurrency comes from async calls, timers, and tmux/process I/O rather than worker threads.
- **Global state:** Present in several controlled caches: `src/mode-loading.ts`, `src/extensions/gsd/settings.ts`, `src/extensions/openusage/state.ts`, `src/extensions/review/runtime-state.ts`, `src/subagent-sdk/runtime/base.ts`, and `src/subagent-sdk/events.ts`.
- **Circular imports:** Not detected in the inspected architecture.
- **Boundary patching:** Upstream-private internals are patched only in boundary modules such as `src/extensions/bundled-resources.ts` and `src/extensions/inline-extension-names.ts`.
- **Persistence model:** No central database; everything persists through session entries, local project files, or user runtime files.

## Anti-Patterns

### Registering features ad hoc from CLI code

**What happens:** A new command or tool is wired directly from `src/cli.ts` or an unrelated file.

**Why it's wrong:** Extension loading depends on grouped factory lists and stable naming in `src/extensions/index.ts`; bypassing that makes ordering, naming, and bundled behavior inconsistent.

**Do this instead:** Add a new feature factory under `src/extensions/<feature>/index.ts` and include it in `src/extensions/definitions-group-*.ts`.

### Re-implementing file/schema parsing at call sites

**What happens:** A feature reads JSON/markdown and hand-parses its own contract instead of using existing state helpers or schemas.

**Why it's wrong:** This repo relies on TypeBox boundaries and shared readers to keep runtime state consistent.

**Do this instead:** Reuse `src/extensions/gsd/state/*`, `src/subagent-sdk/schema-definitions.ts`, `src/mode-utils.ts`, or other existing validators.

## Error Handling

**Strategy:** Validate at boundaries, throw on fatal command failures, and downgrade recoverable issues to UI notifications or non-blocking state.

**Patterns:**

- `Value.Check(...)` / `Value.Parse(...)` around JSON, session entries, and tool payloads.
- `ctx.ui.notify(...)` for recoverable warnings in commands and widgets.
- `isStaleSessionReplacementContextError(...)` guards around UI/session callbacks that can race with replacement.
- Fatal command errors are surfaced through thrown `Error` objects from orchestration modules such as `src/extensions/gsd/orchestration.ts` and `src/subagent-sdk/runtime/*`.

## Cross-Cutting Concerns

**Logging:** Mostly UI-driven. The codebase prefers status widgets, notifications, and command output over a centralized logger.
**Validation:** TypeBox and `Value.Check`/`Value.Parse` at all untrusted boundaries, especially in `src/mode-utils.ts`, `src/extensions/gsd/state/schema.ts`, `src/subagent-sdk/schema-definitions.ts`, and `src/extensions/interview/schema.ts`.
**Authentication:** Delegated to upstream model registry credentials and external-service configuration. Representative touchpoints: `src/extensions/session-query/execution.ts` for model API access, `src/extensions/websearch/*` for Firecrawl, and `src/extensions/executor/*` for MCP endpoint access.

---

_Architecture analysis: 2026-05-07_
