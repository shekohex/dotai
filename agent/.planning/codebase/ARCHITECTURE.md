<!-- refreshed: 2026-05-05 -->

# Architecture

**Analysis Date:** 2026-05-05

## System Overview

```mermaid
flowchart TD
  BIN[bin/pi.js]
  CLI[src/cli.ts]
  MAIN[@mariozechner/pi-coding-agent main]
  REG[src/extensions/index.ts]
  PATCH[src/extensions/bundled-resources.ts / src/extensions/inline-extension-names.ts]
  FEAT[src/extensions/*]
  GSD[src/extensions/gsd/*]
  SUB[src/subagent-sdk/*]
  MODE[src/mode-loading.ts / src/mode-utils.ts / src/default-settings.ts]
  RES[src/resources/*]
  BUILD[scripts/*.mjs]

  BIN --> CLI --> MAIN --> REG
  CLI --> PATCH
  REG --> FEAT
  FEAT --> GSD
  FEAT --> SUB
  FEAT --> MODE
  FEAT --> RES
  BUILD --> RES
```

## Component Responsibilities

| Component             | Responsibility                                                                                                    | File                                                                                                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI bootstrap         | Installs bundled resource-path patches, sets process title, and delegates startup to upstream `main`.             | `src/cli.ts`, `bin/pi.js`                                                                                                                                                                                                                                                               |
| Extension composition | Groups bundled extension factories, assigns stable inline names, and exposes the factory list passed to upstream. | `src/extensions/index.ts`, `src/extensions/definitions-group-a.ts`, `src/extensions/definitions-group-b.ts`, `src/extensions/definitions-group-c.ts`, `src/extensions/inline-extension-names.ts`                                                                                        |
| Bundled resources     | Injects `src/resources` into upstream discovery and keeps packaged prompts, skills, and themes visible.           | `src/extensions/bundled-resources.ts`                                                                                                                                                                                                                                                   |
| Core runtime state    | Binds editor/UI state, git status, usage metrics, and mode changes into session-scoped UI state.                  | `src/extensions/coreui.ts`, `src/extensions/coreui/*`, `src/extensions/git-state.ts`, `src/extensions/openusage/controller.ts`                                                                                                                                                          |
| Mode system           | Loads and merges mode definitions from bundled, global, and project sources.                                      | `src/default-settings.ts`, `src/mode-definitions.ts`, `src/mode-loading.ts`, `src/mode-utils.ts`, `src/extensions/modes/index.ts`                                                                                                                                                       |
| GSD workflow          | Owns `/gsd` command dispatch, planning workspace parsing, phase orchestration, and GSD role prompts.              | `src/extensions/gsd/*`, `src/resources/gsd/*`                                                                                                                                                                                                                                           |
| Subagent runtime      | Spawns, resumes, restores, and captures child sessions through tmux-backed typed runtime state.                   | `src/subagent-sdk/*`                                                                                                                                                                                                                                                                    |
| Feature slices        | Implements user-facing commands, tools, renderers, and external integrations.                                     | `src/extensions/review/index.ts`, `src/extensions/subagent/index.ts`, `src/extensions/interview/index.ts`, `src/extensions/files/index.ts`, `src/extensions/websearch/index.ts`, `src/extensions/fetch/index.ts`, `src/extensions/mermaid/index.ts`, `src/extensions/executor/index.ts` |

## Pattern Overview

**Overall:** extension-driven wrapper around upstream `@mariozechner/pi-coding-agent`

**Key Characteristics:**

- `src/cli.ts:3-10` stays thin. It patches bundled resources, then delegates runtime startup to upstream `main` with `bundledExtensionFactories`.
- `src/extensions/index.ts:19-49` is the composition root. It assembles all bundled `ExtensionFactory` values and names inline extensions so upstream loader output stays stable.
- Most feature code is registration code. `src/extensions/*` modules bind commands, tools, renderers, widgets, and event listeners onto `ExtensionAPI`.
- GSD is a vertical slice inside the extension layer. `src/extensions/gsd/index.ts`, `src/extensions/gsd/commands.ts`, `src/extensions/gsd/orchestration.ts`, and `src/extensions/gsd/state/*` split command routing, planning state, and phase execution.
- TypeBox validates every boundary where data crosses between files, session entries, JSON payloads, and child-session output. See `src/mode-definitions.ts`, `src/extensions/gsd/state/schema.ts`, and `src/subagent-sdk/types.ts`.

## Layers

**Bootstrap and packaging:**

