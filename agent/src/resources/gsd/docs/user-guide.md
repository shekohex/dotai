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

## Brownfield Flow

- open repo with valid `.planning`
- run `/gsd on`
- continue existing phases in place
- use `/gsd progress`, `/gsd next`, `/gsd health`, `/gsd stats`

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
