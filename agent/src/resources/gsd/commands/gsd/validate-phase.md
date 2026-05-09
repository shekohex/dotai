# /gsd validate-phase

Local parity slice for validation review.

Supported now:

- optional positional phase
- optional `--phase`
- explicit unsupported-arg rejection in local parser
- workflow-launch foundation for visible validation session orchestration
- omitted phase defaults to last helper-ready local phase with roadmap-matching SUMMARY evidence

Rejected now:

- extra positional args after phase
- unknown flags
- clearly unsupported shared flags from other grouped commands

Execution model in this slice:

- handler resolves explicit phase or last helper-ready local phase before launch
- handler fails closed when selected local phase is not complete enough for validation contract
- bundled workflow owns validation review and artifact-writing contract
- bundled workflow should use `node "$GSD_TOOLS_PATH" init validate-phase "<phase>"` as deterministic preflight
- do not use native template-writer shortcut as authoritative path

Contract notes:

- authoritative local artifact remains `.planning/phases/<phase-dir>/<phase>-VALIDATION.md`
- omitted phase should prefer honest helper-ready roadmap-matching semantics, not current/incomplete phase pointer
- if selected phase has not been executed locally, stop with explicit non-support or missing-prerequisite message
- use grouped local command names consistently: `/gsd validate-phase`, `/gsd verify-work`, `/gsd execute-phase`
