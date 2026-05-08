# /gsd secure-phase

Slice 3 local command spec.

Supported now:

- positional phase
- `--phase`

Execution model in this slice:

- handler routes into workflow-launch foundation
- bundled workflow owns security review orchestration and SECURITY.md follow-up
- used by `/gsd verify-work` completion routing when zero issues remain but security is blocked

Contract notes:

- explicit phase strongly preferred
- use grouped local command names consistently: `/gsd secure-phase`, `/gsd verify-work`
- no native TypeScript reimplementation of secure orchestration in this slice
