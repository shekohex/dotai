# GSD Command Reference

Local help for commands implemented in this repo. Not claim upstream parity.

## Upstream Crosswalk

- Upstream `/gsd next` maps to local `/gsd next` for safest next-step routing from local `.planning` state.
- Upstream `/gsd phase` does not exist here as one grouped command. Use local `/gsd discuss-phase`, `/gsd plan-phase`, `/gsd execute-phase`, `/gsd verify-work`, `/gsd secure-phase`, `/gsd validate-phase`.
- Upstream `/gsd project` does not exist here. Use local `/gsd new-project`, `/gsd progress`, `/gsd stats`, `/gsd health`.
- Upstream `/gsd milestone` does not exist here. Use local `/gsd new-milestone`, `/gsd complete-milestone`, `/gsd milestone-summary`.
- Upstream `/gsd map` does not exist here. Use local `/gsd map-codebase`.

## Unsupported Upstream Commands

- If upstream docs mention `/gsd <name>` command not listed below, command is unavailable in this repo.
- Do not assume alias or partial parity.
- Try `/gsd help`, root `/gsd` dashboard, or one listed local command instead.
- Common unavailable examples: `/gsd retro`, `/gsd phase`, `/gsd project`, `/gsd milestone`, `/gsd map`.
- Current unsupported upstream catalog: `add-tests`, `ai-integration-phase`, `audit-fix`, `audit-milestone`, `audit-uat`, `autonomous`, `capture`, `cleanup`, `code-review`, `config`, `docs-update`, `eval-review`, `explore`, `extract-learnings`, `fast`, `forensics`, `graphify`, `import`, `inbox`, `ingest-docs`, `manager`, `mvp-phase`, `pause-work`, `phase`, `plan-review-convergence`, `pr-branch`, `profile-user`, `quick`, `resume-work`, `review`, `review-backlog`, `settings`, `ship`, `sketch`, `spec-phase`, `spike`, `thread`, `ui-phase`, `ui-review`, `ultraplan-phase`, `undo`, `update`, `workspace`, `workstreams`.

## Quick Start

1. Start new local planning tree with `/gsd new-project [brief]`, or run `/gsd on` if planning already exists.
2. If you used `/gsd on`, bootstrap planning with `/gsd new-project [brief]` when repo has no `.planning` tree yet.
3. Check what to do next with `/gsd progress` or `/gsd next`.

## Use GSD When

- You want local `.planning` workflow in this repo.
- You need project state, roadmap, stats, or health from local artifacts.
- You want workflow launchers wired here, not upstream/global GSD surface.

## Guardrails

- Local-only command surface. Only commands below supported here.
- Unknown local `/gsd <name>` subcommands fail closed with warning instead of falling through to dashboard output.
- Zero-arg local control/view commands reject stray tokens explicitly: `/gsd on`, `/gsd off`, `/gsd help`, `/gsd status`.
- Some commands reject unsupported local flags explicitly; others still accept extra tokens or freeform input.
- Help keeps deferred or workflow-forwarded behavior labeled as such.
- Non-UI `/gsd help` emits durable `gsd-help` message output; registered local renderer is intended handling path.

## Control

- `/gsd`
- `/gsd on`
- `/gsd off`
- `/gsd help`
  shows this local command guide

## Milestones

- `/gsd new-project [brief]`
  flags: `--auto`, `--text`
  `--text` uses plain-text questions instead of interview forms
  use when starting GSD in repo with no planning tree yet
  examples: `/gsd new-project`, `/gsd new-project --auto @idea.md`
- `/gsd new-milestone [milestone]`
  flags: `--text`, `--reset-phase-numbers`
  `--text` forwards text-mode questioning into bundled milestone workflow; `--reset-phase-numbers` opts into restarting roadmap numbering at `1` when workflow safety checks allow it
- `/gsd complete-milestone [version]`
  flags: `--text`
  `--text` uses plain-text confirmations instead of interview forms
  workflow-owned closeout includes readiness confirmation, artifact-audit acknowledgment, archive/requirements rollover, commit, and optional tag confirmation
  local source of truth is `.planning/milestones/`; tagging should pause for explicit confirmation instead of assuming upstream auto-tag flow
- `/gsd milestone-summary [version]`
  flags: `--text`
  `--text` uses plain-text follow-up Q&A instead of interview forms
  workflow reads archived milestone artifacts from `.planning/milestones/` and `.planning/milestones/vX.Y-phases/` when present, otherwise current planning artifacts only for requested milestone
  git statistics stay milestone-bound and the workflow must not dirty `STATE.md` as a side effect of report generation

