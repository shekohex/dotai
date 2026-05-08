# execute-phase workflow

Slice 2 local upstream-adapted orchestrator for supported flags only.

Purpose:

- move `/gsd execute-phase` from stub wording to real orchestrator behavior for supported path
- keep lifecycle entry TS-thin and workflow-launch based
- reuse bundled helpers for indexing, roadmap/state updates, verification, drift detection, and phase completion
- honor configured branching strategy before any plan execution starts
- stay explicitly out of scope for deferred flags and standalone command rewrites

Required local reading before execution:

- `$GSD_BUNDLE_DIR/commands/gsd/execute-phase.md`
- `$GSD_BUNDLE_DIR/workflows/execute-plan.md`
- `$GSD_BUNDLE_DIR/workflows/execute-phase/steps/per-plan-worktree-gate.md`
- `$GSD_BUNDLE_DIR/workflows/execute-phase/steps/post-merge-gate.md`
- `$GSD_BUNDLE_DIR/workflows/execute-phase/steps/codebase-drift-gate.md`
- `$GSD_BUNDLE_DIR/references/agent-contracts.md`
- `$GSD_BUNDLE_DIR/references/context-budget.md`
- `$GSD_BUNDLE_DIR/references/worktree-path-safety.md`
- `$GSD_BUNDLE_DIR/references/checkpoints.md`
- `$GSD_BUNDLE_DIR/references/gates.md`
- `$GSD_BUNDLE_DIR/references/tdd.md`
- `$GSD_BUNDLE_DIR/references/executor-examples.md`

Core rules:

1. Parse command arguments from `/gsd execute-phase ...` exactly as passed through by local handler.
2. Active flags are only flags present in command arguments.
3. active flags are only flags present in command arguments.
4. Supported flags in this slice: `--wave`, `--gaps-only`, `--interactive`, `--validate`, `--cross-ai`, `--no-cross-ai`, `--auto`, `--mvp`, `--tdd`.
5. `--cross-ai`, `--no-cross-ai`, `--auto`, `--mvp`, and `--tdd` are workflow-native flags in this slice: parser/lifecycle preserve them, bundled workflow/runtime own semantics.
6. Use existing local runtime helpers in `$GSD_TOOLS_PATH` for init, plan indexing, roadmap/state updates, verification, and completion.
7. Honor `branching_strategy` and `branch_name` from init before validation or dispatch.
8. Do not reimplement helper business logic in TypeScript. Handler stays registration-only.
9. Treat this file as local adapted behavior contract, not literal shell script.
10. Required invariant phrases for local contract coverage: wave discovery/filtering, lower-wave safety, intra-wave overlap downgrade, sequential `run_in_background` dispatch wording, completion-signal spot-check fallback, worktree cleanup with pre-merge `--diff-filter=D`, post-merge gate, partial-wave stop-before-verify/complete, verifier spawn, human-UAT persistence, `phase.complete` path.

## 1. Parse Args

1. Parse phase from positional token or `--phase`.
2. Derive active flags from exact raw-arg forms accepted by parser.
3. `--wave` filter is active for either `--wave <N>` or `--wave=<N>`.
4. `--gaps-only`, `--interactive`, and `--validate` are active only when their literal tokens appear in command arguments.
5. Record execution mode summary:
   - no flags: `standard full-phase execution`
   - `--wave` or `--wave=<N>`: `wave filter active`
   - `--gaps-only`: `gap closure only`
   - `--interactive`: `interactive sequential mode`
   - `--validate`: `validation requested`
   - `--cross-ai`: `force cross-AI delegation`
   - `--no-cross-ai`: `cross-AI delegation disabled`
   - `--auto`: `auto-chain semantics requested`
   - `--mvp`: `MVP mode requested`
   - `--tdd`: `TDD mode requested`

## 2. Initialize

1. Resolve target phase from positional phase or `--phase`.
2. Load execution init context:
   - if `--validate` is active: `node "$GSD_TOOLS_PATH" init execute-phase "<phase>" --validate`
   - otherwise: `node "$GSD_TOOLS_PATH" init execute-phase "<phase>"`