- Purpose: start the packaged CLI and prepare generated assets.
- Location: `src/cli.ts`, `bin/pi.js`, `scripts/copy-bundled-resources.mjs`, `scripts/generate-default-settings.mjs`, `scripts/prepare-bin.mjs`, `scripts/postinstall.mjs`
- Contains: startup shim, resource copy, defaults generation, bin wrapper generation, install-time seeding.
- Depends on: `@mariozechner/pi-coding-agent`, `src/extensions/bundled-resources.ts`, `src/extensions/index.ts`.
- Used by: package bin `pi`, build output under `dist/`.

**Extension composition:**

- Purpose: define which feature modules are active in the runtime.
- Location: `src/extensions/index.ts`, `src/extensions/definitions.ts`, `src/extensions/definitions-group-a.ts`, `src/extensions/definitions-group-b.ts`, `src/extensions/definitions-group-c.ts`
- Contains: grouped factory lists, subagent factory wrapper, inline-name patch installation.
- Depends on: feature modules in `src/extensions/*`.
- Used by: `src/cli.ts` and upstream extension loading.

**Feature slices:**

- Purpose: implement user-facing commands, tools, session hooks, renderers, and integrations.
- Location: `src/extensions/*`, especially `src/extensions/coreui.ts`, `src/extensions/modes/index.ts`, `src/extensions/review/index.ts`, `src/extensions/subagent/index.ts`, `src/extensions/interview/index.ts`, `src/extensions/files/index.ts`, `src/extensions/websearch/index.ts`, `src/extensions/fetch/index.ts`, `src/extensions/mermaid/index.ts`
- Contains: command handlers, tool definitions, UI state, provider wiring, and session persistence.
- Depends on: upstream extension APIs, mode helpers, GSD runtime, `src/utils/*`.
- Used by: command dispatch, session lifecycle events, tool execution, and message rendering.

**GSD workflow:**

- Purpose: model planning work as `.planning` files, subcommands, and role-specific child sessions.
- Location: `src/extensions/gsd/*`, `src/resources/gsd/*`
- Contains: command routing, lifecycle handlers, planning readers/writers, roadmap parsing, dashboards, built-in GSD modes, role prompts, phase reports.
- Depends on: `src/subagent-sdk/*`, `src/extensions/session-launch-utils.ts`, `src/mode-loading.ts`, bundled markdown assets.
- Used by: `/gsd` command, startup hooks, planning-phase automation, and codebase mapping.

**Subagent runtime:**

- Purpose: manage child sessions and expose a typed SDK for spawning and observing them.
- Location: `src/subagent-sdk/*`
- Contains: runtime orchestration, tmux adapter, launch command builder, persistence helpers, event bus, structured-output bootstrap, and session widgets.
- Depends on: `@mariozechner/pi-coding-agent`, `typebox`, standard file-system APIs.
- Used by: GSD roles, review flows, and any feature that launches nested sessions.

**Modes and shared schemas:**

- Purpose: hold reusable schemas, mode definitions, and low-level parsing helpers.
- Location: `src/mode-definitions.ts`, `src/mode-loading.ts`, `src/mode-utils.ts`, `src/default-settings.ts`, `src/utils/*`
- Contains: TypeBox schema definitions, merged mode registries, default settings, unknown-data helpers, error formatting.
- Depends on: standard library, TypeBox, upstream agent settings contracts.
- Used by: almost every higher-level feature module.

## Data Flow

### Primary Startup Path

1. `bin/pi.js` imports `dist/cli.js`.
2. `src/cli.ts:3-10` installs bundled resource paths and calls upstream `main(process.argv.slice(2), { extensionFactories: bundledExtensionFactories })`.
3. `src/extensions/index.ts:19-49` installs the inline-extension-name patch, assembles bundled factories, and passes the final list into upstream loading.
4. Each extension module registers commands, tools, renderers, or listeners on `ExtensionAPI`. Examples: `src/extensions/coreui.ts`, `src/extensions/modes/index.ts`, `src/extensions/files/index.ts`, `src/extensions/gsd/index.ts`.

### GSD Planning Path

1. `/gsd ...` is registered in `src/extensions/gsd/commands.ts:32-82` and enabled by `src/extensions/gsd/index.ts:10-41`.
2. `src/extensions/gsd/orchestration.ts:262-335` resolves the current phase, builds planner/checker/verifier prompts, and spawns roles through `src/extensions/gsd/subagents.ts`.
3. `src/extensions/gsd/state/read.ts`, `src/extensions/gsd/state/runtime.ts`, `src/extensions/gsd/state/write.ts`, and `src/extensions/gsd/state/reports.ts` parse and mutate `.planning/STATE.md`, `.planning/ROADMAP.md`, and phase artifacts.
4. `src/extensions/gsd/modes.ts` registers role-specific bundled modes from `src/resources/gsd/agents/*.md` so child sessions get the right persona and tool contract.
5. `src/subagent-sdk/bootstrap.ts:115-183` injects child-session bootstrap behavior, including the synthetic structured-output tool used for schema-backed roles.

