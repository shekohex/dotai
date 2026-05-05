# Codebase Structure

**Analysis Date:** 2026-05-05

## Directory Layout

```text
[project-root]/
├── bin/ # package bin wrappers
├── dist/ # compiled output, generated defaults, copied resources
├── docs/ # package reference docs
├── patches/ # patch-package overlays
├── scripts/ # build, prepare, and postinstall helpers
├── src/ # TypeScript source
├── support/ # repo-local tooling and lint rules
├── test/ # Vitest suites and fixtures
└── .planning/ # planning workspace used by GSD commands
```

### `src/` layout

```text
src/
├── cli.ts
├── default-settings.ts
├── mode-definitions.ts
├── mode-loading.ts
├── mode-utils.ts
├── extensions/
├── resources/
├── subagent-sdk/
└── utils/
```

### `src/extensions/` layout

```text
src/extensions/
├── coreui.ts
├── executor/
├── files/
├── gsd/
├── interview/
├── mermaid/
├── modes/
├── openusage/
├── review/
├── subagent/
├── websearch/
└── ...
```

### `src/resources/` layout

```text
src/resources/
├── gsd/
│   ├── agents/
│   ├── bin/
│   ├── docs/
│   ├── references/
│   ├── templates/
│   └── workflows/
├── modes/
├── prompts/
├── skills/
├── system/
└── themes/
```

### `test/` layout

```text
test/
├── gsd/
│   └── fixtures/
├── test-utils/
└── *.test.ts / *.scenarios.ts
```

## Directory Purposes

**`src/`:**

- Purpose: application source.
- Contains: CLI bootstrap, extension modules, subagent runtime, bundled resources, shared utilities, and mode loading.
- Key files: `src/cli.ts`, `src/extensions/index.ts`, `src/subagent-sdk/index.ts`, `src/mode-loading.ts`, `src/default-settings.ts`.

**`src/extensions/`:**

- Purpose: feature modules and runtime integrations.
- Contains: command registrations, tool definitions, session hooks, UI renderers, provider wiring, feature-specific helpers, and browser assets.
- Key files: `src/extensions/coreui.ts`, `src/extensions/modes/index.ts`, `src/extensions/gsd/index.ts`, `src/extensions/files/index.ts`, `src/extensions/interview/index.ts`, `src/extensions/websearch/index.ts`, `src/extensions/fetch/index.ts`.

**`src/extensions/gsd/`:**

- Purpose: full GSD workflow implementation.
- Contains: command router, lifecycle handlers, planning state readers and writers, bundled role prompts, dashboard UI, and instant status commands.
- Key files: `src/extensions/gsd/commands.ts`, `src/extensions/gsd/index.ts`, `src/extensions/gsd/orchestration.ts`, `src/extensions/gsd/subagents.ts`, `src/extensions/gsd/state/read.ts`, `src/extensions/gsd/state/write.ts`, `src/extensions/gsd/state/runtime.ts`, `src/extensions/gsd/state/schema.ts`.

**`src/extensions/interview/`:**

- Purpose: interview tool implementation and browser UI.
- Contains: tool registration, request execution, response rendering, structured schemas, and static form assets.
- Key files: `src/extensions/interview/index.ts`, `src/extensions/interview/execute.ts`, `src/extensions/interview/render.ts`, `src/extensions/interview/server.ts`, `src/extensions/interview/form/index.html`, `src/extensions/interview/form/script.js`, `src/extensions/interview/form/styles.css`.

**`src/extensions/review/`:**

- Purpose: review workflow and review-specific child-session orchestration.
- Contains: command flow, runtime state, git integration, prompts, execution bridge, and handoff helpers.
- Key files: `src/extensions/review/index.ts`, `src/extensions/review/command-flow.ts`, `src/extensions/review/command-handler.ts`, `src/extensions/review/deps.ts`, `src/extensions/review/runtime-state.ts`, `src/extensions/review/run-execution.ts`, `src/extensions/review/handoff.ts`.

