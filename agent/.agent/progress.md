Current milestone: Tighten validate-phase target resolution

Status:

- execute-phase slice completed earlier at credible 91/100 and remains validation-clean
- verify-work slice completed earlier at credible 90/100 and remains validation-clean
- milestone-summary slice completed earlier at credible 91/100 and remains validation-clean
- debug slice completed earlier at credible 91/100 and remains validation-clean
- progress re-audit completed: baseline score was 46/100 before workflow-launch work because default `/gsd progress` was still thin local summary behavior
- help re-audit completed: parity improved to about 58% after usability work, but migration confusion from upstream command names and non-UI output contract still lagged
- stats re-audit completed: real parity was about 43% because phase completion, milestone scoping, and requirement counting were overstating or miscounting normal local data
- health re-audit completed: baseline was 62/100 before current workflow slice because bundled validator/repair backend carried core integrity logic, but user-facing `--context` and detailed output parity still lagged
- next re-audit completed: real parity was about 44% because route-and-dispatch baseline existed, but upstream-style pre-routing safety and discuss/resume sequencing still lagged
- validate-phase re-audit completed: runtime parity still lagged after helper-alignment because validation target resolution and payload honesty were not yet fully fail-closed
- implementation completed: default `/gsd progress` now launches bundled local command/workflow resources through workflow-launch foundation, while `progress --next` still routes through local next-action logic and unsupported `--do` / `--forensic` modes remain explicit
- review loop completed: repeated `review` passes closed stale instant/deterministic doc claims, command taxonomy drift, and old notify-path references; latest progress workflow review returned clean
- implementation completed: `/gsd health --context` now works without hidden numeric flags, derives context values from explicit args/session metrics/config/defaults in honest order, reports unknown usage instead of inventing `0`, and default health output now shows detailed issue and repair lines with bundled detail preserved
- review loop completed: repeated `review` passes closed malformed-config severity drift, schema-doc mismatches, false-green unknown context usage, and dropped repair detail; latest health workflow review returned clean
- implementation completed: `/gsd stats` now canonicalizes padded/unpadded phase ids, counts real local REQUIREMENTS formats while excluding only deferred `v2+` scope, scopes milestones exactly across headings and `<details><summary>` blocks, and uses conservative verification-aware phase status semantics where only authoritative local UAT completion yields `Complete`
- review loop completed: repeated `review` passes closed milestone exact-match drift, `v1*` requirement filtering bugs, deferred traceability leak-back, and verification-only phase-start misclassification; latest stats review returned clean
- implementation completed: `/gsd next` now runs pre-routing safety gates for paused/checkpoint/continue-here/verification-fail states, routes missing discuss prep to `/gsd discuss-phase`, fails closed honestly when workflow launch is unavailable, and normalizes padded/unpadded brownfield phase ids for checkpoint/context/failure detection
- review loop completed: repeated `review` passes closed discuss-loop routing, brownfield checkpoint path drift, and padded phase-id matching bugs; latest next review returned clean
- implementation completed: `/gsd validate-phase` now fails closed for explicit incomplete phases, uses helper-backed deterministic preflight to resolve readiness/artifact paths, and rejects malformed or non-roadmap summary sets by matching SUMMARY ids against roadmap plan ids
- review loop completed: repeated `review` passes closed stale state-update doc claims and helper readiness mismatches; latest validate-phase review returned clean
- implementation completed: `/gsd help` now documents local `map-codebase` support more honestly, audit roster is internally consistent for `secure-phase`, `help`, and `mvp-phase`, and new tests guard both command-reference drift and audit/runtime roster drift in both directions
- review loop completed: repeated `review` passes closed stale audit omissions and one-way guardrail gaps; latest help review returned clean
- implementation completed: non-UI `/gsd help` now emits durable command output, primary help adds accurate first-run guidance plus concise quick start/when-to-use/examples for implemented local commands, and wording avoids overclaiming unsupported-input rejection guarantees
- review loop completed: repeated `review` passes closed false enablement guidance and overbroad validation claims; latest help usability review returned clean
- implementation completed: `validate-phase` selection now rejects malformed/non-roadmap summary inventories before workflow launch, omitted selection falls back to last helper-ready roadmap-matching phase, and workflow handoff/resources describe helper-ready semantics consistently
- review loop completed: repeated `review` passes closed helper-readiness mismatches, malformed-summary reason ordering, and stale omitted-phase wording in command/workflow handoff docs; latest validate-phase review returned clean
- implementation completed: `/gsd help` now includes an explicit upstream-to-local crosswalk, unsupported-command guidance, and a registered durable `gsd-help` renderer contract for non-UI output
- review loop completed: latest help migration review returned clean
- implementation completed: `init validate-phase` now resolves a single authoritative validation target or fails closed, detects non-canonical/lowercase validation-like artifacts, and keeps `validation_exists`, `validation_target_path`, and legacy `validation_path` consistent across success and failure cases
- review loop completed: latest validate-phase target-resolution review returned clean
- verification completed: `npm run typecheck`, `npm test`, `npm run lint`, `npm run format:check` all pass

