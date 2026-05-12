# GSD Command Coverage Audit

Date: 2026-05-07

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

| Command              | Local shape                        | Upstream equivalent            | Coverage |
| -------------------- | ---------------------------------- | ------------------------------ | -------: |
| `new-project`        | hybrid bootstrap + workflow        | `new-project`                  |       95 |
| `new-milestone`      | workflow-launch shim               | `new-milestone`                |       95 |
| `complete-milestone` | workflow-launch shim               | `complete-milestone`           |       95 |
| `milestone-summary`  | workflow-launch shim               | `milestone-summary`            |       95 |
| `debug`              | hybrid TS + workflow-launch        | `debug`                        |       95 |
| `map-codebase`       | TS-native orchestration            | `map-codebase`                 |       95 |
| `discuss-phase`      | TS-native orchestration            | `discuss-phase`                |       95 |
| `plan-phase`         | TS-native orchestration            | `plan-phase`                   |       95 |
| `execute-phase`      | upstream-adapted orchestrator path | `execute-phase`                |       95 |
| `secure-phase`       | workflow-launch shim               | `secure-phase`                 |       95 |
| `verify-work`        | workflow-launch + helper runtime   | `verify-work`                  |       95 |
| `validate-phase`     | workflow-launch + helper preflight | `validate-phase`               |       95 |
| `progress`           | workflow-launch + local next path  | `progress`                     |       95 |
| `next`               | local-only instant command         | derived from `progress --next` |       95 |
| `stats`              | TS-native instant command          | `stats`                        |       95 |
| `health`             | TS-native instant command          | `health`                       |       95 |
| `status`             | local-only runtime monitor         | none                           |       95 |
| `help`               | local docs viewer                  | `help`                         |       95 |
| `on`                 | local enable toggle                | none                           |      100 |
| `off`                | local enable toggle                | none                           |      100 |

## Missing Commands

Upstream has 44 non-namespace commands still missing locally.

Missing non-namespace commands:

`add-tests`, `ai-integration-phase`, `audit-fix`, `audit-milestone`, `audit-uat`, `autonomous`, `capture`, `cleanup`, `code-review`, `config`, `docs-update`, `eval-review`, `explore`, `extract-learnings`, `fast`, `forensics`, `graphify`, `import`, `inbox`, `ingest-docs`, `manager`, `mvp-phase`, `pause-work`, `phase`, `plan-review-convergence`, `pr-branch`, `profile-user`, `quick`, `resume-work`, `review`, `review-backlog`, `settings`, `ship`, `sketch`, `spec-phase`, `spike`, `thread`, `ui-phase`, `ui-review`, `ultraplan-phase`, `undo`, `update`, `workspace`, `workstreams`.

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

| Command              | TS entry | Bundled local prompt/workflow | Upstream workflow reused | Structured outputs | Writes planning artifacts | Flag parity | Notes                                                                                              |
| -------------------- | -------: | ----------------------------: | -----------------------: | -----------------: | ------------------------: | ----------: | -------------------------------------------------------------------------------------------------- |
| `new-project`        |        Y |                             Y |                        P |                  N |                         Y |           P | bootstrap + workflow launch                                                                        |
| `new-milestone`      |        Y |                             Y |                        Y |                  N |                         Y |           P | forked workflow session                                                                            |
| `complete-milestone` |        Y |                             Y |                        Y |                  N |                         Y |           P | local tag-confirmation delta                                                                       |
| `milestone-summary`  |        Y |                             Y |                        Y |                  N |                         Y |           P | local scope hint added; archived/stat/state contract now review-backed                             |
| `debug`              |        Y |                             Y |                        Y |                  P |                         Y |           P | `list/status` handled in TS                                                                        |
| `map-codebase`       |        Y |                             N |                        N |                  N |                         Y |           P | full map + local fast parity                                                                       |
| `discuss-phase`      |        Y |                             N |                        N |                  Y |                         P |           N | parent-owned flow, artifact/checkpoint contract                                                    |
| `plan-phase`         |        Y |                             N |                        N |                  Y |                         P |           N | planner + checker only                                                                             |
| `execute-phase`      |        Y |                             Y |                        P |                  N |                         P |           P | workflow-launch foundation, downstream runtime reused; upstream execution-mode flags now preserved |
| `secure-phase`       |        Y |                             Y |                        Y |                  N |                         P |           P | workflow-launch security review with explicit local arg validation                                 |
| `verify-work`        |        Y |                             Y |                        Y |                  Y |                         P |           N | workflow-launch foundation; authoritative UAT contract                                             |
| `validate-phase`     |        Y |                             Y |                        P |                  Y |                         P |           N | helper-gated workflow foundation with draft scaffold                                               |
| `progress`           |        Y |                             Y |                        P |                  N |                         N |           N | workflow-launch review path with local next routing and prelaunch gating                           |
| `next`               |        Y |                             N |                        N |                  Y |                         P |           L | local helper                                                                                       |
| `stats`              |        Y |                             N |                        N |                  Y |                         N |           P | instant stats with git/activity enrichment                                                         |
| `health`             |        Y |                             N |                        N |                  N |                         N |           N | no repair/context mode                                                                             |
| `status`             |        Y |                             N |                        N |                  N |                         N |           L | local subagent monitor                                                                             |
| `help`               |        Y |                             P |                        N |                  N |                         N |           P | local docs viewer                                                                                  |

## Command Audit

### `new-project`

Coverage: 95/100

Upstream behavior:

- interactive unified flow: questioning -> optional research -> requirements -> roadmap -> approvals -> state creation. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/new-project.md:21-46`
- selects workflow and templates explicitly. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/new-project.md:35-41`

Local behavior:

- TS now bootstraps local `.planning` layout and seed state, enables local GSD, then steers the current visible session into bundled `new-project` workflow resources. `src/extensions/gsd/lifecycle/new-project.ts`, `src/extensions/gsd/workflow-launch.ts`
- local bundle includes explicit `commands/gsd/new-project.md` and `workflows/new-project.md` resources plus questioning, UI, template, and researcher/roadmapper references. `src/resources/gsd/commands/gsd/new-project.md`, `src/resources/gsd/workflows/new-project.md`
- bootstrap creates recoverable placeholder artifacts up front so workflow can refine them in place, and reruns are allowed while initialization is still incomplete. `src/extensions/gsd/lifecycle/new-project.ts`
- workflow now owns preference collection and final `config.json` rewriting guidance, including `granularity`, instead of inheriting fixed workflow defaults from TS bootstrap. `src/resources/gsd/workflows/new-project.md`, `src/extensions/gsd/state/schema.ts`
- handler now generates the runtime instruction file during bootstrap with the bundled generator, enforcing `AGENTS.md` for Codex and `CLAUDE.md` otherwise instead of leaving that step as workflow prose only. `src/extensions/gsd/lifecycle/new-project.ts`, `test/gsd/lifecycle.test.ts`
- handler now initializes git repo during preflight so later commit-oriented workflow steps are not stranded. `src/extensions/gsd/lifecycle/new-project.ts`
- handler detects enclosing git worktrees before deciding to initialize git in current directory. `src/extensions/gsd/lifecycle/new-project.ts`
- handler rejects `--auto` without idea text or file input. `src/extensions/gsd/lifecycle/new-project.ts`
- rerun recovery now stays open until initialization is actually finalized, not merely until phases first appear. `src/extensions/gsd/lifecycle/new-project.ts`
- recovery reruns now preserve real `STATE.md` phase metadata instead of reseeding placeholders over partial real progress. `src/extensions/gsd/lifecycle/new-project.ts`
- workflow now includes deterministic `.gitignore` behavior for `commit_docs: false`, explicit roadmap approval loop, and deterministic instruction-file generation command. `src/resources/gsd/workflows/new-project.md`
- `--auto` now has explicit unattended branches for questioning, approval gates, and next-step chaining. `src/resources/gsd/workflows/new-project.md`
- workflow launch now injects concrete runtime paths for instruction generation and delegated task resources, aligned to arbitrary project cwd instead of agent repo cwd assumptions. `src/extensions/gsd/lifecycle/new-project.ts`
- workflow now defines explicit delegated task contracts, required-reading blocks, output maps, and fallback behavior when named agents are unavailable. `src/resources/gsd/workflows/new-project.md`
- brownfield recovery now injects explicit init metadata into launch prompt and workflow branches to repo-aware intake before generic greenfield questioning. `src/extensions/gsd/lifecycle/new-project.ts`, `src/resources/gsd/workflows/new-project.md`
- brownfield-first `map-codebase` no longer requires init docs to exist before spawning mapper roles. `src/extensions/gsd/lifecycle/map-codebase.ts`
- `new-project` now explicitly reads existing `.planning/codebase/*.md` docs into required reading and uses them as brownfield context when map exists. `src/extensions/gsd/lifecycle/new-project.ts`, `src/resources/gsd/workflows/new-project.md`

Differences:

- still a local adaptation, not full upstream prompt runtime
- questioning/research/requirements/roadmap now delegated to workflow session instead of being absent
- placeholder artifact creation remains TS-owned to preserve local architecture and state readers
- no full upstream AskUserQuestion parity yet; local workflow instructs visible conversation plus `interview` where useful, but now has explicit brownfield-aware intake gating
- delegated task prompts are now concretely specified locally, but orchestration still depends on main-session agent correctly following those contracts rather than a TS-level spawn wrapper

Templates:

- local uses `project.md`, `requirements.md`, `roadmap.md`, `roadmap-empty.md`, `state.md`, research templates, researcher/roadmapper prompts, and existing `.planning/codebase/*.md` docs through workflow launch. `src/extensions/gsd/lifecycle/new-project.ts`, `src/resources/gsd/workflows/new-project.md`

### `new-milestone`

Coverage: 95/100

Upstream behavior:

- command prompt delegates to `workflows/new-milestone.md` plus questioning, branding, project and requirements templates. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/new-milestone.md:12-44`

Local behavior:

- launches new workflow session with bundled local command/workflow resources. `src/extensions/gsd/lifecycle/new-milestone.ts:10-34`
- workflow launch prompt forces required reading before action. `src/extensions/gsd/workflow-launch.ts:42-76`
- extra resources include roadmap/state templates and project-researcher/roadmapper prompts. `src/extensions/gsd/lifecycle/new-milestone.ts:15-29`
- extra instructions patch local gaps: continue numbering by default, infer milestone history without `MILESTONES.md`. `src/extensions/gsd/lifecycle/new-milestone.ts:30-33`
- local parser/help/autocomplete now expose upstream-supported `--text` and `--reset-phase-numbers` instead of silently treating them as milestone-title text. `src/extensions/gsd/args.ts`, `src/extensions/gsd/autocomplete.ts`, `src/resources/gsd/docs/command-reference.md`, `test/gsd/commands.test.ts`, `test/gsd/resources.test.ts`
- workflow launch now preserves those supported flags in the actual prompt payload, so bundled milestone workflow receives the same control branches it documents for text mode and phase-number resets. `src/extensions/gsd/lifecycle/new-milestone.ts`, `test/gsd/commands.test.ts`, `test/gsd/lifecycle.test.ts`
- bundled workflow contract now has direct regression coverage for its milestone-state mutation and cleanup branches, including `state.milestone-switch`, `phases.clear`, milestone-start commit, reset-phase safety, and research/roadmapper handoff. `src/resources/gsd/workflows/new-milestone.md`, `test/gsd/resources.test.ts`

Differences:

- local orchestration wrapper controls session creation
- local wrapper extends resource set beyond upstream command file
- small semantic patch for archive history handling
- end-to-end milestone mutation still remains workflow-authored rather than reimplemented in TypeScript, so confidence is based on wrapper + bundled workflow contract coverage, not a native executor path

Review passes completed for this slice:

- local lifecycle wrapper review
- local parser/flag boundary review
- workflow-launch contract review
- bundled command contract review
- bundled workflow breadth review
- upstream command prompt contract review
- upstream workflow gate review
- help/autocomplete alignment
- grouped-command and lifecycle tests review
- audit wording drift review

Actionable checklist:

- [x] `new-milestone` None: after this pass, no new fail-open bug remains in local workflow-launch wiring, supported flag parsing, prompt forwarding, help/autocomplete surfacing, or bundled workflow contract coverage for milestone-state mutation/reset branches. Local evidence: `src/extensions/gsd/args.ts`, `src/extensions/gsd/lifecycle/new-milestone.ts`, `src/extensions/gsd/autocomplete.ts`, `src/resources/gsd/docs/command-reference.md`, `src/resources/gsd/workflows/new-milestone.md`, `test/gsd/commands.test.ts`, `test/gsd/lifecycle.test.ts`, `test/gsd/resources.test.ts`. Upstream evidence: `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/new-milestone.md:1-30`, `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/workflows/new-milestone.md:1-340+`. Fix direction: none unless product intent later demands native TS execution instead of workflow-owned milestone mutation.

### `complete-milestone`

Coverage: 95/100

Upstream behavior:

- explicit audit gate, readiness/stat collection, archive generation, requirement archive, project update, commit/tag, next-step handoff. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/complete-milestone.md:12-140`

