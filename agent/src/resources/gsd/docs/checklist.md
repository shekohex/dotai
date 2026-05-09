# GSD Delivery Checklist

## Extension Shell

- `src/extensions/gsd/index.ts`
- `src/extensions/gsd/commands.ts`
- `src/extensions/gsd/settings.ts`
- `src/extensions/gsd/ui.ts`
- `src/extensions/gsd/help.ts`

## `.planning` Core

- `src/extensions/gsd/state/schema.ts`
- `src/extensions/gsd/state/detect.ts`
- `src/extensions/gsd/state/read.ts`
- `src/extensions/gsd/state/write.ts`
- `src/extensions/gsd/state/progress.ts`
- `src/extensions/gsd/state/stats.ts`
- `src/extensions/gsd/state/health.ts`
- `src/extensions/gsd/state/runtime.ts`
- `src/extensions/gsd/state/reports.ts`
- `.planning/goals` snapshot parsing
- `.planning/milestones` snapshot parsing
- `.planning/todos/pending` snapshot parsing
- plan task extraction from `### Task N:` sections

## Worker System

- `src/extensions/gsd/roles.ts`
- `src/extensions/gsd/modes.ts`
- `src/extensions/gsd/subagents.ts`
- bundled agents under `src/resources/gsd/agents`
- bundled templates under `src/resources/templates/gsd`

## Lifecycle Commands

- `new-project`
- `map-codebase`
- `discuss-phase`
- `plan-phase`
- `execute-phase`
- `verify-work`
- `validate-phase`

Current shipped note:

- `validate-phase` is workflow-launch validation review, not stub template writer
- `validate-phase` helper resolves one canonical validation target or fails closed
- `progress` default route is workflow-launch review, not one-line notifier

## Instant Commands

- `next`
- `stats`
- `health`

## Workflow-Launch Review Commands

- `progress`

## Brownfield

- fixture under `test/gsd/fixtures/brownfield-v1`
- continuation tests in `test/gsd/brownfield.test.ts`
- session-start continuation in `test/gsd/index.test.ts`

## Docs

- `overview.md`
- `architecture.md`
- `user-guide.md`
- `command-reference.md`
- `role-reference.md`
- `compatibility.md`

## Resource Audit Status

### Prompt Files

- `codebase-mapper.md` — audited against `pi-gsd` agent; differences are mostly local runtime adaptation (`<required_reading>` vs upstream `<files_to_read>`) plus editorial formatting; active runtime call site now passes required reading paths
- `debugger.md` — audited against `pi-gsd` agent; bundled copy intentionally contains stronger local instructions and is not exercised by current built-in command surface
- `executor.md` — audited against `pi-gsd` agent; bundled copy intentionally targets this repo's tool/runtime model and omits upstream Context7-specific fallback text
- `phase-researcher.md` — audited against `pi-gsd` agent; active runtime call site now passes required reading paths
- `plan-checker.md` — audited against `pi-gsd` agent; active runtime call site now passes required reading paths
- `planner.md` — audited against `pi-gsd` agent; active runtime call site now passes required reading paths
- `project-researcher.md` — audited against `pi-gsd` agent; currently bundled for future/new-project parity work, not exercised by current lifecycle tests
- `roadmapper.md` — audited against `pi-gsd` agent; bundled for future/new-project parity work, not exercised by current lifecycle tests
- `verifier.md` — audited against `pi-gsd` agent; active runtime call site now passes required reading paths

### Template Files

- `UAT.md` — audited against upstream template; differences are markdown/YAML formatting only
- `VALIDATION.md` — audited against upstream template; differences are placeholder spacing and table formatting only
- `context.md` — audited against upstream template; differences are markdown formatting only
- `project.md` — audited against upstream template; differences are markdown formatting only
- `requirements.md` — audited against upstream template; differences are markdown formatting only
- `research.md` — audited against upstream template; differences are markdown fence/table formatting only
- `roadmap.md` — audited against upstream template; differences are markdown indentation/spacing only; parser tests cover shipped shape
- `roadmap-empty.md` — built-in bootstrap-only template; no direct upstream file pair in cached sources
- `state.md` — audited against upstream template; differences are markdown formatting only

### Bundled Docs

- `overview.md` — updated to reflect resolved mode injection, persistence, roadmap parsing, and testing decisions
- `compatibility.md` — updated to reflect nested YAML frontmatter and missing `PROJECT.md` health semantics
- `audit.md` — tracks concrete evidence and remaining red items

## Test Coverage

- schema: `test/gsd/schema.test.ts`
- roadmap/runtime: `test/gsd/roadmap.test.ts`
- orchestration: `test/gsd/orchestration.test.ts`
- lifecycle: `test/gsd/lifecycle.test.ts`
- commands: `test/gsd/commands.test.ts`
- modes: `test/gsd/modes.test.ts`
- brownfield: `test/gsd/brownfield.test.ts`
- resources: `test/gsd/resources.test.ts`