3. Abort if init reports missing phase, missing roadmap/state, or empty plan inventory for requested phase.
4. Respect `references/context-budget.md` for orchestrator budget and delegate aggressively when not interactive.

## 3. Handle Branching

1. After init and before validation/dispatch, inspect `branching_strategy` and `branch_name` from init payload.
2. If `branching_strategy` is `none`, continue on current branch.
3. If `branching_strategy` is `phase` or `milestone`, use pre-computed `branch_name` from init.
4. Fail-fast branch creation rules:
   - if local branch `branch_name` already exists, switch to it and fail if switch fails
   - otherwise derive default branch from `origin/HEAD`, fallback `main`
   - fetch `origin/<default-branch>` before branch creation when possible
   - if fetch fails and no local `origin/<default-branch>` exists, stop and refuse to create branch from current HEAD
   - create `branch_name` from `origin/<default-branch>`, not current HEAD
5. This branch-handling step must happen before any plan discovery, `state.begin-phase`, validation, or execution so phase work cannot land on wrong branch.

## 4. Validate Phase

1. Validate execution preconditions using init payload and `references/gates.md` pre-flight gate model.
2. If `state_validation_ran=true`, surface warnings but do not treat them as deferred standalone `validate-phase` rewrite.
3. Goal here: confirm phase executable, not rewrite `/gsd validate-phase`.

## 5. Persist Phase Start State

1. Immediately after init + branch handling + validation, persist execution start state before discovery or execution.
2. Invoke shipped helper:
   - `node "$GSD_TOOLS_PATH" state begin-phase --phase "<phase>" --name "<phase-name>" --plans "<plan-count>"`
3. `state.begin-phase` must run before plan grouping so progress, resume, and handoff tooling reflect active execution.

## 6. Discover And Group Plans

1. Load canonical plan index with `node "$GSD_TOOLS_PATH" phase-plan-index "<phase>"`.
2. Use helper output as source of truth for plan inventory, waves, incomplete list, autonomous markers, and plan file coverage.
3. Apply filters in this order:
   - keep only incomplete plans
   - if `--gaps-only` active: keep only gap-closure plans from indexed/frontmatter-backed plan metadata
   - if `--wave <N>` or `--wave=<N>` active: keep only plans in selected wave after lower-wave safety check
4. Wave discovery/filtering must preserve helper grouping. Do not regroup by ad hoc heuristics.
5. Lower-wave safety:
   - if earlier matching wave still has incomplete plans, block later selected wave
   - lower-wave safety applies after `--gaps-only` filter, not against unrelated excluded plans
6. Intra-wave overlap downgrade:
   - within selected wave, detect overlapping `files_modified`
   - plans with overlap must not run concurrently in same write root
   - downgrade overlapping siblings to sequential execution even if whole wave is otherwise parallel

## 7. Interactive Checks

1. If `--interactive` active, run sequentially inline through `workflows/execute-plan.md`.
2. Before each plan, evaluate `steps/per-plan-worktree-gate.md`.
3. If plan is non-autonomous or checkpoint-heavy, pause and present checkpoint content per `references/checkpoints.md`.
4. Human-UAT persistence:
   - if executor returns pending human verification or UAT items, persist them in execution summary and do not drop them between plans
   - completion-signal spot-check fallback: if returned checkpoint/completion wording is ambiguous, inspect generated SUMMARY/UAT artifacts before declaring plan done

## 8. Execute Waves

1. Non-interactive mode executes wave by wave.
2. For each wave:
   - build candidate plan list
   - run `steps/per-plan-worktree-gate.md` per plan
   - split into safe-parallel lanes and sequential lanes
3. Sequential `run_in_background` dispatch wording is required when launching delegated executors:
   - launch each delegated executor with `run_in_background`
   - still dispatch sequentially from orchestrator so startup, bookkeeping, and lane assignment remain deterministic