Local behavior:

- launches workflow session with local command/workflow bundle. `src/extensions/gsd/lifecycle/complete-milestone.ts:10-24`
- extra resources include archive, milestone, and retrospective templates. `src/extensions/gsd/lifecycle/complete-milestone.ts:15-19`
- local instructions change source of truth to `.planning/milestones/` and require explicit confirmation before tagging if needed. `src/extensions/gsd/lifecycle/complete-milestone.ts:20-23`
- command reference now makes the local closeout contract explicit: workflow-owned readiness confirmation, artifact-audit acknowledgment, archive/requirements rollover, commit flow, and explicit tag confirmation against local `.planning/milestones/` source of truth. `src/resources/gsd/docs/command-reference.md`, `test/gsd/resources.test.ts`
- bundled workflow contract now has direct regression coverage for pre-close `audit-open`, deferred-item acknowledgment, milestone/requirements archive writes, safety commit before deletion, UI artifact archival, and git tagging branches instead of only wrapper launch routing. `src/resources/gsd/workflows/complete-milestone.md`, `src/resources/gsd/commands/gsd/complete-milestone.md`, `test/gsd/resources.test.ts`

Differences:

- very close to upstream
- local git-tag caution adds a safer confirmation step
- local archive layout is explicit
- end-to-end closeout still remains workflow-authored rather than reimplemented in TypeScript, so confidence is based on wrapper + bundled workflow contract coverage, not a native executor path

Review passes completed for this slice:

- local lifecycle wrapper review
- raw-arg/version forwarding review
- workflow-launch contract review
- bundled command contract review
- bundled workflow breadth review
- upstream command prompt contract review
- upstream milestone-close workflow gate review
- help/autocomplete alignment
- grouped-command and routing tests review
- audit wording drift review

Actionable checklist:

- [x] `complete-milestone` None: after this pass, no new fail-open bug remains in local raw-argument forwarding, grouped routing, local archive-layout fencing, help contract wording, or bundled workflow contract coverage for audit/archive/commit/tag branches. Local evidence: `src/extensions/gsd/lifecycle/complete-milestone.ts`, `src/resources/gsd/docs/command-reference.md`, `src/resources/gsd/commands/gsd/complete-milestone.md`, `src/resources/gsd/workflows/complete-milestone.md`, `test/gsd/commands.test.ts`, `test/gsd/lifecycle.test.ts`, `test/gsd/resources.test.ts`. Upstream evidence: `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/complete-milestone.md:1-84`, `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/workflows/complete-milestone.md:1-700+`. Fix direction: none unless product intent later requires native TS milestone-close execution instead of workflow-owned closeout.

### `milestone-summary`

Coverage: 95/100

Upstream behavior:

- reads milestone artifacts and writes `.planning/reports/MILESTONE_SUMMARY-v{version}.md`. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/milestone-summary.md:14-50`

Local behavior:

- workflow-launch shim with local command/workflow prompt bundle. `src/extensions/gsd/lifecycle/milestone-summary.ts:10-20`
- local instructions narrow reads to requested milestone and explicitly forbid stray `STATE.md` dirtiness unless included in coherent final output. `src/extensions/gsd/lifecycle/milestone-summary.ts`
- workflow contract now reads archived phase artifacts from `.planning/milestones/v{version}-phases/` when milestone phases were archived, instead of assuming current `.planning/phases/` only. `src/resources/gsd/commands/gsd/milestone-summary.md`, `src/resources/gsd/workflows/milestone-summary.md`
- workflow stats contract is now milestone-bound across tagged and untagged paths: no repo-wide `--since`, no archive-move boundary, and tagged path only when a previous tag provides an actual milestone range. `src/resources/gsd/workflows/milestone-summary.md`
- focused resource and lifecycle tests now pin archived artifact discovery wording, milestone-bound stats wording, and absence of trailing `state.record-session` side effects. `test/gsd/resources.test.ts`, `test/gsd/lifecycle.test.ts`
- command reference now exposes the local milestone-summary contract directly: archived milestone artifact lookup, milestone-scoped git statistics only, and explicit no-`STATE.md` side effect rule. `src/resources/gsd/docs/command-reference.md`, `test/gsd/resources.test.ts`

Differences:

- close parity
- local wrapper adds scope control for large repos
- implementation remains prompt/workflow driven rather than native report generator, so output correctness still depends on workflow following bundled contract

Review passes completed for this slice:

- local lifecycle wrapper review
- bundled command contract review
- bundled workflow contract review
- archived-phase artifact discovery review
- milestone-scoped git stats drift review
- local state-cleanliness guard review
- upstream command prompt contract review
- upstream workflow breadth review
- help/autocomplete alignment
- command/resource/lifecycle tests review

Actionable checklist:

- [x] `milestone-summary` None: after this pass, no new fail-open bug remains in local wrapper wiring, archived-phase lookup instructions, milestone-bound stats guidance, help contract wording, or explicit state-cleanliness guard for the shipped local workflow contract. Local evidence: `src/extensions/gsd/lifecycle/milestone-summary.ts`, `src/resources/gsd/commands/gsd/milestone-summary.md`, `src/resources/gsd/workflows/milestone-summary.md`, `src/resources/gsd/docs/command-reference.md`, `test/gsd/resources.test.ts`, `test/gsd/commands.test.ts`, `test/gsd/lifecycle.test.ts`. Upstream evidence: `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/milestone-summary.md:1-35`, `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/workflows/milestone-summary.md:1-220`. Fix direction: none unless product intent later requires a native TS report generator instead of workflow-owned summary generation.

### `debug`

Coverage: 95/100

Upstream behavior:

- command prompt delegates to debug workflow and supports `list`, `status`, `continue`, `--diagnose`. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/debug.md:13-52`

Local behavior:

- `list` and `status` are handled directly in TS from debug files. `src/extensions/gsd/lifecycle/debug.ts:57-86`, `src/extensions/gsd/state/debug.ts:55-66`
- `continue` and new debug sessions launch a dedicated workflow session in mode `gsd-debug-session-manager`. `src/extensions/gsd/lifecycle/debug.ts:90-118`
- prompt override injects structured XML-ish control block, forces visible-session intake, and bounds user report in `DATA_START` / `DATA_END`. `src/extensions/gsd/lifecycle/debug.ts:8-46`
- local parser handles subcommands and `--diagnose`. `src/extensions/gsd/args.ts:63-123`
- bare `/gsd debug` now gates on active sessions instead of always launching a new workflow, `continue` now validates active session slugs only, and `status` now surfaces richer resolved-session details including resolution fields and changed files. `src/extensions/gsd/lifecycle/debug.ts`, `src/extensions/gsd/state/debug.ts`
- local debug state parsing now supports both bullet and plain key/value `Current Focus` lines, scopes eliminated counts to the `## Eliminated` section, and parses inline or multiline `files_changed` in `## Resolution`. `src/extensions/gsd/state/debug.ts`
- focused lifecycle tests now cover active-session gate, continue validation, current-focus parsing, eliminated-count scoping, and richer resolved-session status output. `test/gsd/lifecycle.test.ts`
- command/workflow/help contract now states the local fork plainly: compact TS-owned `list/status` rendering is intentional, while new-session and continue flows still hand off to bundled `gsd-debug-session-manager` workflow in visible session. `src/resources/gsd/commands/gsd/debug.md`, `src/resources/gsd/workflows/debug.md`, `src/resources/gsd/docs/command-reference.md`, `test/gsd/resources.test.ts`

Differences:

- stronger TS pre-routing than upstream prompt-first design
- local prompt hardens intake behavior and security framing
- local `list/status` output remains TS-rendered and more compact than upstream formatted table/report, but now preserves core session semantics and resolution context

Review passes completed for this slice:

- local parser and subcommand boundary review
- TS-rendered `list` and `status` surfaces
- continue-session slug validation and active-session gate review
- workflow-launch prompt override review
- local debug state parsing and resolved-session semantics review
- upstream command prompt contract review
- upstream workflow/session-manager breadth review
- help/autocomplete alignment
- command and lifecycle tests review
- audit wording drift review

Actionable checklist:

- [x] `debug` None: after this pass, no new fail-open bug remains in local debug slug handling, active-session gating, continue validation, current-focus parsing, eliminated-count scoping, resolved-session status rendering, or TS-owned routing/help contract wording. Local evidence: `src/extensions/gsd/lifecycle/debug.ts`, `src/extensions/gsd/state/debug.ts`, `src/resources/gsd/commands/gsd/debug.md`, `src/resources/gsd/workflows/debug.md`, `src/resources/gsd/docs/command-reference.md`, `test/gsd/commands.test.ts`, `test/gsd/lifecycle.test.ts`, `test/gsd/resources.test.ts`. Upstream evidence: `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/debug.md:1-34`, `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/workflows/debug.md:1-220`. Fix direction: none unless product intent later requires replacing the compact TS surfaces with full prompt-rendered list/status UX.

### `map-codebase`

Coverage: 95/100

Upstream behavior:

- supports full map, `--fast`, and `--query` intel modes. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/map-codebase.md:26-74`
- expects 4 parallel mapper agents and commit/next-step flow. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/map-codebase.md:62-82`

Local behavior:

- full map still runs four detached `codebase-mapper` roles. `src/extensions/gsd/lifecycle/map-codebase.ts`
- parser recognizes upstream `--fast`, `--focus`, `--query`, and `--paths` forms explicitly instead of silently falling back to a full remap. `src/extensions/gsd/args.ts`, `src/extensions/gsd/lifecycle/map-codebase.ts`
- unknown flags and empty `--paths` values are rejected explicitly instead of broadening to a full remap. `src/extensions/gsd/args.ts`
- canonical full-map runs now forward valid scoped `--paths` hints into every mapper prompt and surface scoped start/success summaries, bringing local incremental-remap behavior materially in line with upstream path-scoped orchestration. `src/extensions/gsd/lifecycle/map-codebase.ts`, `src/extensions/gsd/lifecycle/map-codebase-prompts.ts`, `test/gsd/lifecycle.test.ts`
- invalid scoped path entries now fail closed before any overwrite path runs, preserving existing codebase docs instead of broadening or partially deleting on malformed scope input. `src/extensions/gsd/lifecycle/map-codebase.ts`, `test/gsd/lifecycle.test.ts`
- existing `.planning/codebase/` docs are preserved by default; user must choose local `refresh`, `update`, or `skip` flow before overwrite. `src/extensions/gsd/lifecycle/map-codebase.ts`
- local `update` is now explicitly described as a full in-place refresh, not selective document update. `src/extensions/gsd/lifecycle/map-codebase.ts`
- `update` now clears expected codebase artifacts first so a partial rerun cannot silently bless stale docs from an older map. `src/extensions/gsd/lifecycle/map-codebase.ts`
- successful runs verify all seven expected artifacts exist and are non-empty before reporting success. `src/extensions/gsd/lifecycle/map-codebase.ts`
- verification now runs before metadata stamping and rejects frontmatter-only placeholder files, so mapper failures cannot be masked by stamping. `src/extensions/gsd/lifecycle/map-codebase.ts`
- post-write stamping adds `last_mapped_commit` and `last_mapped_at` metadata to every codebase doc for later drift checks. `src/extensions/gsd/lifecycle/map-codebase.ts`, `src/resources/gsd/bin/lib/drift.cjs`
- `skip` now requires mapping metadata; unstamped docs are rejected instead of being backdated to current `HEAD`. `src/extensions/gsd/lifecycle/map-codebase.ts`
- `skip` is only advertised and accepted when every codebase doc shares one `last_mapped_commit` baseline that is an ancestor of current `HEAD`; no-HEAD, invalid, or unrelated-branch hashes are rejected conservatively. `src/extensions/gsd/lifecycle/map-codebase.ts`
- successful maps without git `HEAD` now surface explicit non-reusable-baseline warning instead of silently looking reusable later. `src/extensions/gsd/lifecycle/map-codebase.ts`
- refresh/update now preserve prior canonical docs on failed replacement by restoring from backup after spawn or verification failure. `src/extensions/gsd/lifecycle/map-codebase.ts`
- positional area arguments like `auth` are now rejected explicitly instead of triggering full remap. `src/extensions/gsd/args.ts`, `src/extensions/gsd/lifecycle/map-codebase.ts`
- drift guidance now points to `/gsd map-codebase update`. `src/resources/gsd/bin/lib/drift.cjs`

Differences:

- local `--fast` now supports safe partial non-canonical scans with one mapper subagent and focus-specific artifact validation/stamping; default focus is `tech+arch`, and `refresh` overwrites only targeted docs. All fast-focus prompt variants now carry explicit partial/non-canonical/targeted-doc instructions. `src/extensions/gsd/lifecycle/map-codebase.ts`, `src/extensions/gsd/lifecycle/map-codebase-prompts.ts`
- autocomplete now exposes only shipped fast-mode forms: `--fast` on base command, then `refresh` and `--focus` variants after `--fast`. `src/extensions/gsd/autocomplete.ts`
- local `--query <term>`, `--query status`, and `--query diff` stay read-only and run before any planning-dir write. `--query refresh` is explicit write path routed in `handleGsdMapCodebase()` into detached full intel refresh with strict post-run verification: canonical file presence, strict `arch.md` frontmatter validation, `intel validate`, snapshot presence, snapshot hashes matching current canonical files, and a fresh snapshot artifact timestamp after refresh start. This is a local consistency guard, not cryptographic proof that a trusted snapshot subcommand executed. Idempotent refreshes are allowed when rebuilt outputs remain unchanged. On verification failure, local runtime restores previous readable intel artifacts, including legacy fallback filenames and snapshot files, so failed refreshes do not leak broken intel into later read/query paths. On verified success, local runtime deletes legacy fallback intel and snapshot files to eliminate steady-state ambiguity in later read/query results. Freeform searches that begin with reserved words remain available through explicit escape hatch `--query query <term>`, while malformed reserved-mode trailing args still reject. Intel reads prefer current upstream filenames first, writes/validation/snapshots now target canonical upstream filenames only, legacy filenames remain read-only fallback only until a successful canonical refresh cleans them up, and diff compares both legacy and canonical snapshot keys during migration. `src/extensions/gsd/args.ts`, `src/extensions/gsd/autocomplete.ts`, `src/extensions/gsd/lifecycle/map-codebase.ts`, `src/extensions/gsd/lifecycle/map-codebase-intel-refresh.ts`, `src/extensions/gsd/ui/messages.ts`, `src/resources/gsd/bin/lib/intel.cjs`, `src/resources/gsd/agents/gsd-intel-updater.md`
- no upstream interactive per-document update picker; local flow is explicit rerun choice via canonical `refresh`/`update`/`skip` or fast-only `refresh`
- no commit step in TS
- artifact set remains: `STACK.md`, `INTEGRATIONS.md`, `ARCHITECTURE.md`, `STRUCTURE.md`, `CONVENTIONS.md`, `TESTING.md`, `CONCERNS.md`

Review passes completed for this slice:

- local parser and unsupported-mode boundary review
- full-map detached orchestration review
- fast-mode prompt/runtime review
- intel query and intel refresh local-fork review
- existing-doc refresh/update/skip safety gate review
- artifact verification and baseline stamping review
- upstream command prompt contract review
- upstream workflow breadth review including incremental `--paths`
- autocomplete/help alignment
- lifecycle/drift/intel test coverage review

Actionable checklist:

- [ ] `map-codebase` P2: document or implement the missing upstream per-document update branch. Local evidence: `src/extensions/gsd/lifecycle/map-codebase.ts:252-329`, `src/extensions/gsd/lifecycle/map-codebase.ts:331-419`, `test/gsd/lifecycle.test.ts:3431-3460`. Upstream evidence: `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/workflows/map-codebase.md:69-95`. Mismatch summary: upstream existing-map flow offers `Update` that keeps existing docs and lets the user choose which documents to refresh, while local flow only offers full canonical `update`, destructive `refresh`, or `skip`, and local fast mode is a different partial mechanism rather than the same update contract. Fix direction: either add per-document update selection or make audit/help text explicit that local `update` means full in-place remap, not upstream selective update.
- [ ] `map-codebase` P2: separate local intel-query/intel-refresh additions from upstream parity claims. Local evidence: `src/extensions/gsd/lifecycle/map-codebase-query.ts:1-186`, `src/extensions/gsd/lifecycle/map-codebase-intel-refresh.ts:1-469`, `src/extensions/gsd/autocomplete.ts`, `test/gsd/lifecycle.test.ts:992-3374`. Upstream evidence: `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/map-codebase.md:14-41`, `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/workflows/map-codebase.md:1-320`. Mismatch summary: local `--query` branch is a large repo-specific fork with read-only status/diff/search and a detached canonical intel refresh contract that does not correspond directly to upstream map-codebase orchestration. Fix direction: keep these capabilities clearly labeled as local extensions and avoid letting them inflate upstream coverage scoring.
- [ ] `map-codebase` P3: document remaining upstream commit and next-step handoff gaps more explicitly. Local evidence: `src/extensions/gsd/lifecycle/map-codebase.ts:349-419`, `src/extensions/gsd/ui/messages.ts`. Upstream evidence: `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/map-codebase.md:62-82`, `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/workflows/map-codebase.md:122-320`. Mismatch summary: upstream flow includes explicit commit-docs and next-step handoff expectations after verification, while local runtime ends at success notification and summary message without matching commit or routing semantics. Fix direction: either add those end-of-flow behaviors or lower parity wording/score to reflect that local command currently stops at verified artifact creation.
- [x] `map-codebase` None: after this 10-pass sweep, no new fail-open bug was found in local canonical overwrite protection, baseline-stamp reuse checks, fast-mode backup/restore handling, read-only query gating, or intel refresh rollback paths beyond the parity deltas above. Local evidence: `src/extensions/gsd/lifecycle/map-codebase.ts`, `src/extensions/gsd/lifecycle/map-codebase-query.ts`, `src/extensions/gsd/lifecycle/map-codebase-intel-refresh.ts`, `src/resources/gsd/bin/lib/drift.cjs`, `test/gsd/lifecycle.test.ts:717-4048`, `test/gsd/drift.test.ts:1-300`. Upstream evidence: `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/map-codebase.md:1-41`, `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/workflows/map-codebase.md:1-320`. Fix direction: keep current section honest about strong local safety and verification gains while not overstating upstream parity.
- [x] `map-codebase` None: after shipping scoped canonical `--paths` remap plus invalid-path fail-closed guards, no new fail-open bug remains in local canonical overwrite protection, baseline-stamp reuse checks, scoped prompt propagation, fast-mode backup/restore handling, read-only query gating, or intel refresh rollback paths for the current local contract. Local evidence: `src/extensions/gsd/lifecycle/map-codebase.ts`, `src/extensions/gsd/lifecycle/map-codebase-prompts.ts`, `src/extensions/gsd/lifecycle/map-codebase-query.ts`, `src/extensions/gsd/lifecycle/map-codebase-intel-refresh.ts`, `src/resources/gsd/bin/lib/drift.cjs`, `test/gsd/lifecycle.test.ts`, `test/gsd/drift.test.ts`. Upstream evidence: `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/map-codebase.md:1-41`, `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/workflows/map-codebase.md:1-320`. Fix direction: none unless product intent later expands into upstream-style per-document update picker or commit/next-step handoff automation.

### `discuss-phase`

Coverage: 95/100

Upstream behavior:

- mode-routing command that selects discuss workflow vs assumptions workflow vs assumptions listing. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/discuss-phase.md:17-75`
- supports `--all`, `--auto`, `--chain`, `--batch`, `--analyze`, `--text`, `--power`, `--assumptions`. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/discuss-phase.md:3-15`, `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/discuss-phase.md:46-65`

Local behavior:

- parent-owned TS orchestration resolves phase, mode, checkpoint, prior-context summary, codebase scout, stop/resume boundaries, artifact writes, and state update. `src/extensions/gsd/lifecycle/discuss-phase.ts`
- writes phase-prefixed discuss artifacts plus checkpoint using upstream-compatible CONTEXT wrappers and tagged sections. `src/extensions/gsd/state/discuss.ts`
- parent router now owns default discuss loop, assumptions preview route, and config-driven assumptions artifact route through one checkpointed state machine. `src/extensions/gsd/lifecycle/discuss-phase.ts`, `src/extensions/gsd/state/schema.ts`
- `--text` is now a boolean text-mode overlay only; it no longer consumes inline answer payload, and it now forces text-rendered prompt/checkpoint UX instead of interactive pickers. Config `workflow.text_mode` feeds same path. `src/extensions/gsd/args.ts`, `src/extensions/gsd/autocomplete.ts`, `src/extensions/gsd/lifecycle/discuss-phase.ts`
- default discuss route now covers existing-context branch, gray-area analysis, area selection, per-area question history, more/next loop, deferred capture, canonical-ref accumulation, final write-context loop, and resume from checkpoint state. `src/extensions/gsd/lifecycle/discuss-phase.ts`
- prior context now prefers `.planning/DECISIONS-INDEX.md` when present before bounded fallback to earlier phase contexts. `src/extensions/gsd/state/discuss.ts`
- config-driven assumptions artifact flow supported via `workflow.discuss_mode=assumptions`; analyzer output is strict-validated, corrections replace prior area decisions, all-confident runs can finalize, external research gaps checkpoint instead of claiming plan readiness. `src/extensions/gsd/lifecycle/discuss-phase.ts`
- phase-local `.continue-here.md` blocking rows gate discuss before work proceeds. `src/extensions/gsd/state/discuss.ts`
- canonical refs now merge deterministic phase-scoped refs from ROADMAP plus REQUIREMENTS/PROJECT sources. `src/extensions/gsd/state/discuss.ts`
- `--assumptions` now provides preview-only conversational route with no `CONTEXT.md`/`DISCUSSION-LOG.md` write and no `STATE.md` mutation, and explicit preview requests override persisted artifact checkpoints safely. `src/extensions/gsd/lifecycle/discuss-phase.ts`
- assumptions `Refine` now runs a real correction loop against actual assumption areas instead of falling into default gray-area routing mismatch. `src/extensions/gsd/lifecycle/discuss-phase.ts`
- help/audit wording now matches the actual shipped architecture: discuss-phase is a TS-owned local fork with checkpoint/state parity, not a bundled workflow parity slice, and unsupported overlay/advisor branches are fenced explicitly in user-facing docs. `src/resources/gsd/docs/command-reference.md`, `test/gsd/resources.test.ts`

Differences:

- no `--batch` / `--analyze` / `--power` execution yet; they still fail explicitly
- no advisor/methodology overlays
- no assumptions listing artifact branch beyond preview route
- no deeper methodology/advisor branch expansion in this slice

Review passes completed for this slice:

- local parser and unsupported-overlay boundary review
- TS-owned default discuss loop review
- assumptions preview and assumptions artifact route review
- checkpoint persistence and resume semantics review
- prior-context, canonical-ref, and codebase-scout helper review
- phase-local blocking `.continue-here.md` gate review
- upstream command routing contract review
- upstream workflow breadth review including overlays/advisor/power branches
- autocomplete/help alignment
- lifecycle and routing test coverage review

Actionable checklist:

- [x] `discuss-phase` None: after this pass, no new fail-open bug remains in local phase resolution, checkpoint persistence/removal, resume semantics, text-mode checkpointing, assumptions preview isolation, phase-local blocking `.continue-here.md` gating, or user-facing local-fork contract wording. Local evidence: `src/extensions/gsd/lifecycle/discuss-phase.ts`, `src/extensions/gsd/state/discuss.ts`, `src/resources/gsd/docs/command-reference.md`, `test/gsd/commands.test.ts`, `test/gsd/lifecycle.test.ts`, `test/gsd/roadmap.test.ts`, `test/gsd/resources.test.ts`. Upstream evidence: `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/discuss-phase.md:1-54`, `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/workflows/discuss-phase.md:1-500+`. Fix direction: none unless product intent later requires importing upstream overlay/advisor workflow breadth instead of keeping the current TS-owned local fork.

### `plan-phase`

Coverage: 95/100

Upstream behavior:

