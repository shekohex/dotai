# validate-phase workflow

Purpose:

- move `/gsd validate-phase` from stub template writer to visible workflow-launch foundation
- preserve thin local TypeScript entrypoint and keep validation behavior in bundled resources
- align omitted-phase local default to last completed phase semantics as closely as practical

Required local reading before execution:

- `$GSD_BUNDLE_DIR/commands/gsd/validate-phase.md`
- `$GSD_BUNDLE_DIR/templates/VALIDATION.md`
- `$GSD_BUNDLE_DIR/references/gates.md`

Core rules:

1. Parse command arguments from `/gsd validate-phase ...` exactly as passed through by local handler.
2. Treat this file as local adapted behavior contract, not literal shell script.
3. Do not recreate old native template-writer behavior as success path.
4. Authoritative artifact path is `.planning/phases/<phase-dir>/<phase>-VALIDATION.md`.
5. Omitted phase has already been locally biased toward last completed SUMMARY-backed phase. Preserve that target unless user explicitly changes it in-session.
6. If selected phase lacks execution evidence, stop with explicit failure. Do not write placeholder validation output.
7. If selected phase has no `*-SUMMARY.md`, fail closed.
8. If selected phase has unresolved core execution absence or phase never ran locally, say this validation path is not supported for non-executed phases in this slice.
9. When validation proceeds, use `$GSD_BUNDLE_DIR/templates/VALIDATION.md` as starting artifact shape.
10. Validation review should focus on shipped local evidence from summaries, roadmap phase goal, requirements mapping, and any existing UAT or verification artifacts.
11. If existing `*-VALIDATION.md` already exists, treat it as resume/update target instead of silently overwriting.
12. Use grouped local command names consistently in all user-facing guidance: `/gsd validate-phase`, `/gsd verify-work`, `/gsd execute-phase`.

Recommended execution shape:

1. Resolve selected phase artifact directory.
2. Read ROADMAP phase goal and requirements for that phase.
3. Read all `*-SUMMARY.md` in phase directory.
4. Read `*-UAT.md` and `*-VERIFICATION.md` when present.
5. If evidence is too weak to validate truthfully, stop with explicit gap summary instead of creating optimistic template output.
6. Otherwise write or update `*-VALIDATION.md` with concrete validation findings and clear pass/gap status.

Explicit deferrals in this slice:

- no native TS validation orchestrator parity
- no automatic phase completion mutation
- no implicit secure-phase handoff
- no template-only fallback on unsupported cases