4. Every delegated executor uses `workflows/execute-plan.md` contract plus `references/agent-contracts.md`.
5. For worktree-enabled plans, apply `references/worktree-path-safety.md`.
6. For each finished executor, collect:
   - status
   - completed plan id
   - produced summary path
   - commit hashes
   - checkpoint payload if any
   - human-UAT pending items if any

## 9. Checkpoint Handling

1. If any delegated executor returns checkpoint state, stop advancing that lane.
2. Present user-facing checkpoint details using bundled checkpoint contract.
3. Only continue wave after required user signal received.
4. If checkpoint cannot be resumed in same worker context, spawn fresh continuation using returned completed-task state.
5. Completion-signal spot-check fallback applies before marking checkpoint-cleared plan complete.

## 10. Aggregate Results

1. After each wave finishes, aggregate plan outcomes centrally.
2. Merge per-plan outputs into orchestrator summary.
3. Cleanup merged worktrees using pre-merge `--diff-filter=D` aware inspection:
   - check deleted-file deltas before cleanup so deletion-only work is not lost
   - cleanup happens only after merge result inspected
4. Run `steps/post-merge-gate.md` once per fully merged wave in parallel mode and once at end-of-wave in serial mode.
5. Scope regression gate to full-wave merged state, not per completed plan.
6. Only after successful post-merge gate, update roadmap progress for completed plans in that merged wave with `node "$GSD_TOOLS_PATH" roadmap update-plan-progress "<phase>"`.
7. If post-merge build/test fails, do not update roadmap/tracking for that wave.

## 11. Partial-Wave Handling

1. If `--wave` is active and unmatched incomplete plans remain after selected wave finishes:
   - report `selected wave complete; phase still in progress`
   - skip verification and completion work
   - partial-wave stop-before-verify/complete is mandatory
   - route user to next `execute-phase --wave <next>` or full `execute-phase <phase>` run
2. If selected wave returns unresolved failures/checkpoints, stop before later gates.

## 12. Regression Gate

1. Once execution is not partial-wave-stopped, enforce regression gate.
2. Regression gate means full-wave merged result passes post-merge build/test gate from `steps/post-merge-gate.md`.
3. Failed regression gate blocks verify/completion path.

## 13. Schema Drift Gate

1. Run local schema drift verification helper if available in supported path.
2. Treat blocking schema drift as stop-before-verifier.
3. Do not expand into deferred flags or standalone rewrites here.

## 14. Codebase Drift Gate

1. Run `steps/codebase-drift-gate.md`.
2. Gate is non-blocking drift contract:
   - execute `node "$GSD_TOOLS_PATH" verify codebase-drift`
   - never fail phase solely because codebase drift verifier reports warning or skipped state
   - record directive for follow-up map update when present

## 15. Verify Phase Goal

1. After execution -> partial-wave check -> regression/schema/codebase drift, spawn verifier.
2. Verifier spawn is required wording and behavior.
3. Verify against phase goal, plan summaries, pending checkpoints, and human-UAT state.
4. If verification fails, stop before phase completion and preserve remediation guidance.

## 16. Update Roadmap And Phase Complete Path

1. If verification passes and all matching incomplete plans are exhausted:
   - refresh `roadmap.update-plan-progress` after verifier success as final tracking sync
   - invoke `node "$GSD_TOOLS_PATH" phase complete "<phase>"`
2. `phase.complete` path is only legal after verifier success and no remaining incomplete plans.
3. Report final phase completion outcome with persisted UAT items, drift follow-ups, and next recommended command.

Required ordering invariant:

1. branching
2. `state.begin-phase`
3. discovery/execution
4. partial-wave check
5. regression gate
6. schema drift gate
7. codebase drift gate
8. verifier spawn
9. roadmap completion / `phase.complete`

Runtime contract:

- `GSD_BUNDLE_DIR` is injected by workflow launcher as concrete absolute bundle path
- `GSD_TOOLS_PATH` is injected by workflow launcher as concrete absolute local helper path
- do not use unresolved `{{GSD_BUNDLE_DIR}}` placeholders in command execution
- do not call local native `orchestrateExecutePhase()` path from this workflow