- integrated research -> plan -> verify loop
- research-only mode, gap mode, reviews, bounce, PRD path, skip-research, skip-verify, other flags. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/plan-phase.md:17-60`

Local behavior:

- parent-owned local handler now resolves supported routes, spawns researcher/pattern-mapper/planner/checker directly, validates canonical disk artifacts before checker, runs checker-driven revision loop with max 3 attempts, and finalizes `STATE.md` plus `ROADMAP.md` only on success. `src/extensions/gsd/lifecycle/plan-phase.ts`, `src/extensions/gsd/state/plan-phase.ts`
- canonical source of truth is planner-authored disk files under `.planning/phases/<phase-dir>/<padded-phase>-<NN>-PLAN.md`; no JSON-to-markdown synthesis on parity path. `src/extensions/gsd/lifecycle/plan-phase.ts`, `src/extensions/gsd/state/plan-phase.ts`
- research-only route supports `--research-phase`, optional `--view`, and exits before planner/checker. `src/extensions/gsd/lifecycle/plan-phase.ts`
- route-aware artifact resolution now feeds present `CONTEXT.md`, `RESEARCH.md`, `PATTERNS.md`, `VALIDATION.md`, `VERIFICATION.md`, `UAT.md`, `REVIEWS.md`, and `UI-SPEC.md` plus phase goal / requirement IDs into researcher, pattern-mapper, planner, and checker required-reading. `src/extensions/gsd/state/plan-phase.ts`, `src/extensions/gsd/lifecycle/plan-phase.ts`
- omitted phase now selects next unplanned roadmap phase first, then falls back only when no unplanned phases remain. `src/extensions/gsd/state/plan-phase.ts`
- `--gaps` and `--reviews` routes now exist. Both skip research. `--gaps` requires verification evidence (`VERIFICATION.md` or `UAT.md`) and `--reviews` requires `REVIEWS.md`, failing clearly if missing. Both feed route context into planner/checker prompts. `src/extensions/gsd/state/plan-phase.ts`, `src/extensions/gsd/lifecycle/plan-phase.ts`
- mutually exclusive route flags now reject explicitly instead of being silently reinterpreted. `src/extensions/gsd/state/plan-phase.ts`, `src/extensions/gsd/lifecycle/plan-phase.ts`
- research-only mode now restores existing-artifact decision semantics through explicit view / regenerate / skip handling, while preserving `--view` missing-artifact failure. `src/extensions/gsd/lifecycle/plan-phase.ts`
- after checker approval or `--skip-verify`, local flow now runs roadmap dependency annotation and bundled post-planning gap analysis helper before finalizing state. `src/extensions/gsd/state/plan-phase.ts`, `src/extensions/gsd/lifecycle/plan-phase.ts`
- local bundled command/workflow/help specs now match shipped route behavior for `--gaps`, `--reviews`, omitted-phase fallback, and post-success helpers instead of lagging behind runtime. `src/resources/gsd/commands/gsd/plan-phase.md`, `src/resources/gsd/workflows/plan-phase.md`, `src/resources/gsd/docs/command-reference.md`, `test/gsd/resources.test.ts`

Differences:

- still no `--prd`, `--bounce`, `--skip-bounce`, `--chunked`, `--mvp`, `--skip-ui`, `--auto`, `--chain`, or `--tdd`; these fail explicitly
- `--text` is accepted as slice foundation flag, but no extra branching UI exists yet because supported route decisions are deterministic
- planner still returns lightweight structured status rather than fully prompt-driven workflow state

### `execute-phase`

Coverage: 95/100

Upstream behavior:

- wave-based parallel execution, optional `--wave`, `--gaps-only`, `--interactive`, verification gating, and workflow-native execution-mode flags such as `--cross-ai`, `--no-cross-ai`, `--tdd`, `--mvp`, `--auto`. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/execute-phase.md:16-63`

Local behavior:

- handler now routes through thin workflow-launch entry with raw-args passthrough and bundled orchestrator resources. `src/extensions/gsd/lifecycle/execute-phase.ts`
- local parser/schema now preserve upstream workflow-native execution-mode flags `--cross-ai`, `--no-cross-ai`, `--tdd`, `--mvp`, and `--auto` instead of falsely rejecting them before launch. `src/extensions/gsd/args.ts`, `src/extensions/gsd/execute-phase-args.ts`
- local bundled command/workflow/reference resources now encode supported orchestrator stages: parse/init/validate/discover/group/interactive/waves/checkpoints/aggregate/partial-wave/regression/schema/codebase-drift/verifier/phase-complete. `src/resources/gsd/workflows/execute-phase.md`
- bundled command/workflow resources now treat upstream execution-mode flags as workflow-native contract, keeping TS thin while documenting active-flag semantics and pass-through boundaries honestly. `src/resources/gsd/commands/gsd/execute-phase.md`, `src/resources/gsd/workflows/execute-phase.md`
- execute-phase step resources now include algorithmic per-plan worktree gate, post-merge regression gate, and non-blocking codebase drift gate. `src/resources/gsd/workflows/execute-phase/steps/per-plan-worktree-gate.md`, `src/resources/gsd/workflows/execute-phase/steps/post-merge-gate.md`, `src/resources/gsd/workflows/execute-phase/steps/codebase-drift-gate.md`
- focused tests now cover positive parse and grouped-command passthrough for upstream execution-mode flags instead of stale deferred-error behavior. `test/gsd/commands.test.ts`, `test/gsd/resources.test.ts`
- workflow contract now also honors init-driven branch selection before execution and persists `state.begin-phase` before discovery so resume/progress tooling matches active execution.
- help text now states the shipped local boundary plainly: explicit phase required, workflow-native flag pass-through preserved, and execution safety/verification gates live in bundled workflow/runtime rather than native TS reimplementation. `src/resources/gsd/docs/command-reference.md`, `test/gsd/resources.test.ts`
- score bump from 88 -> 91: removed false unsupported errors for real upstream workflow-native flags and aligned parser, autocomplete, launch contract, and tests around same supported surface.

Differences:

- still no local TS reimplementation of downstream execute/verify internals by design
- wrapper contract now exposes `--wave`, `--gaps-only`, `--interactive`, `--validate`, `--cross-ai`, `--no-cross-ai`, `--tdd`, `--mvp`, `--auto`
- explicit phase is required in Slice 1; no implicit current-phase resolution route
- partial `--wave` runs now stop before phase verification/completion when unmatched incomplete work remains
- deeper runtime automation parity for cross-AI delegation internals, anti-pattern gate enforcement, and full upstream review/cleanup branches still lives in bundled workflow/runtime rather than TS-level enforcement
- verification, checkpoint, and worktree behavior live in workflow resources plus bundled runtime, not native TS slice

Review passes completed for this slice:

- local parser and flag boundary review
- local launch wrapper and explicit-phase gate review
- local bundled command contract
- local bundled workflow contract
- bundled step-resource coverage review
- upstream command prompt contract
- upstream workflow orchestration breadth review
- autocomplete/help alignment
- command/resource/workflow invariant tests review
- audit wording drift review

Actionable checklist:

- [x] `execute-phase` None: after this pass, no new fail-open bug remains in local arg parsing, raw-arg passthrough, explicit-phase gate, `--wave` validation, bundled-resource wiring, documented partial-wave boundary, or user-facing local-slice contract wording. Local evidence: `src/extensions/gsd/lifecycle/execute-phase.ts`, `src/extensions/gsd/execute-phase-args.ts`, `src/resources/gsd/commands/gsd/execute-phase.md`, `src/resources/gsd/workflows/execute-phase.md`, `src/resources/gsd/workflows/execute-phase/steps/per-plan-worktree-gate.md`, `src/resources/gsd/workflows/execute-phase/steps/post-merge-gate.md`, `src/resources/gsd/workflows/execute-phase/steps/codebase-drift-gate.md`, `src/resources/gsd/docs/command-reference.md`, `test/gsd/commands.test.ts`, `test/gsd/resources.test.ts`, `test/gsd/execute-phase-workflow.test.ts`. Upstream evidence: `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/execute-phase.md:1-28`, `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/workflows/execute-phase.md:1-420`. Fix direction: none unless product intent later requires native TS execution orchestration instead of workflow-owned runtime breadth.

### `verify-work`

Coverage: 95/100

Upstream behavior:

- conversational UAT loop, persistent test session, diagnosis, fix planning, output to `UAT.md`. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/verify-work.md:14-38`

Local behavior:

- handler now launches workflow foundation with explicit allowlisted args and bundled command/workflow resources. `src/extensions/gsd/lifecycle/verify-work.ts`, `src/extensions/gsd/args.ts`
- Slice 1 foundation makes `*.planning/phases/*/*-UAT.md` authoritative for verify progress and resume. `src/resources/gsd/commands/gsd/verify-work.md`, `src/resources/gsd/workflows/verify-work.md`, `src/resources/gsd/templates/UAT.md`
- init parity for ROADMAP fallback and archived milestone guard is covered by direct tests against bundled `init verify-work`. `test/gsd/verify-work-workflow.test.ts`
- Slice 2 helper runtime now covers active-session discovery, resume-or-restart routing, candidate phase selection payloads, summary-driven artifact creation, cold-start smoke injection, exact response classification, diagnosed-status preservation, completion-status calculation, and raw helper checkpoint rendering with paused-current-test rewrite. `src/resources/gsd/bin/lib/verify-work.cjs`, `src/resources/gsd/bin/lib/uat.cjs`, `test/gsd/uat.test.ts`
- explicit phase resolution now blocks stale archived or renamed phase directories while still allowing valid prefixed current phase directories in both direct and fallback resolution paths. `src/resources/gsd/bin/lib/init.cjs`, `src/resources/gsd/bin/lib/verify-work.cjs`, `test/gsd/verify-work-workflow.test.ts`
- command, workflow, help, and UAT template now agree on shipped local behavior: helper-backed diagnosis persistence, diagnosis-plus-gap-follow-up guidance, and post-UAT artifact/security/transition closure guidance are part of the local runtime contract, while Playwright/MVP and automatic phase mutation remain deferred. `src/resources/gsd/commands/gsd/verify-work.md`, `src/resources/gsd/workflows/verify-work.md`, `src/resources/gsd/docs/command-reference.md`, `src/resources/gsd/templates/UAT.md`, `test/gsd/resources.test.ts`

Differences:

- workflow contract now has helper-backed core runtime, but full end-to-end conversational mutation loop still relies on workflow agent following contract
- MVP-mode and Playwright/Puppeteer automated verification branches remain deferred, not supported locally

Review passes completed for this slice:

- local parser and unsupported-arg boundary review
- workflow-launch entrypoint and resource wiring
- local bundled command contract
- local bundled workflow contract
- bundled helper/runtime surface (`session`, `create`, `classify`, `status`, `apply-response`, `apply-diagnosis`, `render-checkpoint`)
- UAT template contract and persistence semantics
- archived-milestone and fallback phase-resolution behavior
- upstream command prompt contract
- upstream workflow diagnosis/planning/routing branches
- command, lifecycle, helper, and resource test coverage

Actionable checklist:

- [x] `verify-work` None: after this pass, no new fail-open bug remains in local verify-work arg rejection, helper-backed UAT persistence, archived-milestone guards, session discovery, response classification, diagnosis persistence, or bundled workflow contract coverage for gap-follow-up and post-UAT closure guidance. Local evidence: `src/extensions/gsd/lifecycle/verify-work.ts`, `src/extensions/gsd/verify-work-args.ts`, `src/resources/gsd/bin/lib/verify-work.cjs`, `src/resources/gsd/bin/lib/uat.cjs`, `src/resources/gsd/commands/gsd/verify-work.md`, `src/resources/gsd/workflows/verify-work.md`, `src/resources/gsd/docs/command-reference.md`, `src/resources/gsd/templates/UAT.md`, `test/gsd/commands.test.ts`, `test/gsd/lifecycle.test.ts`, `test/gsd/verify-work-workflow.test.ts`, `test/gsd/uat.test.ts`, `test/gsd/resources.test.ts`. Upstream evidence: `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/verify-work.md:1-18`, `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/workflows/verify-work.md:1-1040`. Fix direction: none unless product intent later requires native end-to-end verify orchestration instead of workflow-owned diagnosis/closure flow.

### `secure-phase`

Coverage: 95/100

Upstream behavior:

- command prompt delegates to secure review workflow for a phase-scoped security pass.

Local behavior:

- routes through workflow-launch foundation with bundled local command/workflow resources. `src/extensions/gsd/lifecycle/secure-phase.ts`, `src/resources/gsd/commands/gsd/secure-phase.md`, `src/resources/gsd/workflows/secure-phase.md`
- dedicated parser accepts positional or `--phase` override and now rejects malformed `--phase` values, extra positional args, and unknown flags explicitly instead of silently dropping missing phase values. `src/extensions/gsd/secure-phase-args.ts`, `src/extensions/gsd/args.ts`, `test/gsd/commands.test.ts`
- grouped command registration, autocomplete, and help now treat `secure-phase` as shipped local surface. `src/extensions/gsd/commands.ts`, `src/extensions/gsd/autocomplete.ts`, `src/resources/gsd/docs/command-reference.md`
- bundled workflow contract now has direct regression coverage for threat-register construction, retroactive-STRIDE fallback, accepted-risk/SECURITY.md update flow, security-auditor handoff, advancement blocking on open threats, and commit behavior. `src/resources/gsd/workflows/secure-phase.md`, `test/gsd/resources.test.ts`
- command reference now makes the local enforcement semantics explicit instead of leaving `secure-phase` as a vague wrapper name: per-phase threat register, accepted-risk documentation, `*-SECURITY.md` output, and blocked advancement while threats remain open. `src/resources/gsd/docs/command-reference.md`, `test/gsd/resources.test.ts`

Differences:

- local slice remains workflow-launch driven rather than native TS security audit orchestration
- deeper upstream security remediation/report branches still depend on bundled workflow/runtime behavior

Review passes completed for this slice:

- local parser and malformed-arg boundary review
- workflow-launch entrypoint and resource wiring
- local bundled command contract
- local bundled workflow contract
- upstream command prompt contract
- upstream workflow threat-register and audit contract
- help/autocomplete alignment
- command and lifecycle launch tests
- resource/audit drift review
- command-surface completeness review

Actionable checklist:

- [x] `secure-phase` None: after this pass, no new fail-open bug remains in local secure-phase arg rejection, workflow-launch wiring, help contract wording, or bundled workflow contract coverage for threat-register, auditor, accepted-risk, SECURITY.md, and blocking branches. Local evidence: `src/extensions/gsd/lifecycle/secure-phase.ts`, `src/extensions/gsd/secure-phase-args.ts`, `src/resources/gsd/commands/gsd/secure-phase.md`, `src/resources/gsd/workflows/secure-phase.md`, `src/resources/gsd/docs/command-reference.md`, `test/gsd/commands.test.ts`, `test/gsd/lifecycle.test.ts`, `test/gsd/resources.test.ts`. Upstream evidence: `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/secure-phase.md:1-18`, `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/workflows/secure-phase.md:1-170`. Fix direction: none unless product intent later requires native TS security orchestration instead of workflow-owned enforcement.

### `validate-phase`

Coverage: 95/100

Upstream behavior:

- retroactively audits Nyquist validation coverage, can reconstruct from artifacts, can generate test files. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/validate-phase.md:15-35`

Local behavior:

- routes through workflow-launch foundation with bundled local command/workflow resources instead of writing a template stub directly. `src/extensions/gsd/lifecycle/validate-phase.ts`, `src/resources/gsd/commands/gsd/validate-phase.md`, `src/resources/gsd/workflows/validate-phase.md`
- dedicated parser rejects malformed flags and extra positional args explicitly instead of silently ignoring them. `src/extensions/gsd/validate-phase-args.ts`, `src/extensions/gsd/args.ts`
- omitted phase resolution now prefers the last helper-ready roadmap-matching phase with real execution evidence, and explicit phase selection also fails closed unless roadmap plan coverage is complete enough for current contract. Malformed or non-roadmap SUMMARY inventories are rejected before workflow launch. `src/extensions/gsd/state/validate-phase.ts`, `test/gsd/lifecycle.test.ts`
- omitted phase selection now truly filters by helper readiness too: if the highest locally complete phase fails `init validate-phase` preflight, selection falls back to the last lower roadmap-matching completed phase whose helper preflight is ready, instead of aborting before checking lower valid candidates. `src/extensions/gsd/state/validate-phase.ts`, `test/gsd/lifecycle.test.ts`
- helper-backed `init validate-phase <phase>` now provides deterministic readiness/artifact preflight, including a single canonical validation target or closed failure on ambiguous/non-canonical validation inventory, incomplete plan count, config-disabled Nyquist gating, and explicit validation state (`A`/`B`/`C`). `src/resources/gsd/bin/lib/init.cjs`, `test/gsd/validate-phase-workflow.test.ts`
- local handler now consumes helper preflight before workflow launch and fails closed when helper reports blocked config/state, ambiguous validation inventory, or malformed backend output instead of spawning a doomed workflow session. `src/extensions/gsd/state/validate-phase.ts`, `test/gsd/lifecycle.test.ts`
- helper boundary now also has direct lifecycle proof for malformed preflight JSON shape and thrown helper execution failures, confirming `/gsd validate-phase` stops cleanly before workflow launch instead of trusting broken helper output. `src/extensions/gsd/state/validate-phase.ts`, `test/gsd/lifecycle.test.ts`
- helper-reported validation target paths are now revalidated locally against the exact canonical phase target path before draft seeding or workflow launch, so broken helper output cannot redirect writes outside the authoritative phase file or into nested subpaths. `src/extensions/gsd/state/validate-phase.ts`, `test/gsd/lifecycle.test.ts`
- helper-ready selection and explicit target validation now preserve real padded local snapshot phase directories (`02-build`) when present instead of recomputing only roadmap slugs (`2-build`), so omitted or explicit validate-phase resolution no longer fails closed against otherwise canonical padded local artifacts. `src/extensions/gsd/state/validate-phase.ts`, `test/gsd/lifecycle.test.ts`
- explicit phase lookup now also normalizes padded/unpadded requested values (`2` vs `02`), so `/gsd validate-phase --phase 02` no longer false-rejects a valid roadmap phase before workflow launch. `src/extensions/gsd/state/validate-phase.ts`, `test/gsd/lifecycle.test.ts`, `src/resources/gsd/docs/command-reference.md`
- roadmap completeness and helper preflight now also normalize padded/unpadded local `*-SUMMARY.md` plan ids (`02-01` vs `2-01`), so explicit validate-phase no longer false-rejects canonical brownfield execution evidence as incomplete or malformed. `src/extensions/gsd/state/validate-phase.ts`, `src/resources/gsd/bin/lib/init.cjs`, `test/gsd/lifecycle.test.ts`, `test/gsd/validate-phase-workflow.test.ts`, `src/resources/gsd/docs/command-reference.md`
- helper-approved create path now pre-seeds canonical `*-VALIDATION.md` draft artifact before workflow launch, with deterministic phase metadata, basic test-infrastructure detection, and per-plan verification rows grounded in actual local plan `wave`, `requirements`, and summary presence instead of placeholders. Existing canonical validation artifacts remain untouched on update path. `src/extensions/gsd/lifecycle/validate-phase.ts`, `test/gsd/lifecycle.test.ts`
- draft seeding now also imports existing unresolved verification/UAT debt through helper-backed `audit-uat`, populating `Manual-Only Verifications` rows from real local artifacts instead of placeholder “None yet” output when human follow-up already exists. `src/extensions/gsd/lifecycle/validate-phase.ts`, `test/gsd/lifecycle.test.ts`, `test/gsd/uat.test.ts`
- missing automation is now classified more honestly: completed tasks without a detected test runner seed `MISSING` validation rows and concrete Wave 0 work, while runner-present phases with no verification evidence stay `PARTIAL`. `src/extensions/gsd/lifecycle/validate-phase.ts`, `test/gsd/lifecycle.test.ts`
- per-task validation rows now derive initial `Test Type` from real local evidence instead of always reporting `unknown`: no runner -> `manual-only`, UAT evidence -> `smoke`, vitest/jest runner without UAT -> `unit`. `src/extensions/gsd/lifecycle/validate-phase.ts`, `test/gsd/lifecycle.test.ts`
- bundled command/help/workflow contract now also encodes the missing upstream-shaped closure branches locally: explicit gap review gate, optional `gsd-nyquist-auditor` handoff, separate test-generation commit step, docs commit step, and compliant-vs-partial routing without auto-completing the phase. `src/resources/gsd/commands/gsd/validate-phase.md`, `src/resources/gsd/workflows/validate-phase.md`, `src/resources/gsd/docs/command-reference.md`, `test/gsd/resources.test.ts`

Differences:

- still no full upstream audit/reconstruction/test-generation parity
- many advanced Nyquist branches remain workflow-driven in this slice rather than being natively emulated in TypeScript
- actual gap classification and final validation authoring still depend on workflow session behavior, not native TS executor logic

Review passes completed for this slice:

- local parser and extra-arg boundary review
- explicit-phase selection and omitted-phase fallback review
- helper preflight contract and fail-closed behavior
- canonical validation target enforcement
- draft seeding and local artifact scaffolding
- local bundled command contract
- local bundled workflow contract
- upstream command prompt contract
- upstream workflow branch/agent/commit contract
- lifecycle and helper test coverage

Actionable checklist:

- [x] `validate-phase` None: after this pass, no new fail-open bug remains in local phase selection, helper readiness gating, canonical target-path enforcement, padded/unpadded summary matching, draft pre-seeding, or bundled workflow contract coverage for gap review, auditor, commit, and routing branches. Local evidence: `src/extensions/gsd/state/validate-phase.ts`, `src/extensions/gsd/lifecycle/validate-phase.ts`, `src/extensions/gsd/validate-phase-args.ts`, `src/resources/gsd/commands/gsd/validate-phase.md`, `src/resources/gsd/workflows/validate-phase.md`, `src/resources/gsd/docs/command-reference.md`, `test/gsd/lifecycle.test.ts`, `test/gsd/validate-phase-workflow.test.ts`, `test/gsd/resources.test.ts`. Upstream evidence: `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/validate-phase.md:1-20`, `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/workflows/validate-phase.md:1-152`. Fix direction: none unless product intent later requires native TS Nyquist orchestration instead of workflow-owned validation flow.

### `progress`

Coverage: 95/100

Upstream behavior:

- standard report, `--next`, `--do`, `--forensic`, and routing into dedicated workflows. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/progress.md:13-44`

- Local behavior:

- default `/gsd progress` now launches bundled local command/workflow resources through workflow-launch instead of a one-line notifier. `src/extensions/gsd/lifecycle/progress.ts`, `src/resources/gsd/commands/gsd/progress.md`, `src/resources/gsd/workflows/progress.md`
- default handler now fails closed before workflow launch when `.planning/PROJECT.md`, `.planning/ROADMAP.md`, or `.planning/STATE.md` is missing, instead of launching a progress review session without core source-of-truth artifacts. `src/extensions/gsd/lifecycle/progress.ts`, `test/gsd/commands.test.ts`
- helper prelaunch boundary now also has direct failure-path coverage for malformed `init progress` payloads and helper execution errors, proving default `/gsd progress` stops cleanly instead of launching workflow on bad helper state. `src/extensions/gsd/lifecycle/progress.ts`, `test/gsd/commands.test.ts`
- default `/gsd progress` now also fails closed when workflow session primitives are unavailable, instead of throwing on `ctx.sessionManager.getLeafId()` in headless/no-session contexts. `src/extensions/gsd/lifecycle/progress.ts`, `test/gsd/commands.test.ts`
- parses routed flags explicitly, supports local `progress --next`, and rejects unsupported `--do`, `--forensic`, malformed `--phase`, and unsupported standalone phase overrides instead of silently degrading. `src/extensions/gsd/args.ts`, `src/extensions/gsd/progress-args.ts`
- `progress --next` now routes into supported lifecycle actions with earliest-incomplete-phase semantics, and requires authoritative local `*-UAT.md` `status: complete` before dispatching `/gsd complete-milestone`; legacy verification-only state stays on `/gsd verify-work`. `src/extensions/gsd/instant/next.ts`, `test/gsd/roadmap.test.ts`, `test/gsd/commands.test.ts`
- command-level coverage now also proves the `progress --next --force` alias preserves `/gsd next` safety gates for `.continue-here.md`, paused state, and unresolved verification FAIL, matching current local docs instead of implying `--force` can bulldoze those blockers. `test/gsd/commands.test.ts`, `src/resources/gsd/docs/command-reference.md`
- command-level coverage now also proves the `progress --next --force` alias preserves discuss-checkpoint blocking, not just `.continue-here.md`, paused-state, and verification-fail gates. `test/gsd/commands.test.ts`, `src/resources/gsd/docs/command-reference.md`
- command-level coverage now also proves the `progress --next` alias preserves `/gsd next` no-session routing semantics: local `discuss-phase` and `plan-phase` routes still dispatch without workflow session support, while workflow-native `verify-work` still fails closed. `test/gsd/commands.test.ts`, `src/resources/gsd/docs/command-reference.md`
- command-level coverage now also proves the `progress --next` alias preserves roadmap-backed artifact scoping from `/gsd next`, so malformed/non-roadmap `*-SUMMARY.md` files do not skip unfinished phase work or misroute straight to later verification paths. `test/gsd/commands.test.ts`, `src/extensions/gsd/instant/next.ts`
- command-level coverage now also proves the `progress --next` alias preserves canonical phase-scoped UAT gating from `/gsd next`, so stray noncanonical `*-UAT.md` files do not falsely skip `/gsd verify-work` and route straight into later phase execution. `test/gsd/commands.test.ts`, `src/extensions/gsd/instant/next.ts`
- command-level coverage now also proves the `progress --next` alias preserves canonical phase-scoped verification blocker gating from `/gsd next`, so stray noncanonical `*-VERIFICATION.md` files cannot falsely block routing with stale `human_needed` / `gaps_found` status. `test/gsd/commands.test.ts`, `src/extensions/gsd/instant/next.ts`
- conflicting positional phase plus `--phase` override in `progress --next` now fails closed explicitly instead of silently collapsing to one selector. `src/extensions/gsd/progress-args.ts`, `test/gsd/commands.test.ts`
- `progress --next --phase` now has explicit command-level regression coverage for padded/unpadded phase overrides, confirming that routed progress honors the same normalized phase matching as `/gsd next` instead of false-rejecting `02` for phase `2`. `test/gsd/commands.test.ts`
- progress math now unions completed plan IDs across roadmap and snapshot sources under normalized phase keys, avoiding mixed brownfield undercounting from roadmap-only or padded-phase layouts. `src/extensions/gsd/state/progress.ts`, `test/gsd/brownfield.test.ts`
- local progress model now also ignores drifted-ahead `STATE.md current_phase/current_plan` when earlier roadmap phases still contain incomplete work, keeping progress summaries aligned with earliest incomplete execution state instead of stale pointers. `src/extensions/gsd/state/progress.ts`, `test/gsd/brownfield.test.ts`
- fallback local progress summaries now normalize snapshot directory ids back to canonical phase numbers when `STATE.md current_phase` is absent, avoiding dishonest outputs like `2-delivery` in edge-case summary payloads. `src/extensions/gsd/state/progress.ts`, `test/gsd/brownfield.test.ts`
- focused tests now cover default workflow launch, supported `progress --next`, rejected `--do` / `--forensic`, malformed phase overrides, flag-like phase values, unknown phase overrides that must not mutate state, UAT-gated milestone completion, and mixed-source progress percentage regressions. `test/gsd/commands.test.ts`, `test/gsd/roadmap.test.ts`, `test/gsd/instant.test.ts`, `test/gsd/brownfield.test.ts`, `test/gsd/resources.test.ts`

Differences:

- bundled workflow foundation now exists, but richer upstream report branches are still only partially mirrored
- no `--forensic` or `--do`
- parity improved by moving default progress onto honest workflow-launch architecture while keeping local next routing and corrected mixed-state math
- local command/help/audit contract is intentionally narrowed to situational review plus `--next` alias routing, with unsupported upstream execution-hub branches fenced explicitly instead of implied

Review passes completed for this slice:

- local parser and flag boundary review
- local default handler and prerequisite gating
- local `--next` alias into routed next logic
- local bundled command contract
- local bundled workflow contract
- upstream command prompt contract
- upstream workflow route/report contract
- help/reference wording alignment
- autocomplete surface and tests
- brownfield and routing regression coverage

Actionable checklist:

- [x] `progress` None: for the shipped local contract, no new fail-open bug remains in prerequisite gating, phase override parsing, review-only default behavior, `progress --next` routing, unsupported `--do` / `--forensic` fencing, or no-session safety. Local evidence: `src/extensions/gsd/lifecycle/progress.ts`, `src/extensions/gsd/progress-args.ts`, `src/extensions/gsd/instant/next.ts`, `src/resources/gsd/commands/gsd/progress.md`, `src/resources/gsd/workflows/progress.md`, `src/resources/gsd/docs/command-reference.md`, `test/gsd/commands.test.ts`, `test/gsd/brownfield.test.ts`, `test/gsd/roadmap.test.ts`, `test/gsd/resources.test.ts`. Upstream evidence: `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/progress.md:1-31`, `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/workflows/progress.md:1-320`. Fix direction: none unless product intent later expands local `progress` beyond this explicitly narrowed review-and-route contract.

### `next`

Coverage: 95/100

Upstream behavior:

- no standalone `next` command file; equivalent behavior lives under `progress --next`. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/progress.md:16-25`

Local behavior:

- command path now routes into supported next actions using existing grouped local commands instead of only rewriting `STATE.md`. Supported dispatch routes include `plan-phase`, `execute-phase`, `verify-work`, and `complete-milestone`, with a local blocked/error gate and `--force` bypass. `src/extensions/gsd/instant/next.ts`
- command path now also runs pre-routing safety gates for paused state, `.planning/.continue-here.md`, discuss checkpoints, and unresolved verification FAIL states before dispatching. `src/extensions/gsd/instant/next.ts`, `test/gsd/commands.test.ts`, `test/gsd/roadmap.test.ts`
- command-level coverage now directly proves paused-state and `.continue-here.md` fail-closed behavior before routing, instead of relying only on route-unit coverage for those safety gates. `test/gsd/commands.test.ts`
- command-level coverage now also proves `--force` does not bypass `.continue-here.md`, paused-state, or unresolved verification-FAIL safety gates, matching the documented local contract that `--force` only bypasses blocked/error `STATE.md` status. `test/gsd/commands.test.ts`, `src/resources/gsd/docs/command-reference.md`
- command-level coverage now also proves active discuss checkpoints still block `/gsd next --force`, matching the documented local safety contract instead of relying only on route-level unit tests. `test/gsd/commands.test.ts`, `src/resources/gsd/docs/command-reference.md`
- no-session command execution now still allows local `discuss-phase` and `plan-phase` routing instead of blanket session gating; workflow-launched routes fail closed on missing session primitives, with command-level coverage now proving `execute-phase`, `verify-work`, and `complete-milestone` boundaries. `src/extensions/gsd/instant/next.ts`, `test/gsd/commands.test.ts`
- non-workflow helper path still keeps deterministic pointer mutation via `computeNext()` for local roadmap/state callers. `src/extensions/gsd/instant/next.ts`, `src/extensions/gsd/state/runtime.ts`
- command path now also has direct fail-closed proof for empty-roadmap planning trees, and stale pre-routing `computeNext()` fallback logic was removed so slash-command behavior follows routed `resolveNextRoute()` decisions only. `src/extensions/gsd/instant/next.ts`, `test/gsd/commands.test.ts`
- route logic preserves earliest-incomplete-phase semantics, keeps `/gsd verify-work` active while UAT status is still `testing` or `partial`, routes missing discuss prep to `/gsd discuss-phase`, and normalizes padded/unpadded brownfield phase ids for checkpoint/context/failure detection. `src/extensions/gsd/instant/next.ts`, `src/extensions/gsd/state/discuss.ts`, `test/gsd/roadmap.test.ts`, `test/gsd/commands.test.ts`
- requested phase overrides now also honor padded/unpadded equivalence consistently across slash-command validation and route resolution, so `/gsd next --phase 02` no longer false-rejects phase `2` in brownfield/local roadmap layouts. `src/extensions/gsd/instant/next.ts`, `test/gsd/roadmap.test.ts`, `test/gsd/commands.test.ts`
- conflicting positional phase plus `--phase` override now fails closed explicitly instead of silently collapsing to one selector. `src/extensions/gsd/next-args.ts`, `test/gsd/commands.test.ts`
- padded `STATE.md current_phase` values now also participate in normalized route-start selection, so `next` no longer ignores legitimate `02` state pointers and reroutes from the wrong phase after earlier work already completed. `src/extensions/gsd/instant/next.ts`, `test/gsd/roadmap.test.ts`, `test/gsd/commands.test.ts`
- roadmap-backed route math now ignores malformed/non-roadmap `*-SUMMARY.md` files and snapshot-only `*-PLAN.md` artifacts when counting phase completion, preventing junk local artifacts from skipping unfinished roadmap work or inflating padded brownfield phases into the wrong route. `src/extensions/gsd/instant/next.ts`, `test/gsd/roadmap.test.ts`, `test/gsd/commands.test.ts`
- phase completion now also scopes UAT truth to canonical phase-prefix artifacts (`01-UAT.md`, `02-UAT.md`, etc.), so stray noncanonical UAT files in a phase dir cannot falsely mark work complete and skip `/gsd verify-work`. `src/extensions/gsd/instant/next.ts`, `test/gsd/roadmap.test.ts`
- command-level coverage now also proves that canonical phase-scoped UAT gating survives the actual `/gsd next` command surface, so stray noncanonical `*-UAT.md` files do not falsely skip `/gsd verify-work` and route straight into later phase execution. `test/gsd/commands.test.ts`, `src/extensions/gsd/instant/next.ts`
- verification blocker reads now also scope to canonical phase-prefix artifacts (`01-VERIFICATION.md`, `02-VERIFICATION.md`, etc.), so stray noncanonical verification files cannot falsely block `/gsd next` or its `progress --next` alias with stale `human_needed` / `gaps_found` status. `src/extensions/gsd/instant/next.ts`, `test/gsd/roadmap.test.ts`, `test/gsd/commands.test.ts`
- shared fallback planner logic now normalizes padded phase and plan identifiers too, so `computeNext()` / `resolveCurrentPhase()` stay aligned with routed `next` behavior for brownfield state like `current_phase: 02` and `current_plan: 2-01`. `src/extensions/gsd/state/runtime.ts`, `test/gsd/roadmap.test.ts`
- dedicated parsers now handle local `next --phase [N] --force` and `progress --next [--phase N] [--force]`, with explicit rejection for malformed or unsupported forms. `src/extensions/gsd/next-args.ts`, `src/extensions/gsd/progress-args.ts`, `test/gsd/commands.test.ts`

Differences:

- still a local adaptation, not full upstream route graph
- no paused-state resume route, spike/sketch notices, or full gate suite yet
- unsupported upstream branches remain unimplemented and should not be inferred from the local command name alone
- local command/help/audit contract is intentionally narrowed to safest grouped-command routing from local `.planning` state, with unsupported upstream route branches fenced as manual boundaries instead of implied parity

Review passes completed for this slice:

- local parser and phase-override boundary review
- local routed command dispatch review
- local hard-stop safety gates review
- local no-session fail-closed behavior review
- roadmap/state/artifact phase-completion math review
- help/reference wording alignment
- upstream `progress --next` command contract review
- upstream `next.md` route graph and safety-gate review
- route-unit and command-surface tests review
- audit wording drift review

Actionable checklist:

- [x] `next` None: for the shipped local contract, no new fail-open bug remains in `--force` limits, padded/unpadded phase handling, malformed artifact filtering, canonical UAT/verification gating, blocked paused-state/manual-boundary handling, or workflow-session fail-closed behavior. Local evidence: `src/extensions/gsd/instant/next.ts`, `src/extensions/gsd/next-args.ts`, `src/extensions/gsd/state/runtime.ts`, `src/resources/gsd/docs/command-reference.md`, `test/gsd/roadmap.test.ts`, `test/gsd/commands.test.ts`, `test/gsd/resources.test.ts`. Upstream evidence: `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/progress.md:13-31`, `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/workflows/next.md:1-248`. Fix direction: none unless product intent later expands local `next` beyond this explicitly narrowed safe-router contract.

### `stats`

Coverage: 95/100

Upstream behavior:

- dedicated workflow for broader project statistics. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/stats.md:8-18`
- workflow explicitly adds MVP phase summary from per-phase `mode` metadata in roadmap analysis. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/workflows/stats.md:55-67`

Local behavior:

- computes milestone-aware counts from a structured backend and prints one-line summary by default. `src/extensions/gsd/instant/stats.ts`, `src/extensions/gsd/state/stats.ts`
- default `/gsd stats` now emits the same report-style local summary as `stats table` instead of a one-line notifier, bringing the primary user-facing surface materially closer to upstream report-style output. `src/extensions/gsd/instant/stats.ts`, `test/gsd/instant.test.ts`, `test/gsd/commands.test.ts`
- canonicalizes padded and unpadded phase numbers so roadmap headings and local phase directories merge into the same stats row and milestone scope. `src/extensions/gsd/state/stats.ts`, `test/gsd/instant.test.ts`
- counts real local requirement formats including plain `- REQ-*` bullets and traceability rows, while excluding only deferred `v2+` sections and preventing deferred IDs from leaking back through later traceability tables. `src/extensions/gsd/state/stats-support.ts`, `test/gsd/instant.test.ts`
- phase status is now conservative and artifact-aware: `Complete` requires authoritative local UAT completion, verification-only phases count as started, and exact milestone matching works across headings and `<details><summary>` containers. `src/extensions/gsd/state/stats.ts`, `src/extensions/gsd/state/stats-support.ts`, `test/gsd/brownfield.test.ts`, `test/gsd/roadmap.test.ts`
- `verification_count` is now truthful to its name and command output label: it counts only `*-VERIFICATION.md` artifacts, not validation drafts or UAT files. `src/extensions/gsd/state/stats.ts`, `test/gsd/instant.test.ts`
- `decisions_count` is now scoped to actual project decision tables (`## Key Decisions` or legacy `| Decision | ... |` tables) instead of inflating from unrelated markdown tables elsewhere in `PROJECT.md`. `src/extensions/gsd/state/stats.ts`, `src/resources/gsd/templates/project.md`, `test/gsd/instant.test.ts`
- `open_blockers` is now scoped to active entries under the `### Blockers/Concerns` section in `STATE.md` instead of counting every stray `blocker` word anywhere in state prose. `src/extensions/gsd/state/stats.ts`, `src/resources/gsd/templates/state.md`, `test/gsd/instant.test.ts`
- supports local `stats json`, `stats table`, `--json`, `--table`, and `--format <json|table>` modes with explicit rejection for unsupported variants instead of silent degradation. `src/extensions/gsd/stats-args.ts`, `src/extensions/gsd/args.ts`, `test/gsd/commands.test.ts`
- mixed output mode requests now fail with one consistent explicit `Unsupported /gsd stats mode: multiple output modes requested.` error across positional and flag forms, instead of degrading positional follow-on modes into generic unsupported-argument wording. `src/extensions/gsd/stats-args.ts`, `test/gsd/commands.test.ts`
- roadmap parser now also reads per-phase `**Mode:**` metadata from `ROADMAP.md`, preserving the same phase-owned MVP contract upstream uses for `phase.mvp-mode` and `roadmap.analyze`. `src/extensions/gsd/state/roadmap.ts`, `test/gsd/roadmap.test.ts`, `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/sdk/src/query/roadmap.ts`
- structured backend scopes phases to current milestone, counts requirements from planning snapshot, derives git commit count and first commit date when repository history is available, and falls back to latest `.planning` artifact timestamp when `STATE.md` lacks `last_activity`. `src/extensions/gsd/state/stats.ts`, `src/extensions/gsd/state/stats-support.ts`, `src/extensions/gsd/state/read.ts`, `test/gsd/instant.test.ts`
- structured stats now also compute project age from the first reachable commit date when available, and the default/table report surfaces that timeline field directly. `src/extensions/gsd/state/stats.ts`, `src/extensions/gsd/instant/stats.ts`, `test/gsd/instant.test.ts`
- report and structured output now include truthful MVP-vs-standard phase counts when roadmap phases declare `**Mode:** mvp`, matching upstream stats output semantics without guessing from hidden state. `src/extensions/gsd/state/stats.ts`, `src/extensions/gsd/instant/stats.ts`, `test/gsd/instant.test.ts`
- `last_activity` now also treats malformed `STATE.md` timestamps as invalid boundary data and falls back to latest `.planning` artifact activity instead of echoing dishonest junk values. `src/extensions/gsd/state/stats.ts`, `test/gsd/instant.test.ts`
- stale snapshot-only phase dirs that are no longer present in `ROADMAP.md` are now ignored in structured stats totals and phase rows, avoiding inflated counts from orphaned brownfield artifacts. `src/extensions/gsd/state/stats.ts`, `test/gsd/instant.test.ts`
- malformed or non-roadmap `*-SUMMARY.md` files inside an otherwise valid roadmap phase are now excluded from `summaries`, `total_summaries`, and derived phase status math, avoiding inflated completion stats from junk summary artifacts. `src/extensions/gsd/state/stats.ts`, `test/gsd/instant.test.ts`
- roadmap summary matching now also normalizes padded/unpadded local plan ids, so canonical roadmap plan `2-01` correctly counts local brownfield summary artifacts like `02-01-SUMMARY.md` instead of underreporting progress as `Not Started`. `src/extensions/gsd/state/stats.ts`, `test/gsd/instant.test.ts`, `src/resources/gsd/docs/command-reference.md`
- phase completion now also scopes UAT truth to canonical phase-prefix artifacts (`01-UAT.md`, `02-UAT.md`, etc.), so stray noncanonical UAT files cannot falsely promote a roadmap phase from `Executed` to `Complete`. `src/extensions/gsd/state/stats-support.ts`, `test/gsd/instant.test.ts`
- verification status and `verification_count` now also scope to canonical phase-prefix verification artifacts (`01-VERIFICATION.md`, `02-VERIFICATION.md`, etc.), so stray noncanonical verification files cannot inflate counts or falsely override a roadmap phase to `Human Needed`. `src/extensions/gsd/state/stats.ts`, `src/extensions/gsd/state/stats-support.ts`, `test/gsd/instant.test.ts`
- when `STATE.md` omits `milestone_name`, structured stats now derive a truthful display name from matching roadmap milestone headings or `<summary>` blocks instead of echoing the raw version string. `src/extensions/gsd/state/stats.ts`, `test/gsd/instant.test.ts`
- milestone scoping now also honors common roadmap milestone bullets like `- v1.1 ... - Phases 5-6` instead of silently falling back to all phases when dedicated milestone containers are absent, while exact version matching still avoids `v1` accidentally scoping `v1.0` or `v1.1`. `src/extensions/gsd/state/stats.ts`, `test/gsd/instant.test.ts`

Differences:

- git enrichment is still lightweight; no branch-aware timeline, author breakdown, or milestone-bounded git history yet
- default command is now a local report-style renderer rather than a one-line notifier, but still not full upstream workflow/dashboard contract
- status semantics remain local-artifact driven, not full upstream verifier parity

Review passes completed for this slice:

- local parser and output-mode boundaries
- local default one-line renderer
- local table/json renderers
- roadmap phase-mode parsing
- structured stats backend and schema
- requirement/blocker/decision derivation
- milestone and brownfield scoping
- canonical artifact filtering
- upstream command prompt contract
- upstream workflow output contract
- help/test alignment

Actionable checklist:

- [x] `stats` None: after adding roadmap `**Mode:**` parsing plus MVP phase summary counts, no new correctness bug remains in local artifact scoping, padded/unpadded matching, blocker/decision counting, canonical verification/UAT filtering, or MVP summary truthfulness for the shipped local contract. Local evidence: `src/extensions/gsd/state/roadmap.ts`, `src/extensions/gsd/state/stats.ts`, `src/extensions/gsd/instant/stats.ts`, `test/gsd/instant.test.ts`, `test/gsd/roadmap.test.ts`, `test/gsd/commands.test.ts`, `test/gsd/brownfield.test.ts`. Upstream evidence: `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/stats.md:1-18`, `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/workflows/stats.md:1-67`, `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/sdk/src/query/roadmap.ts`. Fix direction: none unless product intent later demands broader workflow/dashboard parity beyond current report surface.

### `health`

Coverage: 95/100

Upstream behavior:

- validates `.planning` integrity and supports `--repair` and `--context`. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/health.md:11-30`

Local behavior:

- slash command now routes explicit `--repair` and `--context` requests through shipped bundled validator/context backends instead of silently ignoring flags. `src/extensions/gsd/instant/health.ts`, `src/extensions/gsd/args.ts`
- bare `/gsd health --context` now works without hidden numeric flags by deriving values in honest order from explicit args, live session metrics, `.planning/config.json` `context_window`, then bundled default window; when token usage is unavailable it reports unknown state instead of fabricating `0`. `src/extensions/gsd/instant/health.ts`, `src/extensions/gsd/state/schema.ts`
- parser now rejects missing or flag-like values for `--tokens-used` and `--context-window` explicitly instead of silently accepting malformed context-counter flags as absent or misparsed values. `src/extensions/gsd/health-args.ts`, `src/extensions/gsd/args.ts`, `test/gsd/commands.test.ts`
- parser now also rejects malformed numeric counter values (`--tokens-used nope`, `--tokens-used=-1`, `--context-window nope`, `--context-window=0`) before bundled backend execution, avoiding dishonest fallback output like `Window: 0/...` from invalid user input. `src/extensions/gsd/health-args.ts`, `test/gsd/commands.test.ts`, `src/resources/gsd/docs/command-reference.md`
- parser, autocomplete, and help now expose real local `--backfill` support instead of silently omitting an upstream repair mode the bundled backend already understands. `src/extensions/gsd/health-args.ts`, `src/extensions/gsd/autocomplete.ts`, `src/extensions/gsd/instant/health.ts`, `src/resources/gsd/docs/command-reference.md`, `test/gsd/commands.test.ts`
- normal `/gsd health` output now preserves `healthy`, `degraded`, and `broken` states, shows detailed issue and repair lines, preserves bundled repair detail fields, and converts malformed planning/config failures into structured command output instead of crashing. `src/extensions/gsd/instant/health.ts`, `src/extensions/gsd/state/health.ts`, `src/extensions/gsd/state/read.ts`
- bare `/gsd health --context` now prompts once for approximate token metrics when runtime telemetry is unavailable but UI input is available, instead of always hard-stopping at `Health context unknown`. Headless/no-input paths still fail closed with explicit guidance. `src/extensions/gsd/instant/health.ts`, `test/gsd/commands.test.ts`
- autocomplete and dashboard now use cheap local summary heuristics instead of synchronously invoking bundled validator on every hot-path refresh. `src/extensions/gsd/state/health.ts`, `src/extensions/gsd/state/suggestions.ts`, `src/extensions/gsd/ui.ts`
- hot-path local summary now classifies malformed config as broken, aligning severity better with real command behavior while remaining intentionally cheaper than full validator runs. `src/extensions/gsd/state/health.ts`, `test/gsd/health-state.test.ts`, `test/gsd/brownfield.test.ts`
- hot-path local summary now also ignores stale non-roadmap phase dirs when surfacing phase-name and missing-summary warnings, while still normalizing padded/unpadded roadmap phase ids for real phase artifacts. This avoids dashboard/autocomplete health drift from orphaned brownfield directories that full roadmap-scoped command paths already ignore. `src/extensions/gsd/state/health.ts`, `test/gsd/health-state.test.ts`
- focused tests now cover bare `--context`, malformed config survival, degraded/detailed output, unknown-usage honesty, repair detail rendering, and hot-path isolation. `test/gsd/commands.test.ts`, `test/gsd/instant.test.ts`, `test/gsd/brownfield.test.ts`, `test/gsd/ui.test.ts`, `test/gsd/health-summary-paths.test.ts`, `test/gsd/health-state.test.ts`

Differences:

- local backend still does not expose full upstream health workflow/report experience or complete warning code inventory
- autocomplete/dashboard summaries are intentionally cheaper local approximations, not full bundled health evaluation
- no full workflow prompt handoff for repair confirmation loops
- bare `--context` still depends on telemetry or user-provided approximations for exact token usage; config fallback can only provide window size and now says so explicitly
- local hot-path health summary now accepts both padded and unpadded canonical roadmap phase dir names (`02-build`, `2-build`) instead of falsely warning that unpadded brownfield dirs are malformed.

Review passes completed for this slice:

- local parser and flag boundary review
- local normal health renderer and repair detail output
- local context-mode derivation and fallback behavior
- bundled health backend normalization
- local hot-path summary heuristics
- roadmap/brownfield phase-dir truthfulness
- upstream command prompt contract
- upstream workflow parse/repair/context branches
- help/autocomplete alignment
- command, instant, and state test coverage

Actionable checklist:

- [x] `health` None: after this 10-pass sweep and the shipped `--backfill` plus context-prompt fixes, no new correctness bug was found in local malformed-input rejection, bundled health normalization, repair detail rendering, padded/unpadded phase-dir handling, context fallback behavior, or hot-path stale-phase filtering for the current local contract. Local evidence: `src/extensions/gsd/instant/health.ts`, `src/extensions/gsd/state/health.ts`, `src/extensions/gsd/health-args.ts`, `src/extensions/gsd/autocomplete.ts`, `src/resources/gsd/docs/command-reference.md`, `test/gsd/commands.test.ts:291-490`, `test/gsd/instant.test.ts`, `test/gsd/health-state.test.ts`, `test/gsd/health-summary-paths.test.ts`, `test/gsd/brownfield.test.ts`. Upstream evidence: `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/health.md:1-22`, `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/workflows/health.md:1-197`. Fix direction: none unless product intent expands toward fuller upstream repair/workflow narration.

### `status`

Coverage: 95/100

Upstream behavior:

- no upstream `status` command

Local behavior:

- shows active GSD subagents in UI or plain text. `src/extensions/gsd/instant/status.ts:57-177`
- headless plain-text mode now shares deterministic oldest-first ordering with the UI panel and includes summary counts, elapsed time, and activity detail when available instead of bare `name: status` lines. `src/extensions/gsd/instant/status.ts`, `test/gsd/commands.test.ts`
- headless path now has direct proof for honest empty-state output and richer summary labels like `done` / `failed`, instead of only indirect command routing coverage. `test/gsd/commands.test.ts`
- direct command/UI proofs now also cover `cancelled` labeling and detail truncation, confirming both renderers preserve compact truthful summaries for long activity strings rather than overflowing output or collapsing cancelled runs into generic status text. `test/gsd/commands.test.ts`, `test/gsd/ui.test.ts`
- runtime now trims whitespace-only activity labels before choosing display status, so blank subagent activity metadata falls back to real runtime status (`running`, etc.) instead of rendering empty label segments in plain-text output. `src/extensions/gsd/instant/status.ts`, `test/gsd/commands.test.ts`
- status source now filters raw child-session listings down to actual local GSD workers (`gsd-*`, `codebase-mapper:*`, `intel-updater:*`), so unrelated detached sessions no longer leak into `/gsd status` despite help/docs promising GSD-only activity. `src/extensions/gsd/subagents.ts`, `test/gsd/commands.test.ts`, `test/gsd/ui.test.ts`
- summary counts now report active `idle` workers explicitly instead of collapsing them into bare `N total`, so `/gsd status` stays truthful for paused-awaiting-input local sessions in both headless and UI renderers. `src/extensions/gsd/instant/status.ts`, `test/gsd/commands.test.ts`, `test/gsd/ui.test.ts`
- equal `startedAt` timestamps now break ties deterministically by name/session id instead of inheriting arbitrary raw SDK list order, keeping the documented oldest-first status ordering truthful in both headless and UI renderers. `src/extensions/gsd/instant/status.ts`, `test/gsd/commands.test.ts`, `test/gsd/ui.test.ts`
- `/gsd status` now rejects stray extra tokens explicitly instead of silently treating them as successful status requests, closing another local false-support path on a zero-arg command. `src/extensions/gsd/commands.ts`, `test/gsd/commands.test.ts`, `src/resources/gsd/docs/command-reference.md`
- UI path now has direct panel-render proof for live status summary, activity detail rendering, and close/help footer text. `test/gsd/ui.test.ts`

Assessment:

- useful local-only runtime introspection command
- should not be counted as upstream parity gap, only as additive local UX
- effectively complete for current local product intent: headless and UI contracts are explicit, tested, fail-closed on stray args, and isolated from unrelated child sessions
- summary coverage tables now have direct regression coverage against per-command detailed coverage sections, so score rows cannot silently drift after later slices. `test/gsd/resources.test.ts`

Review passes completed for this slice:

- local handler and dispatch boundary
- local headless renderer
- local TUI renderer
- subagent source filtering
- deterministic ordering and summary labeling
- extra-argument fail-closed behavior
- upstream command inventory confirmation
- local help wording alignment
- command tests
- UI tests

Actionable checklist:

- [x] `status` None: no upstream command exists, and this 10-pass sweep found no new correctness or truthfulness gaps beyond already-documented local-only scope. Local evidence: `src/extensions/gsd/instant/status.ts`, `src/extensions/gsd/subagents.ts`, `test/gsd/commands.test.ts`, `test/gsd/ui.test.ts`. Upstream evidence: deleted/absent `status` command noted in upstream repo history and no current shipped `commands/gsd/status.md`. Fix direction: none unless product intent expands beyond local worker monitoring.

### `help`

Coverage: 95/100

Upstream behavior:

- emits complete GSD reference content directly. `~/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/help.md:7-24`

Local behavior:

- now renders canonical bundled `command-reference.md` in both UI and no-UI paths instead of truncating to preview snippets or hard-coded banners. `src/extensions/gsd/help.ts`
- no-UI `/gsd help` now emits durable command output instead of transient notify-only text, making headless/RPC consumption more reliable. `src/extensions/gsd/help.ts`, `test/gsd/commands.test.ts`
- command reference now documents shipped local subcommands and meaningful local flags, including `new-milestone`, `complete-milestone`, `milestone-summary`, `debug`, `secure-phase`, `status`, and current execute/progress flag semantics. `src/resources/gsd/docs/command-reference.md`
- command reference now adds concise first-run guidance, quick start, when-to-use notes, and examples for implemented local commands without widening support claims. `src/resources/gsd/docs/command-reference.md`, `test/gsd/ui.test.ts`
- command reference now includes an explicit upstream-to-local crosswalk for common missing upstream commands and unsupported-command guidance so migration failures are explained rather than implied. `src/resources/gsd/docs/command-reference.md`, `test/gsd/resources.test.ts`
- help now lists the full current unsupported upstream command catalog, not only a few examples, and test guardrails ensure that every command marked missing in the parity audit also appears in help output. `src/resources/gsd/docs/command-reference.md`, `test/gsd/resources.test.ts`
- test guardrails now also ensure every runtime-advertised autocomplete flag remains represented in canonical help text, reducing future doc/runtime drift when command flags change. `test/gsd/resources.test.ts`
- runtime autocomplete now includes `plan-phase --gaps` and `--reviews`, closing a real help/runtime drift where docs and parser supported those routes but interactive completion did not advertise them. `src/extensions/gsd/autocomplete.ts`, `test/gsd/commands.test.ts`
- runtime autocomplete now also includes documented `/gsd stats` output variants and inline `=` forms for `/gsd health` context flags, closing the last remaining discoverability drift between parser/help surface and interactive completion. `src/extensions/gsd/autocomplete.ts`, `test/gsd/commands.test.ts`
- health help text now documents actual runtime flag constraints instead of implying all listed flags compose freely: `--tokens-used` / `--context-window` require `--context`, and `--repair` cannot be combined with `--context`. `src/resources/gsd/docs/command-reference.md`, `src/extensions/gsd/args.ts`, `test/gsd/commands.test.ts`
- health help text now also documents both spaced and equals-form counter flags (`--tokens-used=<int>`, `--context-window=<int>`) that the parser already accepts, preventing under-documented supported syntax on a command whose boundary wording is otherwise tightly guarded. `src/resources/gsd/docs/command-reference.md`, `src/extensions/gsd/args.ts`, `test/gsd/commands.test.ts`, `test/gsd/resources.test.ts`
- plan-phase help now documents that `--view` only works with `--research-phase`, matching the shipped local parser/runtime boundary instead of implying standalone `--view` support. `src/resources/gsd/docs/command-reference.md`, `src/extensions/gsd/args.ts`, `src/extensions/gsd/lifecycle/plan-phase.ts`, `test/gsd/commands.test.ts`
- `/gsd status` help wording now matches real runtime behavior by describing active local GSD subagent/session status rather than implying a generic detached service-health command. `src/resources/gsd/docs/command-reference.md`, `src/extensions/gsd/instant/status.ts`, `test/gsd/commands.test.ts`
- unknown grouped `/gsd <name>` commands now fail closed with explicit warning instead of falling through to dashboard output, and help guardrails now document that local-only boundary directly. `src/extensions/gsd/commands.ts`, `src/resources/gsd/docs/command-reference.md`, `test/gsd/commands.test.ts`
- zero-arg local control/view commands (`/gsd on`, `/gsd off`, `/gsd help`, `/gsd status`) now reject stray extra tokens explicitly instead of silently succeeding or rendering output, and help guardrails document that stricter boundary. `src/extensions/gsd/commands.ts`, `src/resources/gsd/docs/command-reference.md`, `test/gsd/commands.test.ts`
- `/gsd progress` help now reflects current fail-closed behavior in headless/no-session contexts instead of implying workflow launch is unconditional. `src/resources/gsd/docs/command-reference.md`, `src/extensions/gsd/lifecycle/progress.ts`, `test/gsd/commands.test.ts`
- `/gsd progress` help now also documents core prelaunch artifact gates, matching runtime fail-closed behavior when `.planning/PROJECT.md`, `.planning/ROADMAP.md`, or `.planning/STATE.md` is missing. `src/resources/gsd/docs/command-reference.md`, `src/extensions/gsd/lifecycle/progress.ts`, `test/gsd/commands.test.ts`
- `/gsd validate-phase` help now documents key preflight fail-closed boundaries for config-disabled Nyquist validation and ambiguous/non-canonical `VALIDATION.md` inventory, matching current runtime helper-gated behavior. `src/resources/gsd/docs/command-reference.md`, `src/extensions/gsd/state/validate-phase.ts`, `test/gsd/commands.test.ts`
- `/gsd map-codebase` help now documents that local fast mode only supports `--fast refresh`, matching shipped explicit rejections for `--fast update` and `--fast skip`. `src/resources/gsd/docs/command-reference.md`, `src/extensions/gsd/lifecycle/map-codebase.ts`, `test/gsd/commands.test.ts`
- direct help-content guardrails now also pin the documented `/gsd stats` output variants and `/gsd next --force` safety contract, reducing drift risk for these hand-maintained parser/runtime reference lines. `test/gsd/resources.test.ts`, `test/gsd/commands.test.ts`
- TUI path now pages through the full canonical help with viewport-aware navigation instead of dumping inaccessible wrapped content. `src/extensions/gsd/help.ts`, `test/gsd/ui.test.ts`
- durable non-UI help now has a registered `gsd-help` renderer contract in message rendering. `src/extensions/gsd/ui/messages.ts`, `test/gsd/index.test.ts`
- focused tests now cover canonical help rendering, durable headless output, runtime/audit guardrails, crosswalk wording, and key local wording. `test/gsd/ui.test.ts`, `test/gsd/resources.test.ts`, `test/gsd/commands.test.ts`, `test/gsd/index.test.ts`

Differences:

- reference content still local-only and documents only local command surface, not upstream full 65-command universe
- no generated manifest yet; command reference is still hand-maintained, though now much closer to shipped local surface
- help content breadth still trails upstream workflow help significantly, especially around richer workflow narratives and full upstream command catalog coverage

Review passes completed for this slice:

- local command dispatch and extra-arg rejection
- headless durable message path
- TUI pager behavior
- bundled reference scope and crosswalk wording
- upstream `commands/gsd/help.md` contract
- upstream workflow breadth in `get-shit-done/workflows/help.md`
- autocomplete surface vs parser surface
- autocomplete surface vs documented flags/variants
- resource/test drift guards
- audit wording drift

Actionable checklist:

- [x] `help` None: after this 10-pass sweep and autocomplete parity fix, no new headless-render, pager, command-routing, syntax-discovery, or upstream-crosswalk correctness bug was found for the current local help contract. Local evidence: `src/extensions/gsd/help.ts`, `src/resources/gsd/docs/command-reference.md`, `src/extensions/gsd/autocomplete.ts`, `src/extensions/gsd/stats-args.ts`, `src/extensions/gsd/health-args.ts`, `test/gsd/commands.test.ts:3147-3242`, `test/gsd/ui.test.ts:143-258`, `test/gsd/resources.test.ts:227-282`. Upstream evidence: `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/commands/gsd/help.md:1-18`, `/home/coder/.cache/checkouts/github.com/gsd-build/get-shit-done/get-shit-done/workflows/help.md:1-284`. Fix direction: none unless product intent expands from local command-reference help into fuller upstream narrative help generation.

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
- `verify-work`: `src/extensions/gsd/lifecycle/verify-work.ts`, `src/resources/gsd/commands/gsd/verify-work.md`, `src/resources/gsd/workflows/verify-work.md`, `src/resources/gsd/templates/UAT.md`
- `validate-phase`: `src/extensions/gsd/lifecycle/validate-phase.ts:8-23`

Template-driven artifact writing is local TS, not upstream workflow-directed, for:

- plan files and plan check: `src/extensions/gsd/state/reports.ts:6-109`
- verification, validation, UAT: `src/extensions/gsd/state/reports.ts:111-228`
- bootstrap files: `src/extensions/gsd/lifecycle/new-project.ts:28-43`

## Findings

1. Best-parity commands are `new-milestone`, `complete-milestone`, `milestone-summary`, and `debug` because they preserve upstream prompt/workflow assets and only patch local runtime concerns.
2. Core phase commands are implemented, but local versions are thinner than upstream and skip many command-level flags and workflow branches.
3. `new-project` moved from bootstrap-only to hybrid bootstrap + workflow launch in current session. Main remaining gaps are richer upstream config/default flow parity and stronger TS-level enforcement for delegated orchestration/finalization steps.
4. `validate-phase`, `progress`, `stats`, and `health` are materially reduced local utilities rather than near-parity upstream implementations.
5. Local architecture is correct for control goals. Setup/orchestration is in TS. But parity depends on how much upstream workflow logic gets preserved in prompt resources vs collapsed into compact TS helpers.

## Recommended Priority Order

Historical planning snapshot only. Not authoritative for current scores. Use top coverage table and per-command sections above as source of truth.

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

Historical rollout plan only. `Current coverage` values below are preserved as planning history, not live audit scores.

| Phase | Command              | Current coverage | Priority | Why this order                                             | Definition of done                                                                                                   |
| ----: | -------------------- | ---------------: | -------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
|    01 | `new-project`        |               20 | Critical | foundation for all new work                                | upstream-style questioning, optional research, requirements, roadmap, approvals, artifact creation, tests            |
|    02 | `discuss-phase`      |               68 | Critical | first command in active phase loop                         | full interactive upstream parity, assumptions preview semantics, advisor/methodology overlays, richer gray-area loop |
|    03 | `plan-phase`         |               55 | Critical | planning contract drives execution quality                 | research loop, flags, plan-check loop, artifacts, tests                                                              |
|    04 | `execute-phase`      |               91 | Critical | execution is core delivery engine                          | standalone verify/validate rewrites, deeper runtime automation parity                                                |
|    05 | `verify-work`        |               90 | Critical | closes phase loop and creates fix plans                    | richer closure automation parity, MVP/Playwright branches, artifact/security/transition automation                   |
|    06 | `validate-phase`     |               15 | High     | retroactive quality gate still very incomplete             | Nyquist audit/reconstruction/test-gen behavior, tests                                                                |
|    07 | `progress`           |               36 | High     | primary situational router in upstream                     | workflow-backed report modes, `--do`, `--forensic`, richer routing tests                                             |
|    08 | `health`             |               28 | High     | trust/safety command for `.planning` health                | repair/context modes, richer checks, tests                                                                           |
|    09 | `map-codebase`       |               94 | High     | strong base exists, remaining gap mostly picker/commit UX  | optional upstream picker/commit parity                                                                               |
|    10 | `stats`              |               22 | Medium   | support command, easy isolated parity work                 | richer metrics, git timeline, output parity, tests                                                                   |
|    11 | `help`               |               30 | Medium   | docs UX, low risk                                          | reference parity or explicit local divergence, tests                                                                 |
|    12 | `new-milestone`      |               92 | Medium   | already strong, polish after core loop                     | close remaining deltas, tests, audit refresh                                                                         |
|    13 | `complete-milestone` |               90 | Medium   | already strong, depends on prior loop quality              | close remaining deltas, tests, audit refresh                                                                         |
|    14 | `milestone-summary`  |               91 | Medium   | already strong, now above parity threshold                 | optional further proofing only                                                                                       |
|    15 | `debug`              |               91 | Medium   | operational command now above parity threshold             | optional output-format proofing only                                                                                 |
|    16 | `next`               |               18 | Medium   | local helper, should align with `progress --next` contract | decide keep-as-local or fully align, tests                                                                           |
|    17 | `status`             |               35 | Low      | local-only additive command                                | define local contract, docs, tests                                                                                   |
|    18 | `on` / `off`         |              100 | Low      | complete local-only toggles                                | leave unless extension UX changes                                                                                    |

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
|    29 | `audit-fix`               | auto-remediation pipeline             |
|    30 | `add-tests`               | complements validation and execution  |

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
