# /gsd plan-phase

Slice 1 local command spec.

Supported now:

- positional phase
- `--phase`
- `--research-phase`
- `--view` only with `--research-phase`
- `--research`
- `--skip-research`
- `--skip-verify`
- `--text`

Deferred with explicit error:

- `--gaps`
- `--reviews`
- `--prd`
- `--bounce`
- `--skip-bounce`
- `--chunked`
- `--mvp`
- `--skip-ui`
- omitted phase autodetect
- auto or chain orchestration semantics

Canonical plan source of truth:

- `.planning/phases/<phase-dir>/<padded-phase>-<NN>-PLAN.md`
- optional `.planning/phases/<phase-dir>/<padded-phase>-RESEARCH.md`
- optional `.planning/phases/<phase-dir>/<padded-phase>-PATTERNS.md`

Parent TypeScript orchestrator owns route selection, role spawning, disk validation, checker loop, and final state mutation.
