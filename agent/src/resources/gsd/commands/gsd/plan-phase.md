# /gsd plan-phase

Slice 1 local command spec.

Supported now:

- positional phase
- `--phase`
- `--research-phase`
- `--view` only with `--research-phase`
- `--research`
- `--skip-research`
- `--gaps`
- `--reviews`
- `--skip-verify`
- `--text`

Deferred with explicit error:

- `--prd`
- `--bounce`
- `--skip-bounce`
- `--chunked`
- `--mvp`
- `--skip-ui`
- auto or chain orchestration semantics

Canonical plan source of truth:

- `.planning/phases/<phase-dir>/<padded-phase>-<NN>-PLAN.md`
- optional `.planning/phases/<phase-dir>/<padded-phase>-RESEARCH.md`
- optional `.planning/phases/<phase-dir>/<padded-phase>-PATTERNS.md`

Parent TypeScript orchestrator owns route selection, role spawning, disk validation, checker loop, and final state mutation.

Contract notes:

- omitted phase prefers next unplanned roadmap phase first, then falls back to last eligible completed route-specific phase only when needed
- `--gaps` skips research and requires verification evidence from `VERIFICATION.md` or `UAT.md`
- `--reviews` skips research and requires `REVIEWS.md`
- checker-approved plans or `--skip-verify` success still run roadmap dependency annotation plus bundled post-planning helper before final state mutation
