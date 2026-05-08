# GSD Audit

## Objective Restatement

- built-in GSD extension
- bundled agents, templates, docs
- grouped `/gsd` command surface
- orchestration on top of internal subagent SDK
- brownfield continue-in-place for valid `.planning`
- pi-tui custom component dashboard/help
- tests and repo gates green

## Evidence Map

### Command Surface

- `src/extensions/gsd/commands.ts`
- `src/extensions/gsd/autocomplete.ts`
- `test/gsd/commands.test.ts`
- grouped `/gsd new-project` test proves empty-roadmap bootstrap through real command dispatch

### Extension/UI

- `src/extensions/gsd/index.ts`
- `src/extensions/gsd/context.ts`
- `src/extensions/gsd/ui.ts`
- `src/extensions/gsd/help.ts`
- `test/gsd/index.test.ts` covers `before_agent_start` planning-context injection
- `test/gsd/commands.test.ts` covers non-UI dashboard fallback summary including todo count

### Persistent State

- `src/extensions/gsd/state/*`
- `test/gsd/schema.test.ts`
- `test/gsd/roadmap.test.ts`
- `test/gsd/brownfield.test.ts`
- `src/extensions/gsd/state/markdown.ts` now uses real YAML parsing for frontmatter
- `src/extensions/gsd/state/schema.ts` accepts upstream nested `progress` and `must_haves` shapes
- blank scalar `current_plan:` loads as `""`, not `[]`
- tracked field writes preserve loose `STATE.md` metadata/body and frontmatter/body content
- fresh `new-project` bootstrap writes empty roadmap shell, not instructional placeholder phases
- `.planning/todos/pending` is parsed into snapshot state
- `.planning/goals` is parsed into snapshot state
- `.planning/milestones` is parsed into snapshot state
- decimal inserted phases such as `2.1` resolve and advance in place
- milestone-grouped roadmap headings using `#### Phase N` parse correctly
- task titles are extracted from plan bodies using `### Task N:` headings

### Worker System

- `src/extensions/gsd/roles.ts`
- `src/extensions/gsd/modes.ts`
- `src/extensions/gsd/subagents.ts`
- `test/gsd/modes.test.ts`
- `test/gsd/subagents.test.ts`
- `src/extensions/gsd/orchestration.ts`, `src/extensions/gsd/lifecycle/discuss-phase.ts`, and `src/extensions/gsd/lifecycle/map-codebase.ts` now pass `<required_reading>` blocks to spawned roles that expect them
- `test/gsd/orchestration.test.ts` and `test/gsd/lifecycle.test.ts` assert required reading paths are present in spawned tasks

### Orchestration

- `src/extensions/gsd/orchestration.ts`
- `src/extensions/gsd/lifecycle/*`
- `test/gsd/orchestration.test.ts`
- `test/gsd/lifecycle.test.ts`

### Brownfield

- `test/gsd/fixtures/brownfield-v1`
- `test/gsd/index.test.ts`
- `test/gsd/roadmap.test.ts` covers brownfield state preservation on `/gsd next`
- `test/gsd/orchestration.test.ts` covers brownfield state preservation on plan-phase writes

### Docs

- `src/resources/gsd/docs/*`
- `test/gsd/resources.test.ts`
- every shipped GSD role prompt loads through `loadBundledPrompt`
- every shipped GSD template loads through `loadBundledTemplate`

### Review Regression Fixes

- `test/gsd/brownfield.test.ts` proves upstream-style `STATE.md` YAML with nested `progress` loads successfully
- `test/gsd/brownfield.test.ts` proves blank `current_plan:` stays valid
- `test/gsd/brownfield.test.ts` proves nested upstream `PLAN.md` frontmatter loads during snapshot reads
- `test/gsd/brownfield.test.ts` and `test/gsd/instant.test.ts` prove missing `PROJECT.md` is unhealthy and `/gsd health` reports non-green
- `test/gsd/commands.test.ts` proves `/gsd health --context` works with explicit values, session-derived values, and honest unknown output when only window fallback is available

## Section Checklist

### Prompt-to-Artifact Matrix

- `Goal`
  - code: `src/extensions/gsd/index.ts`, `src/extensions/gsd/context.ts`
  - resources/docs: `overview.md`, `compatibility.md`
  - tests: `test/gsd/index.test.ts`, `test/gsd/brownfield.test.ts`
  - gap: none inside `.planning` compatibility boundary

- `Product Direction`
  - code: `src/extensions/gsd/settings.ts`, `src/extensions/gsd/commands.ts`, `src/extensions/gsd/resources.ts`
  - resources/docs: `overview.md`, `user-guide.md`, `command-reference.md`
  - tests: `test/gsd/commands.test.ts`, `test/gsd/resources.test.ts`
  - gap: no external CLI dependency in shipped code; future-facing prompt resources remain bundled but not fully exercised

