# Codebase Structure

**Analysis Date:** 2026-05-07

## Directory Layout

```text
.
├── bin/ # runtime CLI wrappers prepared during build
├── dist/ # compiled output and copied resources
├── docs/ # repo-facing documentation and audits
├── patches/ # patch-package diffs for upstream dependencies
├── scripts/ # build, postinstall, and packaging scripts
├── src/ # TypeScript source
│   ├── cli.ts
│   ├── default-modes.ts
│   ├── default-settings.ts
│   ├── extensions/
│   ├── mode-*.ts
│   ├── resources/
│   ├── subagent-sdk/
│   └── utils/
├── support/ # repo-local lint plugin and related tooling
├── test/ # Vitest suite and scenario tests
├── .pi/ # local agent runtime data and project settings
└── .planning/ # generated planning workspace and mapped docs
```

## Directory Purposes

**`bin/`:**

- Purpose: Executable wrappers for the published `pi` command.
- Contains: `pi.js`, `pi.cmd`.
- Key files: `bin/pi.js`, `bin/pi.cmd`.

**`dist/`:**

- Purpose: Build output from `tsc` plus copied bundled resources and generated defaults.
- Contains: compiled JS, `dist/resources/`, `dist/defaults/`, extension output.
- Key files: `dist/cli.js`, `dist/defaults/settings.json`, `dist/defaults/modes.json`.

**`docs/`:**

- Purpose: Manual documentation for the wrapper, GSD, and subagent systems.
- Contains: markdown guides and audit notes.
- Key files: `docs/gsd-sdk.md`, `docs/subagent-sdk.md`, `docs/subagent-structured-output-spec.md`.

**`patches/`:**

- Purpose: `patch-package` diffs against `@mariozechner/pi-coding-agent` and related dependencies.
- Contains: `.patch` files.
- Key files: any file under `patches/` with dependency-specific naming.

**`scripts/`:**

- Purpose: Build-time and install-time automation.
- Contains: resource copy, default settings generation, bin wrapper creation, postinstall, preview tooling.
- Key files: `scripts/copy-bundled-resources.mjs`, `scripts/generate-default-settings.mjs`, `scripts/prepare-bin.mjs`, `scripts/postinstall.mjs`.

**`src/`:**

- Purpose: All application source code.
- Contains: entrypoints, feature extensions, subagent runtime, bundled resources, shared utilities.
- Key files: `src/cli.ts`, `src/extensions/index.ts`, `src/subagent-sdk/index.ts`, `src/default-settings.ts`, `src/default-modes.ts`.

**`support/`:**

- Purpose: Repo-local tooling that supplements built-in linting.
- Contains: Oxlint JS plugin and rule implementations.
- Key files: `support/oxlint-plugin-project-rules/index.mjs`, `support/oxlint-plugin-project-rules/rules/*.mjs`.

**`test/`:**

- Purpose: Vitest coverage for commands, runtimes, renderers, and integration flows.
- Contains: unit tests, scenario tests, harness tests, shared setup.
- Key files: `test/*.test.ts`, `test/*.scenarios.ts`, `test/test-utils/setup-env.ts`.

**`.pi/`:**

- Purpose: Local runtime config and state for the agent wrapper.
- Contains: agent settings, modes, sessions, and other user runtime data.
- Key files: generated/user-managed files under `.pi/`.

**`.planning/`:**

- Purpose: Project planning workspace and generated mapping docs.
- Contains: planning state, phases, milestones, debug artifacts, and this codebase map.
- Key files: `.planning/PROJECT.md`, `.planning/ROADMAP.md`, `.planning/STATE.md`, `.planning/phases/`, `.planning/codebase/`.

## Key File Locations

**Entry Points:**

- `src/cli.ts`: package runtime entry that installs bundled resources and launches upstream `main(...)`.
- `bin/pi.js`: installed Unix launcher that forwards to `dist/cli.js`.
- `bin/pi.cmd`: Windows launcher for the same CLI.
- `src/extensions/index.ts`: bundled extension factory list consumed by the upstream host.
- `src/subagent-sdk/index.ts`: public SDK barrel for child-session orchestration.

**Configuration:**

- `package.json`: package metadata, scripts, published bin, and dependency list.
- `tsconfig.json`: TypeScript compiler configuration.
- `vitest.config.ts`: Vitest test runner configuration.
- `.oxlintrc.json`: Oxlint config plus repo-local JS plugin.
- `.oxfmtrc.json`: formatter configuration.
- `scripts/postinstall.mjs`: seeds defaults and applies dependency patches.

