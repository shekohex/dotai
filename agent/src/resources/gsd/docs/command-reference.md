# GSD Command Reference

## Control

- `/gsd`
- `/gsd on`
- `/gsd off`
- `/gsd help`

## Lifecycle

- `/gsd new-project`
- `/gsd map-codebase`
- `/gsd discuss-phase [phase]`
- `/gsd plan-phase [phase]`
- `/gsd execute-phase [phase]`
- `/gsd verify-work [phase]`
- `/gsd validate-phase [phase]`

## Instant

- `/gsd next [phase]`
- `/gsd progress`
- `/gsd stats`
- `/gsd health`

## Phase Override

Supported forms:

- positional: `/gsd plan-phase 2`
- flag: `/gsd execute-phase --phase 3.1`
- equals flag: `/gsd next --phase=4`
