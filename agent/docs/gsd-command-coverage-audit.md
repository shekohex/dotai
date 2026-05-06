# GSD Command Coverage Audit

Date: 2026-05-06

## Scope

This audit compares local built-in GSD command surface in `@shekohex/agent` against upstream `gsd-build/get-shit-done`, excluding namespace commands as primary comparison targets.

Focus:

- implemented local commands
- missing upstream commands
- upstream vs local workflow behavior
- prompt, workflow, template, artifact, and flag coverage
- where orchestration lives in TypeScript vs delegated markdown assets

## Method

Coverage score per command is out of 100.

Rubric:

- 25: command entrypoint parity
- 20: workflow control parity
- 20: prompt/resource parity
- 20: artifact/state parity
- 15: flags/subcommands/UX parity

Interpretation:

- 90-100: high parity
- 70-89: good adoption with limited deltas
- 40-69: partial implementation
- 1-39: thin shim or materially reduced behavior
- 0: not implemented

## Local Command Surface

Local GSD uses grouped `/gsd <subcommand>` command style instead of many top-level commands. Rationale: `src/resources/gsd/docs/overview.md:76-79`. Command registration and handler map: `src/extensions/gsd/commands.ts:10-29`, `src/extensions/gsd/commands.ts:36-90`, `src/extensions/gsd/handlers.ts:28-45`.

Implemented locally:

| Command              | Local shape                 | Upstream equivalent            | Coverage |
| -------------------- | --------------------------- | ------------------------------ | -------: |
| `new-project`        | TS-native bootstrap         | `new-project`                  |       20 |
| `new-milestone`      | workflow-launch shim        | `new-milestone`                |       92 |
| `complete-milestone` | workflow-launch shim        | `complete-milestone`           |       90 |
| `milestone-summary`  | workflow-launch shim        | `milestone-summary`            |       88 |
| `debug`              | hybrid TS + workflow-launch | `debug`                        |       84 |
| `map-codebase`       | TS-native orchestration     | `map-codebase`                 |       68 |
| `discuss-phase`      | TS-native orchestration     | `discuss-phase`                |       42 |
| `plan-phase`         | TS-native orchestration     | `plan-phase`                   |       55 |
| `execute-phase`      | TS-native orchestration     | `execute-phase`                |       46 |
| `verify-work`        | TS-native orchestration     | `verify-work`                  |       38 |
| `validate-phase`     | template stub               | `validate-phase`               |       15 |
| `progress`           | TS-native instant command   | `progress`                     |       24 |
| `next`               | local-only instant command  | derived from `progress --next` |       18 |
| `stats`              | TS-native instant command   | `stats`                        |       22 |
| `health`             | TS-native instant command   | `health`                       |       28 |
| `status`             | local-only runtime monitor  | none                           |       35 |
| `help`               | local docs viewer           | `help`                         |       30 |
| `on`                 | local enable toggle         | none                           |      100 |
| `off`                | local enable toggle         | none                           |      100 |

## Missing Commands

Upstream has 44 non-namespace commands still missing locally.

Missing non-namespace commands:

`add-tests`, `ai-integration-phase`, `audit-fix`, `audit-milestone`, `audit-uat`, `autonomous`, `capture`, `cleanup`, `code-review`, `config`, `docs-update`, `eval-review`, `explore`, `extract-learnings`, `fast`, `forensics`, `graphify`, `import`, `inbox`, `ingest-docs`, `manager`, `pause-work`, `phase`, `plan-review-convergence`, `pr-branch`, `profile-user`, `quick`, `resume-work`, `review`, `review-backlog`, `secure-phase`, `settings`, `ship`, `sketch`, `spec-phase`, `spike`, `thread`, `ui-phase`, `ui-review`, `ultraplan-phase`, `undo`, `update`, `workspace`, `workstreams`.

Upstream source roster: `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/*.md`. Command reference: `~/.cache/checkouts/github.com/gsd-build/get-shit-done/docs/COMMANDS.md:34-260`.