## Planning

- `/gsd map-codebase`
  flags: `--paths <repo/path,...>`, `--fast`, `--query <term|status|diff|refresh>`
  modes: `refresh`, `update`, `skip`
  `--focus <tech|arch|quality|concerns|tech+arch>` only with `--fast`
  `--paths <repo/path,...>` runs scoped canonical remap with strict repo-relative path validation; entries containing `..`, leading `/`, or shell metacharacters fail closed
  local fast mode only supports `--fast refresh`; `--fast update` and `--fast skip` fail explicitly
- `/gsd discuss-phase [phase] [input]`
  flags: `--phase <phase>`, `--assumptions`, `--auto`, `--all`, `--chain`, `--text`
  TS-owned local flow: checkpointed discuss loop, assumptions preview/artifact route, prior-context/codebase-scout loading, and phase-local blocking `.continue-here.md` gate
  explicit local non-support: `--batch`, `--analyze`, `--power`, upstream advisor/methodology overlays, and assumptions-list artifact listing beyond preview/artifact routes
- `/gsd plan-phase [phase]`
  flags: `--phase <phase>`, `--research-phase <phase>`, `--research`, `--skip-research`, `--skip-verify`, `--gaps`, `--reviews`, `--view`, `--text`
  `--view` only works with `--research-phase` in current local slice
  omitted phase prefers next unplanned roadmap phase first; `--gaps` requires verification or UAT evidence and `--reviews` requires `REVIEWS.md`; checker pass or `--skip-verify` still runs dependency/post-plan helpers before final state mutation
  use when phase needs local planning artifacts before execution
  examples: `/gsd plan-phase 2`, `/gsd plan-phase --phase 3.1 --research`

## Execution

- `/gsd execute-phase <phase>`
  flags: `--phase <phase>`, `--wave <n>`, `--gaps-only`, `--interactive`, `--validate`, `--text`, `--cross-ai`, `--no-cross-ai`, `--auto`, `--tdd`, `--mvp`
  `--text` uses plain-text checkpoints instead of interview forms
  `--cross-ai`, `--no-cross-ai`, `--auto`, `--tdd`, `--mvp` forward to bundled workflow/runtime
  local slice requires explicit phase, preserves workflow-native flag pass-through, and uses bundled branch/worktree/checkpoint/regression/drift/verifier gates rather than native TS reimplementation
- `/gsd secure-phase [phase]`
  flags: `--phase <phase>`
  workflow-owned security review builds or reuses per-phase threat register, can document accepted risks, writes `*-SECURITY.md`, and blocks advancement while threats remain open
- `/gsd verify-work [phase]`
  flags: `--phase <phase>`
  workflow-owned UAT path now includes helper-backed diagnosis persistence, issue-to-gap follow-up guidance, artifact-acknowledgment/security/transition closure guidance, and authoritative `*-UAT.md` resume state without auto-mutating phase completion
- `/gsd validate-phase [phase]`
  flags: `--phase <phase>`
  explicit phase override accepts padded/unpadded equivalent forms like `2` and `02`
  padded and unpadded local `*-SUMMARY.md` plan ids are treated as equivalent during completeness/preflight checks
  unsupported args fail explicitly; omitted phase prefers last helper-ready local SUMMARY-backed phase; malformed or non-roadmap SUMMARY inventories fail closed; explicit incomplete or non-executed phases fail closed; config-disabled Nyquist validation, ambiguous/non-canonical VALIDATION inventory, malformed helper payloads, helper execution failures, and helper target paths outside the exact canonical phase `*-VALIDATION.md` fail closed before workflow launch; workflow uses helper-backed readiness preflight and does not auto-mutate phase state
  workflow-owned validation path now includes gap review gate, optional Nyquist auditor handoff, test-generation commit step, and explicit compliant vs partial routing without auto-completing the phase

## Debug

- `/gsd debug [description]`
  flags: `--diagnose`, `--text`
- `/gsd debug list`
  flags: `--diagnose`, `--text`
- `/gsd debug status <slug>`
  flags: `--diagnose`, `--text`