**`src/extensions/subagent/`:**

- Purpose: `subagent` tool facade and runtime wiring.
- Contains: tool definition, renderers, execution helpers, and shared runtime state.
- Key files: `src/extensions/subagent/index.ts`, `src/extensions/subagent/extension.ts`, `src/extensions/subagent/tool.ts`, `src/extensions/subagent/render-details.ts`, `src/extensions/subagent/render-state.ts`.

**`src/extensions/modes/`:**

- Purpose: active-mode selection and persistence in the live session.
- Contains: command handling, orchestration, lifecycle hooks, flags, tool synchronization, and mode state entries.
- Key files: `src/extensions/modes/index.ts`, `src/extensions/modes/orchestration.ts`, `src/extensions/modes/runtime.ts`, `src/extensions/modes/actions.ts`, `src/extensions/modes/state.ts`.

**`src/extensions/coreui.ts` and `src/extensions/coreui/`:**

- Purpose: UI state, prompt editor binding, tool override rendering, and status widgets.
- Contains: core UI lifecycle, tool renderers, TPS metrics, working indicators, and status display helpers.
- Key files: `src/extensions/coreui.ts`, `src/extensions/coreui/index.ts`, `src/extensions/coreui/tools.ts`, `src/extensions/coreui/tps.ts`, `src/extensions/coreui/working-indicator.ts`.

**`src/extensions/openusage/`:**

- Purpose: provider usage tracking and alerting.
- Contains: controller, state cache, provider model mapping, event parsing, and view models.
- Key files: `src/extensions/openusage/controller.ts`, `src/extensions/openusage/state.ts`, `src/extensions/openusage/model-map.ts`, `src/extensions/openusage/types.ts`.

**`src/extensions/files/`:**

- Purpose: file browser over git tree plus session-referenced files.
- Contains: entry building, selection UI, diff rendering, path helpers, and browser actions.
- Key files: `src/extensions/files/index.ts`, `src/extensions/files/entry-builder.ts`, `src/extensions/files/selector.ts`, `src/extensions/files/browser-actions.ts`.

**`src/extensions/websearch/`:**

- Purpose: web search and fetch integration built on Firecrawl-compatible APIs.
- Contains: request execution, parsing, structured result rendering, and schema validation.
- Key files: `src/extensions/websearch/index.ts`, `src/extensions/websearch/execution.ts`, `src/extensions/websearch/render.ts`, `src/extensions/websearch/types.ts`.

**`src/extensions/fetch/`:**

- Purpose: standalone URL fetch tool.
- Contains: execution details, renderers, and result shaping.
- Key files: `src/extensions/fetch/index.ts`, `src/extensions/fetch/execution.ts`, `src/extensions/fetch/render.ts`, `src/extensions/fetch/types.ts`.

**`src/extensions/mermaid/`:**

- Purpose: render mermaid blocks as ASCII and patch assistant message output.
- Contains: parsing, renderable variants, patching helpers, and tool registration.
- Key files: `src/extensions/mermaid/index.ts`, `src/extensions/mermaid/parsing.ts`, `src/extensions/mermaid/renderable.ts`, `src/extensions/mermaid/patch.ts`.

**`src/subagent-sdk/`:**

- Purpose: child-session runtime and SDK.
- Contains: session launch, tmux adapter, persistence, runtime monitoring, event bus, structured output bootstrap, UI helpers, and schema definitions.
- Key files: `src/subagent-sdk/sdk.ts`, `src/subagent-sdk/runtime.ts`, `src/subagent-sdk/launch.ts`, `src/subagent-sdk/persistence.ts`, `src/subagent-sdk/types.ts`, `src/subagent-sdk/bootstrap.ts`.

**`src/resources/`:**