## Architecture Delta

### Upstream

Upstream is prompt-first. Command markdown selects workflow markdown and supporting templates/references. Examples:

- `new-project`: `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/new-project.md:21-46`
- `new-milestone`: `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/new-milestone.md:12-44`
- `plan-phase`: `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/plan-phase.md:17-60`
- `execute-phase`: `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/execute-phase.md:16-63`

### Local

Local product direction prefers TypeScript orchestration with bundled prompts as resources, not markdown-as-runtime. `src/resources/gsd/docs/overview.md:5-17`, `src/resources/gsd/docs/overview.md:86-104`.

Local split:

- command registration and arg parsing in TS: `src/extensions/gsd/commands.ts:36-90`, `src/extensions/gsd/args.ts:104-190`
- workflow-launch shim for selected commands: `src/extensions/gsd/workflow-launch.ts:42-76`, `src/extensions/gsd/workflow-launch.ts:124-163`
- native TS orchestration for core lifecycle commands: `src/extensions/gsd/orchestration.ts:129-258`
- built-in GSD role registry and subagent spawning: `src/extensions/gsd/roles.ts:22-199`, `src/extensions/gsd/subagents.ts:172-280`

Net effect:

- lifecycle setup is under local TS control
- only milestone/debug flows preserve upstream command+workflow assets closely
- core phase flows are reduced to thinner TS orchestrators

## Feature Matrix

Legend:

- `Y`: substantial parity
- `P`: partial
- `N`: missing
- `L`: local-only

| Command              | TS entry | Bundled local prompt/workflow | Upstream workflow reused | Structured outputs | Writes planning artifacts | Flag parity | Notes                        |
| -------------------- | -------: | ----------------------------: | -----------------------: | -----------------: | ------------------------: | ----------: | ---------------------------- |
| `new-project`        |        Y |                             N |                        N |                  N |                         P |           N | direct bootstrap only        |
| `new-milestone`      |        Y |                             Y |                        Y |                  N |                         Y |           P | forked workflow session      |
| `complete-milestone` |        Y |                             Y |                        Y |                  N |                         Y |           P | local tag-confirmation delta |
| `milestone-summary`  |        Y |                             Y |                        Y |                  N |                         Y |           P | local scope hint added       |
| `debug`              |        Y |                             Y |                        Y |                  P |                         Y |           P | `list/status` handled in TS  |
| `map-codebase`       |        Y |                             N |                        N |                  N |                         P |           N | full parallel map only       |
| `discuss-phase`      |        Y |                             N |                        N |                  Y |                         P |           N | uses `phase-researcher` role |
| `plan-phase`         |        Y |                             N |                        N |                  Y |                         P |           N | planner + checker only       |
| `execute-phase`      |        Y |                             N |                        N |                  N |                         P |           N | executor + verifier only     |
| `verify-work`        |        Y |                             N |                        N |                  Y |                         P |           N | verifier-only shortcut       |
| `validate-phase`     |        Y |                             N |                        N |                  N |                         P |           N | template stub                |
| `progress`           |        Y |                             N |                        N |                  N |                         N |           N | compact status only          |
| `next`               |        Y |                             N |                        N |                  Y |                         P |           L | local helper                 |
| `stats`              |        Y |                             N |                        N |                  N |                         N |           P | snapshot stats only          |
| `health`             |        Y |                             N |                        N |                  N |                         N |           N | no repair/context mode       |
| `status`             |        Y |                             N |                        N |                  N |                         N |           L | local subagent monitor       |
| `help`               |        Y |                             P |                        N |                  N |                         N |           P | local docs viewer            |

## Command Audit

### `new-project`

Coverage: 20/100

Upstream behavior:

- interactive unified flow: questioning -> optional research -> requirements -> roadmap -> approvals -> state creation. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/new-project.md:21-46`
- selects workflow and templates explicitly. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/new-project.md:35-41`

