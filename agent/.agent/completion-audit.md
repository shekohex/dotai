# GSD Completion Audit Prep

## Objective Restatement

Deliverables required before goal can be complete:

- every implemented local `/gsd` command audited against upstream or explicit local-only intent
- every implemented command either:
  - works end to end with credible parity evidence, or
  - fails closed with truthful docs/help/tests for unsupported boundaries
- `docs/gsd-command-coverage-audit.md` stays aligned with shipped runtime
- validation proof exists for accepted slices:
  - `npm run typecheck`
  - `npm test`
  - `npm run lint`
  - `npm run format:check`
- completion claim must map requirements to concrete files/tests/runtime evidence, not only green suites

## Implemented Command Inventory

Source of truth for registered grouped commands:

- `src/extensions/gsd/commands.ts`
- `docs/gsd-command-coverage-audit.md`

Implemented locally:

| Command              | Current score | Primary runtime path                                         | Evidence status     | Main remaining concern                                       |
| -------------------- | ------------: | ------------------------------------------------------------ | ------------------- | ------------------------------------------------------------ |
| `new-project`        |            93 | `src/extensions/gsd/lifecycle/new-project.ts`                | strong              | completion audit still needed                                |
| `new-milestone`      |            96 | workflow launch                                              | strong              | completion audit still needed                                |
| `complete-milestone` |            90 | workflow launch                                              | strong              | completion audit still needed                                |
| `milestone-summary`  |            91 | workflow launch                                              | strong              | completion audit still needed                                |
| `debug`              |            91 | hybrid TS + workflow                                         | strong              | completion audit still needed                                |
| `map-codebase`       |            94 | `src/extensions/gsd/lifecycle/map-codebase.ts`               | strong              | completion audit still needed                                |
| `discuss-phase`      |            92 | `src/extensions/gsd/lifecycle/discuss-phase.ts`              | strong              | completion audit still needed                                |
| `plan-phase`         |            93 | `src/extensions/gsd/lifecycle/plan-phase.ts` + orchestration | strong              | completion audit still needed                                |
| `execute-phase`      |            91 | `src/extensions/gsd/lifecycle/execute-phase.ts`              | strong              | completion audit still needed                                |
| `secure-phase`       |            88 | workflow launch                                              | medium-strong       | verify remaining docs/runtime gaps                           |
| `verify-work`        |            90 | workflow + helper runtime                                    | strong              | completion audit still needed                                |
| `validate-phase`     |            77 | workflow + helper preflight                                  | medium              | biggest remaining workflow-native parity gap                 |
| `progress`           |            71 | workflow + local next route                                  | medium              | unsupported upstream modes; report-branch breadth still thin |
| `next`               |            71 | `src/extensions/gsd/instant/next.ts`                         | medium              | local adaptation; route graph still partial                  |
| `stats`              |            72 | `src/extensions/gsd/instant/stats.ts` + state backend        | medium              | local metrics breadth still reduced                          |
| `health`             |            75 | `src/extensions/gsd/state/health.ts`                         | medium              | richer repair/context parity still partial                   |
| `status`             |            52 | `src/extensions/gsd/instant/status.ts`                       | medium-weak         | local-only contract still narrow                             |
| `help`               |            70 | `src/extensions/gsd/help.ts` + docs                          | medium              | hand-maintained reference breadth                            |
| `on`                 |           100 | `src/extensions/gsd/commands.ts`                             | complete local-only | none                                                         |
| `off`                |           100 | `src/extensions/gsd/commands.ts`                             | complete local-only | none                                                         |

## Prompt-To-Artifact Checklist

### Requirement: implemented command inventory is truthful

- evidence:
  - `src/extensions/gsd/commands.ts`
  - `docs/gsd-command-coverage-audit.md` top table
- current state:
  - implemented roster matches registered grouped commands
  - top table now matches per-command sections again after latest `status` / `help` / `next` score changes
