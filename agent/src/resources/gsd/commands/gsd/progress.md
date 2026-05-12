# /gsd progress

Slice 3 local command spec.

Supported now:

- default workflow-launch foundation for visible progress session orchestration
- `--next` delegates to existing local next-routing behavior
- `--phase <phase>` and `--force` only with `/gsd progress --next`
- explicit unsupported-local error for `--do`, `--forensic`

Execution model in this slice:

- default handler routes into workflow-launch foundation
- default handler first fails closed when core planning files required for truthful progress review are missing
- bundled workflow owns progress inspection, artifact reading, summary shaping, and next-step guidance
- local runtime primitives already shipped in bundle remain source of truth for progress math and roadmap/state interpretation
- do not recreate old one-line TypeScript notifier as authoritative success path

Contract notes:

- default `/gsd progress` is read/review workflow, not routed execution
- preserve existing `/gsd progress --next` semantics exactly, including mixed-state routing and earliest-incomplete phase bias
- grouped local command names only in user-facing guidance: `/gsd progress`, `/gsd next`, `/gsd execute-phase`, `/gsd verify-work`, `/gsd complete-milestone`
- if user wants routed execution from progress, stop and direct them to supported local commands instead of pretending `--do` exists
- if user asks for forensic/debug style progress analysis, stop and state `--forensic` is not implemented in local command yet