**Core Logic:**

- `src/extensions/coreui/index.ts`: host UI chrome, tool overrides, footer and editor wiring.
- `src/extensions/modes/index.ts`: mode flags, mode state restoration, and mode switching events.
- `src/extensions/gsd/index.ts`: GSD command entrypoint and planning-session lifecycle.
- `src/extensions/review/index.ts`: review command and review-state coordination.
- `src/extensions/executor/index.ts`: executor integration command and tool registration.
- `src/extensions/interview/index.ts`: interview tool registration.
- `src/subagent-sdk/runtime/*`: child-session spawn, resume, message, and monitoring logic.

**Testing:**

- `test/*.test.ts`: standard Vitest tests.
- `test/*.scenarios.ts`: multi-step scenario coverage.
- `test/gsd/*.test.ts`: GSD-specific command and workflow tests.
- `test/test-utils/setup-env.ts`: global test environment bootstrap.

## Naming Conventions

**Files:**

- Feature modules use lower kebab-case filenames: `src/extensions/coreui/working-indicator.ts`, `src/extensions/gsd/workflow-launch.ts`.
- Public barrels use `index.ts`: `src/extensions/review/index.ts`, `src/subagent-sdk/index.ts`.
- Tests use `*.test.ts`; scenario suites use `*.scenarios.ts`.
- Resource files mirror runtime labels: `review.md`, `commiter.md`, `catppuccin-mocha.json`, `SKILL.md`.

**Directories:**

- Feature directories match the command or subsystem name: `src/extensions/review/`, `src/extensions/gsd/`, `src/extensions/executor/`.
- Resource directories group by asset type: `src/resources/modes/`, `src/resources/themes/`, `src/resources/gsd/`.
- Support tooling stays under `support/` instead of `src/`.

## Where to Add New Code

**New Feature:**

- Primary code: `src/extensions/<feature>/index.ts` plus supporting modules in the same folder.
- Tests: `test/<feature>.test.ts` or `test/<feature>/*.test.ts`.

**New Command / Tool Bundle:**

- Implementation: `src/extensions/<feature>/index.ts`.
- Bundle registration: `src/extensions/definitions-group-a.ts`, `src/extensions/definitions-group-b.ts`, or `src/extensions/definitions-group-c.ts`.

**New Subagent Capability:**

- Runtime: `src/subagent-sdk/runtime/`.
- Public API: `src/subagent-sdk/index.ts` and `src/subagent-sdk/sdk.ts`.
- Bootstrap/state schema: `src/subagent-sdk/bootstrap*.ts`, `src/subagent-sdk/schema-definitions.ts`, `src/subagent-sdk/types.ts`.

**New GSD workflow logic:**

- Planning state and file I/O: `src/extensions/gsd/state/`.
- Command wiring: `src/extensions/gsd/commands.ts`, `src/extensions/gsd/handlers.ts`.
- Workflow launch behavior: `src/extensions/gsd/workflow-launch.ts`.
- Built-in roles and modes: `src/extensions/gsd/roles.ts`, `src/extensions/gsd/modes.ts`.

**New bundled docs/prompts/themes/skills:**

- Assets: `src/resources/gsd/`, `src/resources/modes/`, `src/resources/prompts/`, `src/resources/themes/`, `src/resources/skills/`, `src/resources/system/`.
- Copy path into build output: `scripts/copy-bundled-resources.mjs`.

**Shared utilities:**

- Small helpers: `src/utils/`.
- Shared extension-level helpers: `src/extensions/session-launch-utils.ts`, `src/extensions/session-replacement.ts`, `src/extensions/inline-extension-names.ts`.

## Special Directories

**`dist/`:**

- Purpose: compiled and packaged runtime output.
- Generated: Yes.
- Committed: Usually yes in this repository; treat as build artifact, not source of truth.

**`bin/`:**

- Purpose: package executables that point at `dist/cli.js`.
- Generated: Yes, by `scripts/prepare-bin.mjs`.
- Committed: Yes.

**`support/oxlint-plugin-project-rules/`:**

- Purpose: repo-specific lint rules that enforce local conventions.
- Generated: No.
- Committed: Yes.

**`.pi/`:**

- Purpose: runtime configuration and session data for local agent use.
- Generated: Mostly yes; seeded and mutated by install/runtime code.
- Committed: No.

**`.planning/`:**

- Purpose: project planning workspace and mapping outputs.
- Generated: Yes.
- Committed: Depends on workflow, but treat as generated project state.

---

_Structure analysis: 2026-05-07_
