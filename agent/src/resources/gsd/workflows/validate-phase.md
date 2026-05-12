# validate-phase workflow

Purpose:

- move `/gsd validate-phase` from stub template writer to visible workflow-launch foundation
- preserve thin local TypeScript entrypoint and keep validation behavior in bundled resources
- align omitted-phase local default to helper-ready roadmap-matching phase semantics as closely as practical

Required local reading before execution:

- `$GSD_BUNDLE_DIR/commands/gsd/validate-phase.md`
- `$GSD_BUNDLE_DIR/templates/VALIDATION.md`
- `$GSD_BUNDLE_DIR/references/gates.md`
- `$GSD_TOOLS_PATH` runtime helper contract for `init validate-phase`

Required helper entrypoint in this slice:

- `node "$GSD_TOOLS_PATH" init validate-phase "<phase>"`

Core rules:

1. Parse command arguments from `/gsd validate-phase ...` exactly as passed through by local handler.
2. Treat this file as local adapted behavior contract, not literal shell script.
3. Do not recreate old native template-writer behavior as success path.
4. Validation target must come from helper-reported `validation_target_path`. If helper cannot return one authoritative target, fail closed.
5. Local handler may already pre-seed helper-reported create target with draft `VALIDATION.md` structure before workflow launch. Treat that draft as scaffold only, not final audit output.
6. Omitted phase has already been locally biased toward last helper-ready roadmap-matching SUMMARY-backed phase. Preserve that target unless user explicitly changes it in-session.
7. If selected phase lacks execution evidence, stop with explicit failure. Do not write placeholder validation output.
8. If selected phase has no `*-SUMMARY.md`, fail closed.
9. If selected phase has unresolved core execution absence or phase never ran locally, say this validation path is not supported for non-executed phases in this slice.
10. When validation proceeds, use `$GSD_BUNDLE_DIR/templates/VALIDATION.md` as starting artifact shape.
11. Validation review should focus on shipped local evidence from summaries, roadmap phase goal, requirements mapping, and any existing UAT or verification artifacts.
12. Only treat helper-reported `validation_target_mode: update` as resume/update path. Do not infer update mode from loose glob matches.
13. Use grouped local command names consistently in all user-facing guidance: `/gsd validate-phase`, `/gsd verify-work`, `/gsd execute-phase`.

Recommended execution shape:

1. Resolve selected phase via `node "$GSD_TOOLS_PATH" init validate-phase "<phase>"`.
2. Treat helper output as authoritative for readiness, validation state, target path, target mode, roadmap goal, and requirements in this slice.
3. If helper reports `nyquist_validation_enabled: false`, stop with its `failure_reason`. Do not continue validation authoring.
4. If helper returns `ready: false`, stop with its `failure_reason`. Do not write placeholder validation output.
5. Read all helper-reported `summary_paths`.
6. Read helper-reported `verification_paths` and `uat_paths` when present.
7. If evidence is too weak to validate truthfully, stop with explicit gap summary instead of creating optimistic template output.
8. Otherwise create or update helper-reported `validation_target_path` according to helper-reported `validation_target_mode`, with concrete validation findings and clear pass/gap status. If local handler pre-seeded a draft on create path, revise that file in place instead of creating a second artifact.

Explicit deferrals in this slice:

- no native TS validation orchestrator parity
- no automatic phase completion mutation
- no implicit secure-phase handoff
- no template-only fallback on unsupported cases