- remaining work:
  - ensure every future score change updates both top table and section

### Requirement: docs/help/tests align with shipped runtime

- evidence:
  - `src/resources/gsd/docs/command-reference.md`
  - `test/gsd/resources.test.ts`
  - `test/gsd/commands.test.ts`
  - `test/gsd/ui.test.ts`
- current state:
  - help drift guards exist for unsupported catalog and autocomplete flags
  - recent slices synced `map-codebase`, `progress`, `health`, `status`, `next`
- remaining work:
  - explicit audit sweep still needed per low-score command to ensure no stale wording remains

### Requirement: deterministic runtime behavior stronger than workflow prose

- evidence:
  - runtime handlers under `src/extensions/gsd/instant`, `src/extensions/gsd/lifecycle`, `src/extensions/gsd/state`
  - command-level proofs in `test/gsd/commands.test.ts`
  - route/state proofs in `test/gsd/roadmap.test.ts`, `test/gsd/brownfield.test.ts`, `test/gsd/instant.test.ts`, `test/gsd/lifecycle.test.ts`
- current state:
  - many recent slices replaced prose-only claims with command-level proofs
- remaining work:
  - final completion audit must map each implemented command to concrete runtime/test evidence row-by-row

### Requirement: fail closed for unsupported or unsafe behavior

- evidence:
  - parser rejection tests in `test/gsd/commands.test.ts`
  - workflow prelaunch guards in `progress` and `validate-phase`
  - `next` no-session and safety-gate proofs
- current state:
  - strong for `next`, `progress`, `health`, `validate-phase`
- remaining work:
  - confirm lowest-score commands do not still have unproved fail-open branches

### Requirement: full validation gates for accepted slices

- evidence:
  - latest accepted slices all ran:
    - `npm run typecheck`
    - `npm test`
    - `npm run lint`
    - `npm run format:check`
- current state:
  - green at 791 tests after latest `next` canonical-UAT scoping slice
- remaining work:
  - must rerun full gates again before any future completion claim

## Lowest-Score Command Evidence Map

### `status` (`52`)

- runtime:
  - `src/extensions/gsd/instant/status.ts`
- direct proofs:
  - `test/gsd/commands.test.ts`
  - `test/gsd/ui.test.ts`
- covered now:
- empty state
- headless summary counts
- elapsed time and activity detail
- deterministic oldest-first ordering
- UI live panel rendering
- non-GSD child sessions filtered out from both headless and UI output
- weakest remaining areas:
  - purely local command, no upstream parity target
  - no richer lifecycle integration beyond subagent list display

### `next` (`71`)

- runtime:
  - `src/extensions/gsd/instant/next.ts`
  - `src/extensions/gsd/state/runtime.ts`
- direct proofs:
  - `test/gsd/commands.test.ts`
  - `test/gsd/roadmap.test.ts`
- covered now:
  - blocked/error `STATE.md` force bypass only
  - paused state
  - `.continue-here.md`
  - discuss checkpoint
  - command-level forced discuss-checkpoint blocking proof
  - verification fail
  - no-session workflow-route fail-closed boundaries
  - local no-session discuss/plan routing
  - padded/unpadded phase normalization
- roadmap-scoped plan/summary routing counts
- canonical phase-scoped UAT artifacts only; stray noncanonical `*-UAT.md` files no longer skip `/gsd verify-work`
- weakest remaining areas:
  - route graph still local adaptation, not full upstream `progress --next`
  - need explicit review of any remaining upstream branch claims in audit prose

### `progress` (`71`)

- runtime:
  - `src/extensions/gsd/lifecycle/progress.ts`
  - `src/extensions/gsd/state/progress.ts`
  - `src/extensions/gsd/instant/next.ts`
- direct proofs:
  - `test/gsd/commands.test.ts`
  - `test/gsd/brownfield.test.ts`
  - `test/gsd/roadmap.test.ts`