Decision log:

- chose workflow-launch foundation for default `/gsd progress` after correcting state math
- rationale: biggest remaining progress gap was command identity; moving default path onto bundled resources creates honest architecture for later richer parity work
- trade-off: default progress is now workflow-backed, but advanced upstream `--do` / `--forensic` branches still remain unsupported and explicitly rejected
- chose broader user-facing `health` parity after baseline severity fix
- rationale: biggest remaining health gap was that a documented primary mode, bare `--context`, was not actually usable and default output hid real repair detail
- trade-off: local context derivation still depends on session metrics for exact token usage and now says so explicitly when unavailable
- chose shared stats truth-model fixes over output polish
- rationale: biggest remaining stats gap was false completion and bad scoping/counting in normal local artifacts, so core state truth had to be fixed before richer presentation work
- trade-off: stats still does not claim full upstream git/activity/workflow parity, but current local numbers and statuses are materially more honest
- chose upstream-like pre-routing safety before broader next route graph work
- rationale: biggest remaining next gap was lifecycle sequencing correctness; without pause/checkpoint/discuss gates, local routing could advance into wrong workflow stages
- trade-off: local next still does not implement full upstream resume/checkpoint graph or every branch, but shipped routes now fail more honestly and safely
- chose deterministic validate-phase preflight before any larger Nyquist-native executor work
- rationale: biggest remaining validate-phase gap was fail-open readiness and prompt-only orchestration; helper-backed preflight gives deterministic branch truth without faking full executor parity
- trade-off: actual Nyquist audit/write loop still runs through workflow session, not native TS executor
- chose help/runtime guardrails over immediate prose expansion
- rationale: biggest remaining help gap was false-support drift, not renderer behavior; guardrails reduce future dishonesty across canonical docs and audit rosters
- trade-off: help content breadth still trails upstream workflow help substantially even though current local surface is documented more honestly
- chose help usability after guardrails were in place
- rationale: biggest remaining help gap shifted from drift risk to decision support and non-UI usability, so adding accurate quick-start/task guidance had better user value than more audit work
- trade-off: help still documents only implemented local commands and does not attempt upstream full-surface teaching
- chose helper-alignment over speculative Nyquist executor work for validate-phase
- rationale: biggest remaining validate-phase risk was deterministic preflight disagreeing with launch-time messaging and selection, so fail-closed helper alignment had to be finished first
- trade-off: validate-phase still lacks native Nyquist executor behavior; workflow session still performs actual validation authoring
- chose help migration guidance after basic usability landed
- rationale: biggest remaining help gap shifted to upstream-to-local command confusion and non-UI contract clarity, so crosswalk guidance had highest leverage
- trade-off: crosswalk covers highest-traffic misses, not full upstream catalog
- chose deterministic validation-target resolution before broader native validate orchestration
- rationale: biggest remaining validate-phase risk was ambiguous or dishonest artifact targeting; helper contract had to become fully fail-closed before larger executor work
- trade-off: validate-phase still lacks native Nyquist executor behavior after target resolution is hardened

Architecture state:

