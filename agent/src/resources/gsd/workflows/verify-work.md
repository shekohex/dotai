# verify-work workflow

Slice 3 local upstream-shaped UAT foundation plus post-UAT closure loop.

Purpose:

- move `/gsd verify-work` from native verifier shortcut to visible workflow session orchestration
- make upstream-shaped `UAT.md` authoritative for verify progress
- keep scope to highest-leverage core UAT session path only
- preserve existing `init verify-work` phase resolution semantics as authoritative
- preserve diagnosis, gap-follow-up, and post-UAT closure behavior in bundled local runtime

Required local reading before execution:

- `$GSD_BUNDLE_DIR/commands/gsd/verify-work.md`
- `$GSD_BUNDLE_DIR/templates/UAT.md`
- `$GSD_TOOLS_PATH` runtime helper contract for `init verify-work`

Required helper entrypoints in this slice:

- `node "$GSD_TOOLS_PATH" verify-work session [--phase <N>]`
- `node "$GSD_TOOLS_PATH" verify-work create --phase <N>`
- `node "$GSD_TOOLS_PATH" verify-work classify --response "..."`
- `node "$GSD_TOOLS_PATH" verify-work status --file <uat-path>`
- `node "$GSD_TOOLS_PATH" verify-work apply-response --file <uat-path> --response "..."`
- `node "$GSD_TOOLS_PATH" verify-work apply-diagnosis --file <uat-path> --diagnosis <json-or-file>`
- `node "$GSD_TOOLS_PATH" uat render-checkpoint --file <uat-path>`

Core rules:

1. Parse command arguments from `/gsd verify-work ...` exactly as passed through by local handler.
2. Treat this file as local adapted behavior contract, not literal shell script.
3. Do not call local native `orchestrateVerifyWork()` path.
4. Do not use `writeVerificationReport()`, `writeValidationArtifact()`, `writeUatArtifact()`, or native `writeStateFields(... status: "Phase complete" ...)` behavior for `/gsd verify-work` in this slice.
5. Authoritative artifact is `.planning/phases/<phase-dir>/<phase>-UAT.md`.
6. `UAT.md` must survive `/clear`, drive resume, and feed later gap-closure planning.
7. Required lifecycle states in active `/gsd verify-work` flow: `testing`, `partial`, `complete`.
8. Diagnosed state may exist on disk after helper-backed diagnosis persistence and should be preserved when diagnosis branch runs.
9. Use helper-backed mutation primitives as authoritative write path for test responses and diagnosis persistence.
10. Use grouped local command names consistently in all user-facing guidance: `/gsd verify-work`, `/gsd plan-phase`, `/gsd execute-phase`.
11. If deferred branches surface, say they are not yet supported in this slice.
12. Unsupported verify-work args must be rejected by local handler before workflow launch; workflow may assume only supported raw args reach this session.

## 1. Resolve Target Session

1. If phase arg present, resolve phase with existing `node "$GSD_TOOLS_PATH" init verify-work "<phase>"` semantics.
2. Preserve current `init.verify-work` authority:
   - ROADMAP fallback when phase dir missing
   - archived milestone guard with reused phase number
3. Do not cargo-cult `uat_path` into init if local runtime contract does not need it.
4. If phase arg absent:
   - detect active `*-UAT.md` sessions across `.planning/phases/*`
   - if exactly one active session exists, offer resume or phase selection
   - if multiple active sessions exist, offer explicit phase selection
   - if no active session exists, offer phase selection from verifiable phases
5. Prefer local helper output from `verify-work session` for session discovery and resume-or-restart prompts.
6. When no active session exists, candidate phases come from phase directories that already contain verifiable `*-SUMMARY.md` artifacts.

## 2. Determine Resume Or Restart

1. If existing session for same phase exists, offer resume or restart choice.
2. Resume path:
   - read frontmatter status
   - read `Current Test`
   - continue from first unresolved item
3. Restart path:
   - regenerate tests from summaries
   - overwrite artifact with fresh `testing` session