- covered now:
  - workflow launch entry
  - helper prelaunch gates
  - no-session guard
  - routed `--next`
  - `progress --next --force` inherits `next` safety gates at command level
  - `progress --next` preserves no-session local discuss/plan routing semantics
  - `progress --next --force` preserves discuss-checkpoint blocking
  - `progress --next` preserves roadmap-scoped artifact routing semantics
  - malformed `--phase`
  - explicit unsupported `--do`, `--forensic`
  - brownfield progress math fixes
- weakest remaining areas:
  - richer upstream report branches still absent
  - likely best next non-local lifecycle target after audit sweep

### `stats` (`72`)

- runtime:
  - `src/extensions/gsd/instant/stats.ts`
  - `src/extensions/gsd/state/stats.ts`
  - `src/extensions/gsd/state/stats-support.ts`
- direct proofs:
  - `test/gsd/instant.test.ts`
  - `test/gsd/brownfield.test.ts`
  - `test/gsd/roadmap.test.ts`
- covered now:
  - milestone scoping
  - requirement parsing
  - conservative phase status
  - git/activity enrichment
- invalid `last_activity` fallback
- ignores stale non-roadmap snapshot phases
- malformed summary ids excluded from completion counts
- noncanonical UAT artifacts excluded from `Complete` phase promotion
- mixed output mode errors normalized across positional/flag forms
- truthful `verification_count`, `decisions_count`, `open_blockers`
- weakest remaining areas:
  - still reduced local metric set compared with upstream workflow mode

### `help` (`70`)

- runtime/docs:
  - `src/extensions/gsd/help.ts`
  - `src/resources/gsd/docs/command-reference.md`
- direct proofs:
  - `test/gsd/resources.test.ts`
  - `test/gsd/commands.test.ts`
  - `test/gsd/ui.test.ts`
  - `test/gsd/index.test.ts`
- covered now:
  - non-UI renderer
  - UI paging
  - unsupported command catalog
  - autocomplete flag drift guard
  - key local guardrails wording
  - progress and validate prelaunch fail-closed wording now synced
  - direct guards for stats variants and next force safety wording
- weakest remaining areas:
  - hand-maintained reference breadth still lower than upstream help universe

### `validate-phase` (`77`)

- runtime:
  - `src/extensions/gsd/state/validate-phase.ts`
  - `src/extensions/gsd/lifecycle/validate-phase.ts`
  - `src/resources/gsd/bin/lib/init.cjs`
- direct proofs:
  - `test/gsd/lifecycle.test.ts`
  - `test/gsd/validate-phase-workflow.test.ts`
  - `test/gsd/uat.test.ts`
- covered now:
  - helper preflight
  - config gating
  - canonical target resolution
  - malformed helper payload rejection
  - thrown helper failure rejection
  - exact canonical target-path revalidation
  - omitted-phase fallback across helper-unready higher completed phases
  - deterministic draft scaffolding
  - manual verification debt import
  - test type derivation
- weakest remaining areas:
  - still no full Nyquist reconstruction/test-generation parity
  - largest remaining credible parity gap among workflow-native commands

## Current Recommendation

Best next runtime slice after audit prep:

1. `status`
2. `help`
3. `stats`

Reason:

- `status` remains by far lowest score and still needs either broader honest contract or explicit local-only boundaries
- `help` and `stats` are now tied or near-tied as next weakest central truth surfaces after recent `next` hardening
- `secure-phase` remains relatively strong and no longer looks like best immediate ROI compared with lower-score command/docs truth surfaces

## Not Completion Yet

Goal not complete.

Why not:

- no final command-by-command completion audit mapping every implemented command to evidence has been executed yet
- several implemented commands remain materially partial by their own truthful scores: `status`, `next`, `progress`, `stats`, `help`, `validate-phase`, `health`
- current green suite is necessary evidence, not sufficient proof of full parity/explicit-boundary objective