- Purpose: bundled markdown, JSON, and CJS assets copied into `dist/resources` at build time.
- Contains: GSD agent prompts, docs, templates, workflows, references, themes, prompt snippets, bundled skill definitions, mode prompts, system prompts, and upstream helper scripts.
- Key files: `src/resources/gsd/agents/*.md`, `src/resources/gsd/templates/*.md`, `src/resources/gsd/docs/*.md`, `src/resources/gsd/references/*.md`, `src/resources/gsd/workflows/*.md`, `src/resources/gsd/bin/*.cjs`, `src/resources/skills/executor/SKILL.md`, `src/resources/themes/*.json`, `src/resources/modes/*.md`, `src/resources/prompts/*.md`, `src/resources/system/*.md`.

**`scripts/`:**

- Purpose: build-time and install-time automation.
- Contains: resource copy, default-settings generation, bin wrapper preparation, postinstall hooks, and preview tooling.
- Key files: `scripts/copy-bundled-resources.mjs`, `scripts/generate-default-settings.mjs`, `scripts/prepare-bin.mjs`, `scripts/postinstall.mjs`.

**`test/`:**

- Purpose: Vitest coverage for features, runtime integration, and regression scenarios.
- Contains: unit tests, scenario tests, GSD fixtures, test utilities, and harness-driven integration checks.
- Key files: `test/harness.test.ts`, `test/subagent-sdk.test.ts`, `test/gsd/commands.test.ts`, `test/tool-preview.test.ts`, `test/test-utils/setup-env.ts`, `test/gsd/fixtures/*`.

**`support/`:**

- Purpose: repo-local tooling that is not shipped in the package.
- Contains: the custom Oxlint plugin and rule implementations used to enforce project-specific constraints.
- Key files: `support/oxlint-plugin-project-rules/index.mjs`, `support/oxlint-plugin-project-rules/rules/*.mjs`.

**`dist/`:**

- Purpose: build output.
- Contains: compiled JS, copied resources, generated defaults, and wrapper outputs.
- Key files: `dist/cli.js`, `dist/default-settings.js`, `dist/defaults/settings.json`, `dist/defaults/modes.json`.

**`bin/`:**

- Purpose: package bin wrappers.
- Contains: executable shims for Unix and Windows.
- Key files: `bin/pi.js`, `bin/pi.cmd`.

**`docs/`:**

- Purpose: human-readable package documentation.
- Contains: reference docs for the subagent SDK and related behavior.
- Key files: `docs/subagent-sdk.md`, `docs/gsd-sdk.md`, `docs/subagent-structured-output-spec.md`.

**`patches/`:**

- Purpose: patch-package overlays for upstream dependency changes.
- Contains: generated patch files applied during install or build workflows.
- Key files: files under `patches/`.

**`.planning/`:**

- Purpose: project planning workspace consumed by GSD commands.
- Contains: `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`, phase artifacts, and codebase-map docs.
- Key files: `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/STATE.md`, `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/STRUCTURE.md`.

## Key File Locations

**Entry Points:**

- `src/cli.ts`: runtime bootstrap into upstream agent.
- `bin/pi.js`: package bin wrapper that loads compiled CLI.
- `src/extensions/gsd/index.ts`: `/gsd` command registration and session hooks.
- `src/extensions/interview/index.ts`: interview tool registration.
- `src/extensions/websearch/index.ts`: web search tool registration.
- `src/extensions/subagent/index.ts`: subagent tool registration.

**Configuration:**

- `package.json`: package metadata, scripts, dependency graph, bin definition.
- `tsconfig.json`: NodeNext TypeScript build config.
- `vitest.config.ts`: test runner config.
- `.oxlintrc.json`: lint configuration and project-rules plugin wiring.
- `.oxfmtrc.json`: formatter configuration.

**Core Logic:**

- `src/extensions/index.ts`: bundled extension composition.
- `src/extensions/coreui.ts`: UI state and tool override wiring.
- `src/extensions/modes/index.ts`: runtime mode selection.
- `src/extensions/gsd/`: planning workflow.
- `src/subagent-sdk/`: child-session runtime.
- `src/mode-loading.ts` and `src/mode-utils.ts`: shared mode registry and loader.