- `Source Strategy`
  - code: `src/extensions/gsd/state/*`, `src/extensions/gsd/roles.ts`
  - resources/docs: `compatibility.md`, `checklist.md`
  - tests: `test/gsd/schema.test.ts`, `test/gsd/brownfield.test.ts`
  - gap: none for `.planning` compatibility promise

- `UX Contract`
  - code: `src/extensions/gsd/commands.ts`, `src/extensions/gsd/autocomplete.ts`, `src/extensions/gsd/ui.ts`, `src/extensions/gsd/help.ts`
  - resources/docs: `user-guide.md`, `command-reference.md`
  - tests: `test/gsd/commands.test.ts`, `test/gsd/ui.test.ts`
  - gap: none for shipped `/gsd` group behavior

- `MVP Scope`
  - code: `src/extensions/gsd/lifecycle/*`, `src/extensions/gsd/orchestration.ts`, `src/extensions/gsd/instant/*`
  - resources/docs: `overview.md`, `architecture.md`
  - tests: `test/gsd/lifecycle.test.ts`, `test/gsd/orchestration.test.ts`, `test/gsd/instant.test.ts`
  - gap: `new-project` is bootstrap-only, not full upstream research/roadmap orchestration; docs now reflect shipped bootstrap behavior rather than upstream parity

- `Non-Goals For v1`
  - code: absence of `pi-gsd-tools` runtime calls under `src/extensions/gsd/*`
  - resources/docs: `compatibility.md`, `overview.md`
  - tests: indirect via resource/command/state suite
  - gap: none

- `Architecture`
  - code: `src/extensions/gsd/*`, `src/resources/gsd/agents/*`, `src/resources/gsd/templates/*`
  - resources/docs: `architecture.md`, `overview.md`
  - tests: `test/gsd/*.test.ts`
  - gap: inactive bundled roles (`roadmapper`, `project-researcher`) are architecture-resident but not end-to-end covered

- `Proposed File Layout`
  - code: `src/extensions/gsd/*`, `src/resources/gsd/docs/*`, `src/resources/gsd/agents/*`, `src/resources/gsd/templates/*`
  - resources/docs: `overview.md`, `checklist.md`
  - tests: `test/gsd/resources.test.ts`
  - gap: none for shipped file presence

- `Extension Wiring Examples`
  - code: `src/extensions/gsd/index.ts`
  - resources/docs: `overview.md`
  - tests: `test/gsd/index.test.ts`
  - gap: none

- `Command Dispatch Examples`
  - code: `src/extensions/gsd/commands.ts`, `src/extensions/gsd/handlers.ts`
  - resources/docs: `overview.md`, `command-reference.md`
  - tests: `test/gsd/commands.test.ts`
  - gap: none

- `.planning Schema Examples`
  - code: `src/extensions/gsd/state/schema.ts`, `src/extensions/gsd/state/read.ts`, `src/extensions/gsd/state/markdown.ts`
  - resources/docs: `overview.md`, `compatibility.md`
  - tests: `test/gsd/schema.test.ts`, `test/gsd/brownfield.test.ts`
  - gap: none for covered upstream YAML/state shapes

- `Validation with Value.Check`
  - code: `src/extensions/gsd/state/schema.ts`, `src/extensions/gsd/subagents.ts`
  - resources/docs: `overview.md`
  - tests: `test/gsd/schema.test.ts`, `test/gsd/subagents.test.ts`
  - gap: none

- `Role Registry Examples`
  - code: `src/extensions/gsd/roles.ts`, `src/extensions/gsd/modes.ts`
  - resources/docs: `role-reference.md`, `overview.md`
  - tests: `test/gsd/modes.test.ts`, `test/gsd/subagents.test.ts`
  - gap: future-facing roles exist without lifecycle coverage; documented in `checklist.md`

- `Subagent Orchestration Examples`
  - code: `src/extensions/gsd/subagents.ts`, `src/extensions/gsd/orchestration.ts`, `src/extensions/gsd/lifecycle/discuss-phase.ts`, `src/extensions/gsd/lifecycle/map-codebase.ts`
  - resources/docs: `architecture.md`, `overview.md`
  - tests: `test/gsd/subagents.test.ts`, `test/gsd/orchestration.test.ts`, `test/gsd/lifecycle.test.ts`
  - gap: scale/throttling question remains future work outside boundary