- `/gsd debug continue <slug>`
  flags: `--diagnose`, `--text`
  `--text` uses plain-text symptom intake/checkpoints instead of interview forms
  local fork is intentional: `list` and `status` are TS-rendered compact session views, while new/continue routes still hand off to bundled debug-session-manager workflow in visible session

## Instant

- `/gsd next [phase]`
  flags: `--phase <phase>`, `--force`
  narrowed local router, not full upstream `next.md` route graph
  conflicting positional phase plus `--phase` fails closed explicitly
  blocks on paused state, blocking `.planning/.continue-here.md`, active discuss checkpoints, and unresolved verification FAIL before any routing
  `--force` only bypasses blocked/error `STATE.md` status gate; `.continue-here.md`, paused state, discuss checkpoints, and unresolved verification FAIL still stop routing
  unsupported upstream-equivalent branches stay manual boundaries here: paused-state resume, prior-phase deferral/backlog choices, and spike/sketch notices
  missing next-phase discuss prep may route to `/gsd discuss-phase <phase>` before planning
  without workflow session support, `/gsd next` fails closed with warning instead of mutating `STATE.md`
  use when you want safest local next-step routing from current planning state
  examples: `/gsd next`, `/gsd next --phase 2`
- `/gsd stats`
  variants: `json`, `table`, `--json`, `--table`, `--format json`, `--format table`
  unsupported variants fail explicitly instead of falling back to one-line notify output
  default output now emits a report-style local summary including requirements, git fields, project age, and per-phase table
  when roadmap phases include `**Mode:** mvp`, report/table output also emits upstream-style MVP phase summary counts
  phase status is local-artifact driven: `Not Started`, `In Progress`, `Executed`, `Human Needed`, `Complete`
  `Complete` requires authoritative local verification completion, currently `*-UAT.md` with `status: complete`; summarized work without that remains `Executed`
  padded local summary ids like `02-01-SUMMARY.md` count against canonical roadmap plans like `2-01`
  requirements counts support checklist items, plain local requirement bullets, and traceability status rows; deferred `v2+` sections stay excluded
  structured/table output also includes git commit count, first commit date, project age, and last activity when local repo or planning artifacts provide them
  use when you need local artifact summary without opening docs
  examples: `/gsd stats table`, `/gsd stats json`
- `/gsd health`
  flags: `--repair`, `--backfill`, `--context`, `--tokens-used <int>`, `--tokens-used=<int>`, `--context-window <int>`, `--context-window=<int>`
  bare `--context` derives current session token usage when available and can derive window from session or `.planning/config.json`; if token usage is unavailable and UI input is available it prompts once for approximate values, otherwise it reports unknown instead of guessing
  local hot-path summary treats canonical phase dirs as valid whether prefixed `02-` or `2-`
  malformed counter values fail closed locally: `--tokens-used` requires non-negative integer, `--context-window` requires positive integer
  `--tokens-used` and `--context-window` require `--context`; `--repair` / `--backfill` cannot be combined with `--context` in one run
- `/gsd status`
  shows active local GSD subagent/session status in UI panel or plain text summary with counts, elapsed time, and activity detail when available
  use when you want current local GSD worker activity, not upstream/global service health

## Workflow Review

- `/gsd progress`
  default route: bundled workflow-launch review session
  flags: `--next`
  narrowed local situational review command, not upstream routed execution hub
  `--phase <phase>`, `--force` only with `/gsd progress --next`
  conflicting positional phase plus `--phase` in `progress --next` fails closed explicitly
  `progress --next` inherits `/gsd next` routing; local `discuss-phase` and `plan-phase` routes still work without workflow session support, while workflow-native routes fail closed
  `progress --next --force` inherits `/gsd next` safety gates; `.continue-here.md`, paused state, discuss checkpoints, and unresolved verification FAIL still stop routing
  parsed with explicit unsupported-local error: `--do`, `--forensic`
  unsupported upstream-equivalent branches stay fenced here: default post-report route graph, freeform `--do` dispatch, and `--forensic` integrity audit
  fails closed when `.planning/PROJECT.md`, `.planning/ROADMAP.md`, or `.planning/STATE.md` is missing
  fails closed when workflow session support is unavailable in current context

## Phase Override

Supported forms:

- positional: `/gsd plan-phase 2`
- flag: `/gsd execute-phase --phase 3.1`
- equals flag: `/gsd next --phase=4`
- progress next positional: `/gsd progress --next 2`
- progress next flag: `/gsd progress --next --phase 2`
- progress next force: `/gsd progress --next --force`
