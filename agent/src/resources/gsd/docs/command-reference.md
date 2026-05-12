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
  flags: `--auto`
  use when starting GSD in repo with no planning tree yet
  examples: `/gsd new-project`, `/gsd new-project --auto @idea.md`
- `/gsd new-milestone [milestone]`
- `/gsd complete-milestone [version]`
- `/gsd milestone-summary [version]`

## Planning

- `/gsd map-codebase`
  flags: `--fast`, `--query <term|status|diff|refresh>`
  modes: `refresh`, `update`, `skip`
  `--focus <tech|arch|quality|concerns|tech+arch>` only with `--fast`
  local fast mode only supports `--fast refresh`; `--fast update` and `--fast skip` fail explicitly
  unsupported-local but explicit: `--paths <repo/path,...>`
- `/gsd discuss-phase [phase] [input]`
  flags: `--phase <phase>`, `--assumptions`, `--auto`, `--all`, `--chain`, `--text`
- `/gsd plan-phase [phase]`
  flags: `--phase <phase>`, `--research-phase <phase>`, `--research`, `--skip-research`, `--skip-verify`, `--gaps`, `--reviews`, `--view`, `--text`
  use when phase needs local planning artifacts before execution
  examples: `/gsd plan-phase 2`, `/gsd plan-phase --phase 3.1 --research`

## Execution

- `/gsd execute-phase <phase>`
  flags: `--phase <phase>`, `--wave <n>`, `--gaps-only`, `--interactive`, `--validate`, `--cross-ai`, `--no-cross-ai`, `--auto`, `--tdd`, `--mvp`
  `--cross-ai`, `--no-cross-ai`, `--auto`, `--tdd`, `--mvp` forward to bundled workflow/runtime
- `/gsd secure-phase [phase]`
  flags: `--phase <phase>`
- `/gsd verify-work [phase]`
  flags: `--phase <phase>`
- `/gsd validate-phase [phase]`
  flags: `--phase <phase>`
  unsupported args fail explicitly; omitted phase prefers last helper-ready local SUMMARY-backed phase; malformed or non-roadmap SUMMARY inventories fail closed; explicit incomplete or non-executed phases fail closed; config-disabled Nyquist validation, ambiguous/non-canonical VALIDATION inventory, malformed helper payloads, and helper execution failures fail closed before workflow launch; workflow uses helper-backed readiness preflight and does not auto-mutate phase state

## Debug

- `/gsd debug [description]`
  flags: `--diagnose`
- `/gsd debug list`
  flags: `--diagnose`
- `/gsd debug status <slug>`
  flags: `--diagnose`
- `/gsd debug continue <slug>`
  flags: `--diagnose`

## Instant

- `/gsd next [phase]`
  flags: `--phase <phase>`, `--force`
  blocks on paused state, blocking `.planning/.continue-here.md`, active discuss checkpoints, and unresolved verification FAIL before any routing
  `--force` only bypasses blocked/error `STATE.md` status gate; `.continue-here.md`, paused state, discuss checkpoints, and unresolved verification FAIL still stop routing
  missing next-phase discuss prep may route to `/gsd discuss-phase <phase>` before planning
  without workflow session support, `/gsd next` fails closed with warning instead of mutating `STATE.md`
  use when you want safest local next-step routing from current planning state
  examples: `/gsd next`, `/gsd next --phase 2`
- `/gsd stats`
  variants: `json`, `table`, `--json`, `--table`, `--format json`, `--format table`
  unsupported variants fail explicitly instead of falling back to one-line notify output
  phase status is local-artifact driven: `Not Started`, `In Progress`, `Executed`, `Human Needed`, `Complete`
  `Complete` requires authoritative local verification completion, currently `*-UAT.md` with `status: complete`; summarized work without that remains `Executed`
  requirements counts support checklist items, plain local requirement bullets, and traceability status rows; deferred `v2+` sections stay excluded
  structured/table output also includes git commit count, first commit date, and last activity when local repo or planning artifacts provide them
  use when you need local artifact summary without opening docs
  examples: `/gsd stats table`, `/gsd stats json`
- `/gsd health`
  flags: `--repair`, `--context`, `--tokens-used <int>`, `--context-window <int>`
  bare `--context` derives current session token usage when available and can derive window from session or `.planning/config.json`; if token usage is unavailable it reports unknown instead of guessing
  `--tokens-used` and `--context-window` require `--context`; `--repair` and `--context` cannot be combined in one run
- `/gsd status`
  shows active local GSD subagent/session status in UI panel or plain text summary with counts, elapsed time, and activity detail when available
  use when you want current local GSD worker activity, not upstream/global service health

## Workflow Review

- `/gsd progress`
  default route: bundled workflow-launch review session
  flags: `--next`
  `--phase <phase>`, `--force` only with `/gsd progress --next`
  `progress --next --force` inherits `/gsd next` safety gates; `.continue-here.md`, paused state, discuss checkpoints, and unresolved verification FAIL still stop routing
  parsed with explicit unsupported-local error: `--do`, `--forensic`
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