**Testing:**

- `test/*.test.ts`: focused unit and integration tests.
- `test/*.scenarios.ts`: end-to-end style scenario tests.
- `test/gsd/fixtures/`: sample planning workspaces used by GSD tests.
- `test/test-utils/setup-env.ts`: shared test environment setup.

## Naming Conventions

**Files:**

- Feature entry modules use `index.ts` when a directory exposes a public surface, for example `src/extensions/gsd/index.ts`, `src/extensions/subagent/index.ts`, and `src/subagent-sdk/index.ts`.
- Concern-specific helpers use suffixes like `-state.ts`, `-schema.ts`, `-types.ts`, `-utils.ts`, `-render.ts`, `-loading.ts`, `-runtime.ts`, and `-settings.ts`.
- GSD lifecycle and orchestration modules use descriptive verbs, for example `src/extensions/gsd/commands.ts`, `src/extensions/gsd/orchestration.ts`, and `src/extensions/gsd/state/read.ts`.

**Directories:**

- Feature areas use semantic names under `src/extensions/`, such as `coreui`, `executor`, `review`, `websearch`, and `gsd`.
- Bundled assets use content-shaped directories under `src/resources/`, such as `agents`, `templates`, `docs`, `themes`, `prompts`, `skills`, and `system`.
- Test fixtures mirror workflow shape under `test/gsd/fixtures/`.

## Where to Add New Code

**New feature:**

- Primary code: `src/extensions/<feature>.ts` or `src/extensions/<feature>/index.ts`.
- Tests: `test/<feature>.test.ts` and, if workflow-heavy, `test/<feature>.scenarios.ts`.

**New GSD command or lifecycle step:**

- Implementation: `src/extensions/gsd/commands.ts`, `src/extensions/gsd/orchestration.ts`, or `src/extensions/gsd/state/*` depending on scope.
- Router hookup: `src/extensions/gsd/handlers.ts` and `src/extensions/gsd/index.ts`.
- Bundled prompts and docs: `src/resources/gsd/agents/`, `src/resources/gsd/templates/`, `src/resources/gsd/docs/`, `src/resources/gsd/references/`.

**New subagent behavior:**

- Implementation: `src/subagent-sdk/<area>.ts`.
- Public export: `src/subagent-sdk/index.ts`.
- Runtime tests: `test/subagent-sdk*.ts` and the review/GSD tests that consume subagents.

**New bundled prompt, template, or theme:**

- Assets: `src/resources/<category>/...`.
- Copy path: `scripts/copy-bundled-resources.mjs` mirrors `src/resources/` into `dist/resources/`.

**New shared helper:**

- Shared helpers: `src/utils/` for low-level primitives, or `src/mode-*.ts` for mode configuration and loading.

## Special Directories

**`support/oxlint-plugin-project-rules/`:**

- Purpose: repo-local lint plugin for project-specific static rules.
- Generated: No.
- Committed: Yes.

**`src/resources/gsd/bin/`:**

- Purpose: bundled upstream GSD CLI assets and helper scripts.
- Generated: No in-source; copied into `dist/resources` during build.
- Committed: Yes.

**`src/extensions/interview/form/`:**

- Purpose: static browser assets for the interview tool UI.
- Generated: No.
- Committed: Yes.

**`test/gsd/fixtures/`:**

- Purpose: on-disk planning workspaces for GSD tests.
- Generated: Test-only fixtures.
- Committed: Yes.

**`dist/`:**

- Purpose: compiled package output and copied resources.
- Generated: Yes.
- Committed: Yes in this repo layout.

**`bin/`:**

- Purpose: executable wrappers for package binary entry.
- Generated: Yes.
- Committed: Yes in this repo layout.

**`.planning/`:**

- Purpose: mutable planning workspace for GSD and codebase mapping.
- Generated: Runtime and command output.
- Committed: Workspace state only when intentionally checked in.

---

_Structure analysis: 2026-05-05_
