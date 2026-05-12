# /gsd verify-work

Slice 1 local command spec.

Supported now:

- optional positional phase
- optional `--phase`
- workflow-launch foundation for visible UAT session orchestration
- manual diagnosis persistence shape through helper/runtime
- workflow-owned diagnosis, gap-planning, and post-UAT closure guidance

Rejected now:

- extra positional args after phase
- unknown flags
- shared irrelevant flags from other grouped commands

Deferred with explicit non-support in this slice:

- Playwright/Puppeteer auto-verification branch
- `phase.mvp-mode` branch
- native TS verifier shortcut as authoritative completion path

Execution model in this slice:

- handler routes into workflow-launch foundation
- bundled workflow owns resume detection, phase selection, single-checkpoint prompting, and UAT persistence contract
- local runtime primitives already shipped in bundle remain source of truth for phase resolution semantics
- do not recreate upstream shell orchestration in TypeScript for this slice

Contract notes:

- authoritative artifact is `.planning/phases/<phase-dir>/<phase>-UAT.md`
- `UAT.md` is single source of truth for verify progress, resume after `/clear`, and later `/gsd plan-phase --gaps`
- lifecycle states used by local `/gsd verify-work` session flow: `testing`, `partial`, `complete`
- diagnosed state may be persisted manually or through workflow-owned diagnosis/planning branch when UAT fails
- if phase arg is absent, workflow must detect active `*-UAT.md` sessions and offer resume or phase selection
- if same-phase session exists, workflow must offer resume or restart
- if no session exists, workflow must parse `*-SUMMARY.md`, extract user-observable tests, and inject cold-start smoke when file patterns match
- render one checkpoint at a time, accept plain-text response, classify result, persist UAT progress, and commit UAT on pause or completion
- if issues remain, workflow must diagnose, persist gap details, and prepare `/gsd plan-phase --gaps` style follow-up guidance
- if zero issues, workflow must run explicit closure guidance for artifact acknowledgment, `/gsd secure-phase`, and final transition suggestions without mutating phase state automatically
- use grouped local command names consistently: `/gsd verify-work`, `/gsd plan-phase`, `/gsd execute-phase`