### Session State And UI Path

1. `src/extensions/coreui.ts:1-282` wires session start, turn events, mode changes, git state updates, and usage updates into UI state.
2. `src/extensions/git-state.ts` serializes git state into session events and keeps a per-cwd cache.
3. `src/extensions/openusage/controller.ts` watches provider usage snapshots and republishes them to the core UI and session state.
4. `src/extensions/modes/index.ts:210-282` keeps active mode state in sync with the session log and emits `modes:changed` events.

### Subagent Runtime Path

1. `src/extensions/subagent/extension.ts:16-73` builds a `TmuxAdapter`, creates `createSubagentSDK(...)`, and registers the `subagent` tool.
2. `src/subagent-sdk/sdk.ts:94-127` owns the typed SDK facade, periodic polling, event bus emission, and handle abstraction.
3. `src/subagent-sdk/launch.ts:81-139` serializes child state into temp files and assembles the shell command used to launch child `pi` processes.
4. `src/subagent-sdk/bootstrap.ts:162-183` reads child bootstrap state, mounts the child widget, and registers the synthetic `StructuredOutput` tool when JSON schema output is requested.

**State Management:**

- Session-scoped mutable caches live in `src/extensions/git-state.ts`, `src/extensions/modes/index.ts`, `src/extensions/coreui.ts`, `src/extensions/review/index.ts`, and `src/extensions/openusage/controller.ts`.
- Planning state is file-backed. `src/extensions/gsd/state/*` reads and writes `.planning/STATE.md`, `.planning/ROADMAP.md`, phase plan files, and generated reports.
- Subagent state is session-backed. `src/subagent-sdk/types.ts`, `src/subagent-sdk/sdk.ts`, and `src/subagent-sdk/persistence.ts` serialize child-session state into session entries and temp files.

## Key Abstractions

**ExtensionFactory / ExtensionAPI:**

- Purpose: registration surface for commands, tools, events, shortcuts, providers, and renderers.
- Examples: `src/extensions/coreui.ts`, `src/extensions/gsd/index.ts`, `src/extensions/interview/index.ts`, `src/extensions/websearch/index.ts`, `src/extensions/subagent/index.ts`.
- Pattern: default-exported registration functions with small composition wrappers.

**ModeSpec / ModesFile:**

- Purpose: describe provider, model, thinking level, tools, and prompts for a named mode.
- Examples: `src/mode-definitions.ts`, `src/mode-loading.ts`, `src/default-settings.ts`, `src/extensions/gsd/modes.ts`.
- Pattern: TypeBox-validated JSON merged from bundled, global, and project sources.

**SubagentSDK / RuntimeSubagent / MuxAdapter:**

- Purpose: abstract child-session launch, persistence, capture, and transport.
- Examples: `src/subagent-sdk/sdk.ts`, `src/subagent-sdk/runtime.ts`, `src/subagent-sdk/tmux.ts`, `src/subagent-sdk/types.ts`.
- Pattern: typed runtime wrapper around tmux-backed panes and session-manager entries.

**PlanningSnapshot / RoadmapPhase / PlanFile:**

- Purpose: represent `.planning` state as parsed data instead of raw markdown.
- Examples: `src/extensions/gsd/state/read.ts`, `src/extensions/gsd/state/roadmap.ts`, `src/extensions/gsd/state/runtime.ts`, `src/extensions/gsd/state/schema.ts`.
- Pattern: read markdown frontmatter or loose key-value state, derive progress, then write artifacts through dedicated helpers.

**GsdRole:**

- Purpose: name the built-in subagent roles used by GSD orchestration.
- Examples: `src/extensions/gsd/roles.ts`, `src/extensions/gsd/subagents.ts`, `src/resources/gsd/agents/*.md`.
- Pattern: role name resolves to a built-in mode spec and bundled prompt file.

## Entry Points

**CLI startup:**

- Location: `src/cli.ts`
- Triggers: `bin/pi.js`, `npm run pi`, package bin resolution.
- Responsibilities: install bundled resources, set process title, start upstream runtime.

**Bundled extension registry:**