- grouped command entry lives in TS under `src/extensions/gsd`
- workflow-native execute-phase behavior is owned by `src/resources/gsd/commands/gsd/execute-phase.md` and `src/resources/gsd/workflows/execute-phase.md`
- workflow-native verify-work behavior plus helper runtime now live in `src/resources/gsd/commands/gsd/verify-work.md`, `src/resources/gsd/workflows/verify-work.md`, `src/resources/gsd/templates/UAT.md`, and `src/resources/gsd/bin/lib/verify-work.cjs`
- workflow-native milestone-summary behavior is owned by `src/resources/gsd/commands/gsd/milestone-summary.md` and `src/resources/gsd/workflows/milestone-summary.md`, with launch constraints in `src/extensions/gsd/lifecycle/milestone-summary.ts`
- debug command surface is now split intentionally: `start/continue` route through workflow launch, while `list/status` render from `src/extensions/gsd/state/debug.ts` and `src/extensions/gsd/lifecycle/debug.ts`
- progress command surface now splits between workflow-launch default handling in `src/extensions/gsd/lifecycle/progress.ts` and routed next/state helpers in `src/extensions/gsd/instant/next.ts`, `src/extensions/gsd/state/runtime.ts`, and `src/extensions/gsd/state/progress.ts`; bundled resources now live at `src/resources/gsd/commands/gsd/progress.md` and `src/resources/gsd/workflows/progress.md`
- help command now uses `src/resources/gsd/docs/command-reference.md` as its single content source, with viewport-aware paging in `src/extensions/gsd/help.ts`
- help/runtime parity guardrails now live in `test/gsd/resources.test.ts`, covering command-reference and audit roster alignment for upstream-mirrored grouped commands
- help non-UI output now uses durable command messaging from `src/extensions/gsd/help.ts`, with usability/content assertions in `test/gsd/commands.test.ts` and `test/gsd/ui.test.ts`
- help durable output now also has explicit `gsd-help` renderer registration in `src/extensions/gsd/ui/messages.ts` with contract coverage in `test/gsd/index.test.ts`
- stats command now uses structured milestone-aware data from `src/extensions/gsd/state/stats.ts`, support logic from `src/extensions/gsd/state/stats-support.ts`, and mode-aware rendering in `src/extensions/gsd/instant/stats.ts`
- health command now uses bundled validator-backed execution in `src/extensions/gsd/instant/health.ts`, backed by a cheap local summary in `src/extensions/gsd/state/health.ts` for autocomplete/dashboard hot paths; context derivation now also reads upstream-style `context_window` from `src/extensions/gsd/state/schema.ts`
- health hot-path baseline now classifies malformed config as broken in local summary too, with regression coverage in `test/gsd/health-state.test.ts` and `test/gsd/brownfield.test.ts`
- next command now has dedicated parsers and route-and-dispatch logic in `src/extensions/gsd/next-args.ts`, `src/extensions/gsd/progress-args.ts`, and `src/extensions/gsd/instant/next.ts`
- next command pre-routing now also uses local discuss state helpers in `src/extensions/gsd/state/discuss.ts` and normalized brownfield phase matching in `src/extensions/gsd/instant/next.ts`
- validate-phase now has dedicated parser, state resolver, and workflow-launch resources in `src/extensions/gsd/validate-phase-args.ts`, `src/extensions/gsd/state/validate-phase.ts`, `src/extensions/gsd/lifecycle/validate-phase.ts`, `src/resources/gsd/commands/gsd/validate-phase.md`, and `src/resources/gsd/workflows/validate-phase.md`
- validate-phase now also has helper-backed deterministic preflight in `src/resources/gsd/bin/lib/init.cjs` with workflow routing through `init-command-router.cjs` and regression coverage in `test/gsd/validate-phase-workflow.test.ts`
- validate-phase helper alignment and omitted-phase semantics now have extra lifecycle/resource coverage in `test/gsd/lifecycle.test.ts` and `test/gsd/resources.test.ts`
- validate-phase target-resolution contract now has deeper payload-shape coverage in `test/gsd/validate-phase-workflow.test.ts`
- focused parity tests live in `test/gsd/commands.test.ts`, `test/gsd/resources.test.ts`, `test/gsd/execute-phase-workflow.test.ts`, `test/gsd/verify-work-workflow.test.ts`, `test/gsd/uat.test.ts`, `test/gsd/lifecycle.test.ts`, `test/gsd/roadmap.test.ts`, `test/gsd/instant.test.ts`, `test/gsd/ui.test.ts`, `test/gsd/health-summary-paths.test.ts`, and `test/gsd/brownfield.test.ts`
