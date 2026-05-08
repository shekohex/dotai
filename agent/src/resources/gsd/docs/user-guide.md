# GSD User Guide

## Enablement

- `/gsd on` enables GSD in current workspace
- `/gsd off` disables GSD in current workspace
- `/gsd` opens dashboard when UI exists
- `/gsd help` shows command overview

## Core Flow

1. `/gsd new-project`
2. `/gsd map-codebase`
3. `/gsd discuss-phase`
4. `/gsd plan-phase`
5. `/gsd execute-phase`
6. `/gsd verify-work`
7. `/gsd validate-phase`
8. `/gsd next`

Notes:

- `/gsd validate-phase` now runs delegated validation review for executed local phases
- omitted `/gsd validate-phase` target prefers last completed local phase with SUMMARY evidence
- unsupported flags, incomplete phases, or non-executed phases stop with explicit warning instead of writing placeholder template
- `/gsd validate-phase` does not auto-complete phase state in this slice

## Brownfield Flow

- open repo with valid `.planning`
- run `/gsd on`
- continue existing phases in place
- use `/gsd progress`, `/gsd next`, `/gsd health`, `/gsd stats`
- `/gsd next` routes to supported local next action when safety gates clear
- `/gsd next` stops on paused state, blocking `.planning/.continue-here.md`, active discuss checkpoints, and unresolved verification FAIL
- `/gsd next` may route to `/gsd discuss-phase` before planning when next phase lacks local discuss prep
- use `--force` only to bypass local blocked/error status gate; it does not bypass paused/checkpoint safety stops
- if workflow session launch support is unavailable, `/gsd next` warns and leaves `STATE.md` unchanged
- `/gsd health` shows detailed issue and repair lines from bundled validator output, including repair path/detail/error fields when present; `/gsd health --context` accepts bare flag, derives window locally when possible, and reports unknown when token usage is unavailable
- `/gsd stats` is conservative: phase `Complete` means local authoritative verification finished; executed summaries without complete UAT stay `Executed`, `human_needed` verification shows `Human Needed`
- `/gsd stats` requirement totals come from local actionable requirements and traceability rows, not only checklist syntax

## Artifacts

- `.planning/STATE.md`
- `.planning/ROADMAP.md`
- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/phases/*/*-PLAN.md`
- `.planning/phases/*/*-PLAN-CHECK.md`
- `.planning/phases/*/*-VERIFICATION.md`
- `.planning/phases/*/*-VALIDATION.md`
- `.planning/phases/*/*-UAT.md`
- `.planning/research/CODEBASE_MAP.md`