Local behavior:

- no command prompt or workflow asset
- direct TS bootstrap writes `config.json`, `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`, then seeds state. `src/extensions/gsd/lifecycle/new-project.ts:8-50`

Differences:

- no questioning
- no research
- no roadmap generation logic
- no approvals
- no workflow session fork

Templates:

- local uses `project.md`, `requirements.md`, `roadmap-empty.md`, `state.md`. `src/extensions/gsd/lifecycle/new-project.ts:28-43`

### `new-milestone`

Coverage: 92/100

Upstream behavior:

- command prompt delegates to `workflows/new-milestone.md` plus questioning, branding, project and requirements templates. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/new-milestone.md:12-44`

Local behavior:

- launches new workflow session with bundled local command/workflow resources. `src/extensions/gsd/lifecycle/new-milestone.ts:10-34`
- workflow launch prompt forces required reading before action. `src/extensions/gsd/workflow-launch.ts:42-76`
- extra resources include roadmap/state templates and project-researcher/roadmapper prompts. `src/extensions/gsd/lifecycle/new-milestone.ts:15-29`
- extra instructions patch local gaps: continue numbering by default, infer milestone history without `MILESTONES.md`. `src/extensions/gsd/lifecycle/new-milestone.ts:30-33`

Differences:

- local orchestration wrapper controls session creation
- local wrapper extends resource set beyond upstream command file
- small semantic patch for archive history handling

### `complete-milestone`

Coverage: 90/100

Upstream behavior:

- explicit audit gate, readiness/stat collection, archive generation, requirement archive, project update, commit/tag, next-step handoff. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/complete-milestone.md:12-140`

Local behavior:

- launches workflow session with local command/workflow bundle. `src/extensions/gsd/lifecycle/complete-milestone.ts:10-24`
- extra resources include archive, milestone, and retrospective templates. `src/extensions/gsd/lifecycle/complete-milestone.ts:15-19`
- local instructions change source of truth to `.planning/milestones/` and require explicit confirmation before tagging if needed. `src/extensions/gsd/lifecycle/complete-milestone.ts:20-23`

Differences:

- very close to upstream
- local git-tag caution adds a safer confirmation step
- local archive layout is explicit

### `milestone-summary`

Coverage: 88/100

Upstream behavior:

- reads milestone artifacts and writes `.planning/reports/MILESTONE_SUMMARY-v{version}.md`. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/milestone-summary.md:14-50`

Local behavior:

- workflow-launch shim with local command/workflow prompt bundle. `src/extensions/gsd/lifecycle/milestone-summary.ts:10-20`
- local instructions narrow reads to requested milestone and remind workflow to update `STATE.md` if applicable. `src/extensions/gsd/lifecycle/milestone-summary.ts:16-19`

Differences:

- close parity
- local wrapper adds scope control for large repos

### `debug`

Coverage: 84/100

Upstream behavior:

- command prompt delegates to debug workflow and supports `list`, `status`, `continue`, `--diagnose`. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/debug.md:13-52`

Local behavior:

- `list` and `status` are handled directly in TS from debug files. `src/extensions/gsd/lifecycle/debug.ts:57-86`, `src/extensions/gsd/state/debug.ts:55-66`
- `continue` and new debug sessions launch a dedicated workflow session in mode `gsd-debug-session-manager`. `src/extensions/gsd/lifecycle/debug.ts:90-118`
- prompt override injects structured XML-ish control block, forces visible-session intake, and bounds user report in `DATA_START` / `DATA_END`. `src/extensions/gsd/lifecycle/debug.ts:8-46`
- local parser handles subcommands and `--diagnose`. `src/extensions/gsd/args.ts:63-123`

Differences:

- stronger TS pre-routing than upstream prompt-first design
- local prompt hardens intake behavior and security framing
- local `list/status` output is compact, not full upstream formatted report

### `map-codebase`

Coverage: 68/100