## 3. Bootstrap New UAT Artifact

1. When no session exists, parse phase `*-SUMMARY.md` files.
2. Extract user-observable tests only.
3. If file patterns indicate cold-start risk, inject one cold-start smoke test.
4. Create `.planning/phases/<phase-dir>/<phase>-UAT.md` from `$GSD_BUNDLE_DIR/templates/UAT.md`.
5. Prefer local helper `verify-work create --phase <N>` for summary parsing, cold-start smoke injection, and initial Summary counts.
6. Required contract coverage in created artifact:
   - frontmatter fields for `status`, `phase`, `source`, `started`, `updated`
   - `## Current Test`
   - `## Summary`
   - `## Gaps`
   - `blocked_by`
   - diagnosis placeholders may remain present but unused in this slice

## 4. Run Core UAT Loop

1. Render one checkpoint at a time.
2. Render via `uat render-checkpoint` only.
3. Output raw helper checkpoint with no prefix/suffix.
4. Present current test with expected user-observable behavior.
5. Accept plain-text user response.
6. Classify response with exact local helper contract, not generic sentiment buckets.
7. Persist UAT progress after every response via `verify-work apply-response`.
8. Update `Current Test`, `Summary`, and `Gaps` as authoritative state.
9. When pausing early or unresolved items remain, set status to `partial` and commit UAT.
10. When all tests resolved, set terminal status to `complete`.

## 5. Manual Diagnosis Persistence

1. If external/manual diagnosis data is available, persist it via `verify-work apply-diagnosis`.
2. Persist `root_cause`, `artifacts`, `missing`, and `debug_session` into UAT.
3. Status helper must preserve `diagnosed` when stored in frontmatter.
4. When UAT issues are confirmed, workflow may run diagnosis and follow-up planning steps, but must persist outputs through helper-backed `apply-diagnosis`.

## 6. Diagnosis And Gap-Planning Branch

1. If one or more checkpoints end in issue/blocker state, pause normal pass-through and summarize open gaps from authoritative `UAT.md`.
2. Ask whether to:
   - diagnose now
   - stop and resume later
   - accept current UAT artifact only
3. Diagnose-now branch:
   - derive root-cause notes from current UAT gaps, relevant summaries, verification artifacts, and available debug context
   - persist diagnosis via `verify-work apply-diagnosis`
   - if diagnosis identifies clear execution follow-up, prepare `/gsd plan-phase --gaps <phase>` style guidance
4. If follow-up planning is requested, spawn planner/checker style analysis using local grouped command names and keep implementation edits out of this workflow.
5. Do not pretend gaps are closed after diagnosis. Persist diagnosed state and stop with explicit next-step guidance when fixes are still required.

## 7. Post-UAT Closure Guidance

1. If status is `complete` and no unresolved issues remain, run closure review before final summary.
2. Artifact acknowledgment branch:
   - check whether open artifact debt should be acknowledged before final completion claims
   - if artifact debt exists, surface it explicitly and tell user to resolve or acknowledge it before calling phase fully done
3. Security closure branch:
   - if UAT is clear and security review is still pending, point to `/gsd secure-phase {phase}`
4. Transition closure branch:
   - if UAT and security are both clear, point to the next grouped local command rather than mutating phase state automatically in this workflow slice
5. Final success summary should distinguish:
   - UAT complete, security pending
   - UAT complete, artifact acknowledgment pending
   - UAT complete, ready for next grouped command

## 8. Explicit Deferrals

1. Not yet supported in this slice:
   - Playwright/Puppeteer auto-verification branch
   - MVP-mode branch via `phase.mvp-mode`
   - automatic phase completion mutation

Runtime contract:

- `GSD_BUNDLE_DIR` is injected by workflow launcher as concrete absolute bundle path
- `GSD_TOOLS_PATH` is injected by workflow launcher as concrete absolute local helper path
- use bundled `UAT.md` template as authoritative template shape
