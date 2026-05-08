# /gsd execute-phase

Slice 1 local command spec.

Supported now:

- positional phase
- `--phase`
- `--wave`
- `--gaps-only`
- `--interactive`
- `--validate`
- `--cross-ai`
- `--no-cross-ai`
- `--tdd`
- `--mvp`
- `--auto`

Execution model in this slice:

- handler routes into workflow-launch foundation
- bundled workflow owns wave discovery, filtering, checkpoints, and verification gating
- local runtime primitives already shipped in bundle remain source of truth
- do not recreate upstream shell orchestration in TypeScript for this slice

Contract notes:

- explicit phase is required in Slice 1 foundation; no implicit current-phase resolution
- extra positional tokens are rejected once phase is already set
- active flags are only flags present in command arguments
- `--wave` requires positive integer value and limits execution to matching wave while preserving lower-wave safety gate
- if `--wave` is active and unmatched incomplete plans remain after selected wave finishes, stop after selected wave, skip phase verification, skip phase completion, and report remaining work
- `--gaps-only` limits execution to gap-closure plans only
- `--interactive` switches to inline sequential execution with checkpoints instead of delegated parallel workers
- `--validate` requests init-context validation data in workflow and keeps validation wording in user-facing contract for this slice
- `--cross-ai` forces cross-AI delegation path defined by bundled workflow
- `--no-cross-ai` disables cross-AI delegation path for this run and takes precedence when both cross-AI toggles are present
- `--tdd`, `--mvp`, and `--auto` are accepted and preserved for bundled workflow/runtime handling; local TypeScript layer does not reinterpret them beyond parse and pass-through