Upstream behavior:

- supports full map, `--fast`, and `--query` intel modes. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/map-codebase.md:26-74`
- expects 4 parallel mapper agents and commit/next-step flow. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/map-codebase.md:62-82`

Local behavior:

- always runs four detached `codebase-mapper` roles. `src/extensions/gsd/lifecycle/map-codebase.ts:111-179`
- task text is generated in TS per focus area. `src/extensions/gsd/lifecycle/map-codebase.ts:39-109`
- supports `--paths` filtering only through local arg parser. `src/extensions/gsd/args.ts:126-159`
- async completion summary is emitted back into session. `src/extensions/gsd/lifecycle/map-codebase.ts:152-177`

Differences:

- no upstream `--fast`
- no upstream `--query status diff refresh`
- no explicit verification/commit gate in TS
- artifact set is similar: `STACK.md`, `INTEGRATIONS.md`, `ARCHITECTURE.md`, `STRUCTURE.md`, `CONVENTIONS.md`, `TESTING.md`, `CONCERNS.md`. `src/extensions/gsd/lifecycle/map-codebase.ts:16-20`

### `discuss-phase`

Coverage: 42/100

Upstream behavior:

- mode-routing command that selects discuss workflow vs assumptions workflow vs assumptions listing. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/discuss-phase.md:17-75`
- supports `--all`, `--auto`, `--chain`, `--batch`, `--analyze`, `--text`, `--power`, `--assumptions`. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/discuss-phase.md:3-15`, `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/discuss-phase.md:46-65`

Local behavior:

- no local command/workflow prompt for discuss-phase
- spawns `phase-researcher` role directly with only required-reading block and one instruction line. `src/extensions/gsd/lifecycle/discuss-phase.ts:57-73`
- expects structured JSON and writes `CONTEXT.md` via local template composition. `src/extensions/gsd/lifecycle/discuss-phase.ts:12-47`, `src/extensions/gsd/lifecycle/discuss-phase.ts:78-146`

Differences:

- no interactive gray-area selection loop
- no assumptions mode
- no flag support beyond phase selection
- prompt selection is replaced by direct role call
- decision numbering resets per area section because numbering is generated locally from each area list, not globally. `src/extensions/gsd/lifecycle/discuss-phase.ts:95-101`

### `plan-phase`

Coverage: 55/100

Upstream behavior:

- integrated research -> plan -> verify loop
- research-only mode, gap mode, reviews, bounce, PRD path, skip-research, skip-verify, other flags. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/plan-phase.md:17-60`

Local behavior:

- thin handler calls `orchestratePlanPhase`. `src/extensions/gsd/lifecycle/plan-phase.ts:5-11`
- planner task built from `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`, phase goal, requirements, success criteria. `src/extensions/gsd/orchestration.ts:129-152`
- plan-checker runs as separate structured role and writes local `PLAN-CHECK.md`. `src/extensions/gsd/orchestration.ts:154-180`, `src/extensions/gsd/orchestration.ts:260-298`, `src/extensions/gsd/state/reports.ts:65-109`
- plan files are generated locally from planner JSON. `src/extensions/gsd/state/reports.ts:6-63`

Differences:

- no explicit phase research loop in local command path
- no flag parity except phase selection
- no `--research-phase`, `--reviews`, `--bounce`, `--prd`, `--skip-*`
- no upstream workflow prompt selection
- local planner output is schema-constrained JSON, stronger than upstream freeform markdown prompt contract. `src/extensions/gsd/subagents.ts:12-53`, `src/extensions/gsd/subagents.ts:275-280`

### `execute-phase`

Coverage: 46/100

Upstream behavior:

- wave-based parallel execution, optional `--wave`, `--gaps-only`, `--interactive`, verification gating. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/execute-phase.md:16-63`

Local behavior:

- thin handler calls `orchestrateExecutePhase`. `src/extensions/gsd/lifecycle/execute-phase.ts:5-11`
- executor receives one short task string for whole phase. `src/extensions/gsd/orchestration.ts:300-317`
- verification is run immediately afterward by local verifier helper. `src/extensions/gsd/orchestration.ts:227-259`, `src/extensions/gsd/orchestration.ts:300-317`

Differences:

- no wave discovery/grouping in TS
- no `--wave`, `--gaps-only`, `--interactive`
- no orchestrator checkpoint protocol
- local flow is essentially `executor role` then `verifier role`

### `verify-work`

Coverage: 38/100

Upstream behavior:

- conversational UAT loop, persistent test session, diagnosis, fix planning, output to `UAT.md`. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/verify-work.md:14-38`

Local behavior:

- thin handler calls `orchestrateVerifyWork`. `src/extensions/gsd/lifecycle/verify-work.ts:5-11`
- implementation simply reuses local verifier structured role and writes `VERIFICATION.md`, `VALIDATION.md`, optional `UAT.md`. `src/extensions/gsd/orchestration.ts:227-259`, `src/extensions/gsd/state/reports.ts:111-228`

Differences:

- no conversational UAT
- no user-driven pass/fail intake
- no automatic gap/fix-plan creation workflow
- artifact shape differs because `UAT.md` is only emitted if verifier returns `uat_items`

### `validate-phase`

Coverage: 15/100

Upstream behavior:

- retroactively audits Nyquist validation coverage, can reconstruct from artifacts, can generate test files. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/validate-phase.md:15-35`

Local behavior:

- writes bundled `VALIDATION.md` template and updates state only. `src/extensions/gsd/lifecycle/validate-phase.ts:8-23`

Differences:

- no audit logic
- no reconstruction
- no test generation
- no workflow branching

### `progress`

Coverage: 24/100

Upstream behavior:

- standard report, `--next`, `--do`, `--forensic`, and routing into dedicated workflows. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/progress.md:13-44`

Local behavior:

- computes percent/bar/current phase/current plan and prints one-line summary. `src/extensions/gsd/instant/progress.ts:4-10`, `src/extensions/gsd/state/progress.ts:23-56`

Differences:

- no dispatch to next workflow
- no `--do`
- no `--forensic`
- no workflow prompts

### `next`

Coverage: 18/100

Upstream behavior:

- no standalone `next` command file; equivalent behavior lives under `progress --next`. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/progress.md:16-25`

Local behavior:

- computes next incomplete plan/phase from snapshots and updates `STATE.md`. `src/extensions/gsd/instant/next.ts:21-62`, `src/extensions/gsd/state/runtime.ts:68-138`

Differences:

- useful local helper
- not upstream command parity target
- no safety gates or command dispatch

### `stats`

Coverage: 22/100

Upstream behavior:

- dedicated workflow for broader project statistics. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/stats.md:8-18`

Local behavior:

- computes counts from planning snapshot and prints one-line summary. `src/extensions/gsd/instant/stats.ts:4-9`, `src/extensions/gsd/state/stats.ts:14-32`

Differences:

- no git metrics
- no timeline
- no requirements completion analysis beyond lightweight counts

### `health`

Coverage: 28/100

Upstream behavior:

- validates `.planning` integrity and supports `--repair` and `--context`. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/health.md:11-30`

Local behavior:

- checks core files plus missing summaries for plans and reports summary inline. `src/extensions/gsd/instant/health.ts:4-13`, `src/extensions/gsd/state/health.ts:18-54`

Differences:

- no repair mode
- no context-utilization mode
- much smaller rule set

### `status`

Coverage: 35/100

Upstream behavior:

- no upstream `status` command

Local behavior:

- shows active GSD subagents in UI or plain text. `src/extensions/gsd/instant/status.ts:57-177`

Assessment:

- useful local-only runtime introspection command
- should not be counted as upstream parity gap, only as additive local UX

### `help`

Coverage: 30/100

Upstream behavior:

- emits complete GSD reference content directly. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/help.md:7-24`

Local behavior:

- UI help component cycles bundled local docs and shows local command list. `src/extensions/gsd/help.ts:17-59`
- non-UI mode prints compact local reference header. `src/extensions/gsd/help.ts:91-105`

Differences:

- local help is a doc viewer, not strict upstream reference emission
- command list reflects local grouped surface, not upstream full surface

### `on` and `off`

Coverage: 100/100

Upstream behavior:

- no upstream equivalents

Local behavior:

- toggles built-in GSD extension. `src/extensions/gsd/commands.ts:45-53`

Assessment:

- complete for local product intent
- not parity work

## Prompt And Template Selection Summary

High-parity command setup lives in workflow-launch wrappers:

- `new-milestone`: `src/extensions/gsd/lifecycle/new-milestone.ts:10-34`
- `complete-milestone`: `src/extensions/gsd/lifecycle/complete-milestone.ts:10-24`
- `milestone-summary`: `src/extensions/gsd/lifecycle/milestone-summary.ts:10-20`
- `debug`: `src/extensions/gsd/lifecycle/debug.ts:90-118`

Shared workflow-launch behavior:

- constructs prompt with required reading and extra instructions. `src/extensions/gsd/workflow-launch.ts:42-76`
- forks or opens new session and injects steering prompt. `src/extensions/gsd/workflow-launch.ts:124-163`

Low-parity command setup lives in native TS orchestrators:

- `discuss-phase`: `src/extensions/gsd/lifecycle/discuss-phase.ts:49-153`
- `plan-phase`: `src/extensions/gsd/lifecycle/plan-phase.ts:5-11`, `src/extensions/gsd/orchestration.ts:129-298`
- `execute-phase`: `src/extensions/gsd/lifecycle/execute-phase.ts:5-11`, `src/extensions/gsd/orchestration.ts:300-317`
- `verify-work`: `src/extensions/gsd/lifecycle/verify-work.ts:5-11`, `src/extensions/gsd/orchestration.ts:227-259`
- `validate-phase`: `src/extensions/gsd/lifecycle/validate-phase.ts:8-23`

Template-driven artifact writing is local TS, not upstream workflow-directed, for:

- plan files and plan check: `src/extensions/gsd/state/reports.ts:6-109`
- verification, validation, UAT: `src/extensions/gsd/state/reports.ts:111-228`
- bootstrap files: `src/extensions/gsd/lifecycle/new-project.ts:28-43`

## Findings

1. Best-parity commands are `new-milestone`, `complete-milestone`, `milestone-summary`, and `debug` because they preserve upstream prompt/workflow assets and only patch local runtime concerns.
2. Core phase commands are implemented, but local versions are thinner than upstream and skip many command-level flags and workflow branches.
3. `new-project` is biggest behavior gap among implemented lifecycle commands. It is bootstrap only, not upstream project-init workflow.
4. `validate-phase`, `progress`, `stats`, and `health` are materially reduced local utilities rather than near-parity upstream implementations.
5. Local architecture is correct for control goals. Setup/orchestration is in TS. But parity depends on how much upstream workflow logic gets preserved in prompt resources vs collapsed into compact TS helpers.

## Recommended Priority Order

1. `new-project`
2. `verify-work`
3. `execute-phase`
4. `discuss-phase`
5. `validate-phase`
6. `progress`
7. `health`
8. `map-codebase` flag parity

Reason:

- these commands define main end-to-end phase loop and currently show largest workflow reduction vs upstream
- milestone flows already have strong parity

## Command Parity Delivery Plan

Recommended answer to "which command first?": start with `new-project`.

Reason:

- it is lowest-parity foundational command among core lifecycle commands
- every other command depends on good initial `.planning` state, config, requirements, roadmap, and workflow defaults
- once `new-project` is correct, later parity work becomes easier to test end-to-end

Execution strategy:

- one command per phase
- each phase ends with working command, focused tests, updated parity score, and audit/doc refresh
- preserve local TS control over command setup and dispatch
- only delegate actual work to prompts/subagents where appropriate

### Ordering Principles

1. fix bootstrap first
2. then fix main phase loop in usage order
3. then fix routing/status/support commands
4. then close major brownfield and UX gaps
5. then add advanced/optional upstream commands

### Phase Roadmap

| Phase | Command              | Current coverage | Priority | Why this order                                             | Definition of done                                                                                        |
| ----: | -------------------- | ---------------: | -------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
|    01 | `new-project`        |               20 | Critical | foundation for all new work                                | upstream-style questioning, optional research, requirements, roadmap, approvals, artifact creation, tests |
|    02 | `discuss-phase`      |               42 | Critical | first command in active phase loop                         | upstream mode routing, gray-area interview flow, assumptions mode, CONTEXT.md parity, tests               |
|    03 | `plan-phase`         |               55 | Critical | planning contract drives execution quality                 | research loop, flags, plan-check loop, artifacts, tests                                                   |
|    04 | `execute-phase`      |               46 | Critical | execution is core delivery engine                          | wave orchestration, filters, checkpoints, verification gating, tests                                      |
|    05 | `verify-work`        |               38 | Critical | closes phase loop and creates fix plans                    | conversational UAT, diagnosis, fix-plan generation, artifact parity, tests                                |
|    06 | `validate-phase`     |               15 | High     | retroactive quality gate still very incomplete             | Nyquist audit/reconstruction/test-gen behavior, tests                                                     |
|    07 | `progress`           |               24 | High     | primary situational router in upstream                     | report modes, `--next`, `--do`, `--forensic`, routing tests                                               |
|    08 | `health`             |               28 | High     | trust/safety command for `.planning` health                | repair/context modes, richer checks, tests                                                                |
|    09 | `map-codebase`       |               68 | High     | strong base exists, missing important branches             | `--fast`, `--query`, refresh flow, verification, tests                                                    |
|    10 | `stats`              |               22 | Medium   | support command, easy isolated parity work                 | richer metrics, git timeline, output parity, tests                                                        |
|    11 | `help`               |               30 | Medium   | docs UX, low risk                                          | reference parity or explicit local divergence, tests                                                      |
|    12 | `new-milestone`      |               92 | Medium   | already strong, polish after core loop                     | close remaining deltas, tests, audit refresh                                                              |
|    13 | `complete-milestone` |               90 | Medium   | already strong, depends on prior loop quality              | close remaining deltas, tests, audit refresh                                                              |
|    14 | `milestone-summary`  |               88 | Medium   | already strong, low-risk polish                            | close remaining deltas, tests, audit refresh                                                              |
|    15 | `debug`              |               84 | Medium   | already strong but important operationally                 | close formatting/reporting/subcommand gaps, tests                                                         |
|    16 | `next`               |               18 | Medium   | local helper, should align with `progress --next` contract | decide keep-as-local or fully align, tests                                                                |
|    17 | `status`             |               35 | Low      | local-only additive command                                | define local contract, docs, tests                                                                        |
|    18 | `on` / `off`         |              100 | Low      | complete local-only toggles                                | leave unless extension UX changes                                                                         |

### Missing Command Backlog Phases

After implemented commands reach acceptable parity, add missing upstream commands in this order.

#### Tier A: Core workflow expansion

| Phase | Command           | Why                                                       |
| ----: | ----------------- | --------------------------------------------------------- |
|    19 | `phase`           | roadmap mutation command unlocks closure phases and edits |
|    20 | `quick`           | common ad-hoc workflow, large practical value             |
|    21 | `ship`            | completes main delivery loop                              |
|    22 | `audit-milestone` | needed before robust milestone close parity               |
|    23 | `audit-uat`       | complements verify-work and release readiness             |
|    24 | `resume-work`     | important for reset recovery                              |
|    25 | `pause-work`      | important for handoff continuity                          |

#### Tier B: Quality and review

| Phase | Command                   | Why                                   |
| ----: | ------------------------- | ------------------------------------- |
|    26 | `code-review`             | major quality gate                    |
|    27 | `review`                  | cross-AI plan review loop dependency  |
|    28 | `plan-review-convergence` | higher-order planning quality command |
|    29 | `secure-phase`            | security parity                       |
|    30 | `audit-fix`               | auto-remediation pipeline             |
|    31 | `add-tests`               | complements validation and execution  |

#### Tier C: Brownfield and knowledge systems

| Phase | Command             | Why                                 |
| ----: | ------------------- | ----------------------------------- |
|    32 | `graphify`          | code intelligence platform feature  |
|    33 | `docs-update`       | doc generation/verification         |
|    34 | `extract-learnings` | reusable project intelligence       |
|    35 | `ingest-docs`       | bootstrap from docs                 |
|    36 | `import`            | external plan and migration support |

#### Tier D: Management and capture

| Phase | Command        | Why                                |
| ----: | -------------- | ---------------------------------- |
|    37 | `config`       | advanced config UX                 |
|    38 | `settings`     | simpler config UX                  |
|    39 | `capture`      | backlog/todo/seed pipeline         |
|    40 | `thread`       | persistent context threads         |
|    41 | `manager`      | power-user phase control center    |
|    42 | `workspace`    | multi-repo / worktree workflow     |
|    43 | `workstreams`  | parallel in-repo work tracking     |
|    44 | `inbox`        | management surface dependency      |
|    45 | `profile-user` | personalization, lower criticality |

#### Tier E: Exploration and optional specialist flows

| Phase | Command                | Why                            |
| ----: | ---------------------- | ------------------------------ |
|    46 | `explore`              | ideation flow                  |
|    47 | `spike`                | technical exploration          |
|    48 | `sketch`               | design exploration             |
|    49 | `spec-phase`           | specialized spec workflow      |
|    50 | `ui-phase`             | frontend contract              |
|    51 | `ui-review`            | frontend audit                 |
|    52 | `ai-integration-phase` | specialized AI-system planning |
|    53 | `eval-review`          | AI evaluation audit            |
|    54 | `ultraplan-phase`      | optional cloud planning path   |

#### Tier F: Recovery, release, and misc

| Phase | Command          | Why                           |
| ----: | ---------------- | ----------------------------- |
|    55 | `undo`           | safe rollback support         |
|    56 | `update`         | runtime update flow           |
|    57 | `cleanup`        | archive hygiene               |
|    58 | `forensics`      | workflow failure diagnostics  |
|    59 | `autonomous`     | high-level automation wrapper |
|    60 | `review-backlog` | backlog promotion             |
|    61 | `pr-branch`      | PR hygiene helper             |
|    62 | `fast`           | trivial inline task mode      |

## Per-Phase Checklist Template

Use this checklist for every command phase.

1. confirm scope of command and explicit non-goals
2. diff upstream command prompt, workflow, templates, references, and downstream artifacts
3. decide TS-owned orchestration boundaries vs delegated prompt-owned work
4. implement command setup/control flow in TS
5. preserve or bundle required prompt/workflow/template assets
6. add focused tests for args, routing, artifacts, and state transitions
7. run end-to-end happy-path verification where feasible
8. update this audit doc with new parity score, deltas, and references

## Phase-Specific Deliverables

Each command phase should produce:

- command behavior update
- tests for local handler/orchestration
- docs update in this audit file
- refreshed parity score
- explicit list of still-missing upstream features, if any

## Suggested Immediate Next Phase

Start with Phase 01: `new-project`.

Minimum target for that phase:

- replace direct bootstrap-only flow with workflow-driven initialization closer to upstream
- keep orchestration/setup in TS
- bundle and load upstream-equivalent command/workflow/templates locally
- add tests for init artifacts, interactive/auto path behavior, and state setup