- Location: `src/extensions/index.ts`
- Triggers: upstream extension loader during startup.
- Responsibilities: provide ordered factory list and stable inline extension names.

**GSD command surface:**

- Location: `src/extensions/gsd/index.ts`, `src/extensions/gsd/commands.ts`
- Triggers: `/gsd ...` command invocation and session lifecycle events.
- Responsibilities: enable or disable GSD, route subcommands, inject planning context into prompts, refresh `.planning` state.

**Subagent SDK public API:**

- Location: `src/subagent-sdk/index.ts`
- Triggers: GSD role orchestration, review automation, any feature that needs child sessions.
- Responsibilities: expose runtime creation, launch command building, restoration, and capture.

**Interactive feature entry points:**

- Location: `src/extensions/files/index.ts`, `src/extensions/interview/index.ts`, `src/extensions/websearch/index.ts`, `src/extensions/mermaid/index.ts`, `src/extensions/session-query/index.ts`
- Triggers: command or tool invocations from the agent runtime.
- Responsibilities: file browsing, structured interview collection, web search, diagram rendering, session lookup.

## Architectural Constraints

- **Module format:** NodeNext ESM across `tsconfig.json` and source modules.
- **Global state:** mutable registries exist in `src/mode-loading.ts`, `src/extensions/git-state.ts`, `src/extensions/modes/index.ts`, `src/extensions/review/index.ts`, and `src/extensions/openusage/controller.ts`.
- **Boundary validation:** untrusted input stays `unknown` until TypeBox schemas validate it in files such as `src/mode-definitions.ts`, `src/extensions/gsd/state/schema.ts`, and `src/subagent-sdk/types.ts`.
- **Resource patching:** bundled resources and inline extension names depend on upstream `DefaultResourceLoader` patching in `src/extensions/bundled-resources.ts` and `src/extensions/inline-extension-names.ts`.
- **Session coupling:** GSD and subagent flows depend on upstream session-manager persistence and session-entry shapes in `@mariozechner/pi-coding-agent`.
- **Process model:** Node event loop handles orchestration; child `pi` sessions run in tmux panes or windows through `src/subagent-sdk/tmux.ts`.

## Anti-Patterns

### Direct Planning Writes

**What happens:** code writes `.planning/*.md` files inline from feature code instead of using `src/extensions/gsd/state/write.ts` and `src/extensions/gsd/state/reports.ts`.
**Why it's wrong:** it duplicates file naming, frontmatter shape, and state-field rules.
**Do this instead:** route planning persistence through `src/extensions/gsd/state/runtime.ts`, `src/extensions/gsd/state/write.ts`, and `src/extensions/gsd/state/reports.ts`.

### Bypassing Bootstrap Wiring

**What happens:** code starts the upstream runtime without `installBundledResourcePaths()` or without the bundled extension registry from `src/extensions/index.ts`.
**Why it's wrong:** bundled themes, prompts, skills, and extension names stop resolving consistently.
**Do this instead:** keep startup through `src/cli.ts` and reuse `src/extensions/bundled-resources.ts` plus `src/extensions/index.ts`.

## Error Handling

**Strategy:** validate at boundaries, fail fast on schema mismatch, and isolate stale-session errors where the runtime can legitimately be replaced.

**Patterns:**

- Use `Value.Check(...)` and `Value.Parse(...)` before reading structured payloads.
- Convert child-session failures into explicit terminal statuses in `src/subagent-sdk/sdk.ts`, `src/subagent-sdk/persistence.ts`, and `src/extensions/gsd/subagents.ts`.
- Swallow only stale-session replacement errors in UI refresh paths, such as `src/extensions/coreui.ts` and `src/extensions/git-state.ts`.
- Surface command-level failures through `ctx.ui.notify(...)` or thrown errors in orchestration paths like `src/extensions/gsd/orchestration.ts`.

## Cross-Cutting Concerns

**Logging:**

- Primary user-facing diagnostics go through `ctx.ui.notify(...)`, widgets, and custom steer messages, not a separate logging subsystem.
- Runtime events flow through `pi.events.emit(...)` for mode changes, git state updates, usage refreshes, and core UI redraws.

**Validation:**

- TypeBox schemas guard JSON, session entries, planning files, and structured tool responses.
- Parsing helpers in `src/utils/unknown-data.ts` stay narrow and are reused by boundary modules.

**Authentication:**

- No local auth layer detected in this repo.
- External service auth is handled by upstream providers, environment variables, and the runtime configured in feature modules such as `src/extensions/websearch/index.ts` and `src/extensions/executor/*`.

---

_Architecture analysis: 2026-05-05_