- `Brownfield Detection Examples`
  - code: `src/extensions/gsd/state/detect.ts`, `src/extensions/gsd/context.ts`, `src/extensions/gsd/state/read.ts`
  - resources/docs: `compatibility.md`, `user-guide.md`
  - tests: `test/gsd/brownfield.test.ts`, `test/gsd/index.test.ts`
  - gap: none for valid upstream-style trees covered by fixture/tests

- `Instant Command Examples`
  - code: `src/extensions/gsd/instant/*`, `src/extensions/gsd/state/progress.ts`, `src/extensions/gsd/state/health.ts`, `src/extensions/gsd/state/stats.ts`, `src/extensions/gsd/state/runtime.ts`
  - resources/docs: `command-reference.md`, `user-guide.md`
  - tests: `test/gsd/instant.test.ts`, `test/gsd/roadmap.test.ts`
  - gap: none

- `Resource Loading Examples`
  - code: `src/extensions/gsd/resources.ts`
  - resources/docs: `checklist.md`
  - tests: `test/gsd/resources.test.ts`
  - gap: none for loadability; parity classification tracked separately

- `Testing Examples`
  - code: fixture-backed state/orchestration/lifecycle modules under `src/extensions/gsd/*`
  - resources/docs: `checklist.md`, `audit.md`
  - tests: `test/gsd/schema.test.ts`, `test/gsd/brownfield.test.ts`, `test/gsd/orchestration.test.ts`, `test/gsd/lifecycle.test.ts`, `test/gsd/resources.test.ts`, `test/gsd/ui.test.ts`
  - gap: inactive worker resources lack direct end-to-end tests

- `Decision Notes`
  - code: `src/extensions/gsd/commands.ts`, `src/extensions/gsd/modes.ts`, `src/extensions/gsd/state/read.ts`
  - resources/docs: `overview.md`, `architecture.md`
  - tests: `test/gsd/commands.test.ts`, `test/gsd/modes.test.ts`, `test/gsd/brownfield.test.ts`
  - gap: none for shipped decisions now listed as resolved

- `Resolved Decisions` / `Remaining Non-Blocking Questions`
  - code: `src/extensions/gsd/modes.ts`, `src/extensions/gsd/settings.ts`, `src/extensions/gsd/state/roadmap.ts`
  - resources/docs: `overview.md`, `compatibility.md`
  - tests: `test/gsd/modes.test.ts`, `test/gsd/roadmap.test.ts`, `test/gsd/commands.test.ts`
  - gap: only executor-throttling scale remains open and documented as outside boundary

- `Data Compatibility Boundary`
  - code: `src/extensions/gsd/state/*`
  - resources/docs: `compatibility.md`, `overview.md`
  - tests: `test/gsd/brownfield.test.ts`, `test/gsd/roadmap.test.ts`, `test/gsd/orchestration.test.ts`
  - gap: none for `STATE.md`, `ROADMAP.md`, `PLAN.md`, goals, milestones, todos, tasks, phase directories, brownfield continuation

- `Required Command Surface`
  - code: `src/extensions/gsd/commands.ts`, `src/extensions/gsd/handlers.ts`
  - resources/docs: `command-reference.md`, `user-guide.md`
  - tests: `test/gsd/commands.test.ts`
  - gap: none for registration/dispatch of required commands

- `Implementation Workstreams`
  - code: extension shell in `src/extensions/gsd/*`, docs/resources in `src/resources/gsd/docs/*`, `src/resources/gsd/agents/*`, `src/resources/gsd/templates/*`
  - resources/docs: `checklist.md`
  - tests: aggregate `test/gsd/*.test.ts`
  - gap: future-facing prompts remain bundled with documented limited runtime coverage

- `Testing Strategy`
  - code: test harness around state, command, lifecycle, orchestration, UI, resources
  - resources/docs: `overview.md`, `checklist.md`
  - tests: `test/gsd/*.test.ts`
  - gap: mocked orchestration strategy is shipped; no unresolved gap inside current boundary

- `Risk Areas` / `Success Metric`
  - code: `src/extensions/gsd/context.ts`, `src/extensions/gsd/state/*`, `src/extensions/gsd/orchestration.ts`
  - resources/docs: `audit.md`, `compatibility.md`
  - tests: `test/gsd/index.test.ts`, `test/gsd/brownfield.test.ts`, `test/gsd/orchestration.test.ts`
  - gap: success metric is evidenced only by automated tests, not manual long-running sessions

## Remaining Uncertainty

- bundled agents and templates were diffed against cached upstream sources in `~/.cache/checkouts/github.com/fulgidus/pi-gsd/gsd/agents/*` and `~/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/templates/*`
- template diffs audited so far are formatting/editorial only
- inactive bundled roles such as `roadmapper` and `project-researcher` remain future-facing resources; they are classified in `checklist.md`, but end-to-end runtime coverage for those roles is still incomplete
