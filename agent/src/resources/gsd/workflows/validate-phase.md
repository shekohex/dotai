# validate-phase workflow

Purpose:

- move `/gsd validate-phase` from stub template writer to visible workflow-launch foundation
- preserve thin local TypeScript entrypoint and keep validation behavior in bundled resources
- align omitted-phase local default to helper-ready roadmap-matching phase semantics as closely as practical
- preserve enforceable Nyquist gap-review and result-routing behavior in bundled local runtime

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
14. When gaps remain, do not silently mark coverage complete. Present an explicit gate and preserve the resulting status in `*-VALIDATION.md`.

Recommended execution shape:

1. Resolve selected phase via `node "$GSD_TOOLS_PATH" init validate-phase "<phase>"`.
2. Treat helper output as authoritative for readiness, validation state, target path, target mode, roadmap goal, and requirements in this slice.
3. If helper reports `nyquist_validation_enabled: false`, stop with its `failure_reason`. Do not continue validation authoring.
4. If helper returns `ready: false`, stop with its `failure_reason`. Do not write placeholder validation output.
5. Read all helper-reported `summary_paths`.
6. Read helper-reported `verification_paths` and `uat_paths` when present.
7. If evidence is too weak to validate truthfully, stop with explicit gap summary instead of creating optimistic template output.
8. Otherwise create or update helper-reported `validation_target_path` according to helper-reported `validation_target_mode`, with concrete validation findings and clear pass/gap status. If local handler pre-seeded a draft on create path, revise that file in place instead of creating a second artifact.

Gap review and auditor contract:

1. Build requirement-to-task map from helper-reported phase goal, roadmap requirements, summaries, verification artifacts, UAT artifacts, and detected test infrastructure.
2. Classify each requirement/task row as `COVERED`, `PARTIAL`, or `MISSING`.
3. Present explicit gap gate when any `PARTIAL` or `MISSING` rows remain:
   - fix all gaps
   - skip and mark manual-only
   - cancel
4. If user chooses fix-all, spawn `gsd-nyquist-auditor` with complete local validation context.
5. Auditor constraints:
   - never modify implementation files directly in this branch
   - limit changes to tests, validation artifacts, and explicit escalation notes
   - escalate implementation bugs instead of pretending validation closure
6. Handle all three auditor return shapes explicitly:
   - `## GAPS FILLED`
   - `## PARTIAL`
   - `## ESCALATE`
7. On `PARTIAL` or `ESCALATE`, move unresolved rows to manual-only or escalated sections inside `*-VALIDATION.md`.

Commit and routing contract:

1. If auditor created or updated test files, commit tests separately before doc strategy commit.

```bash
git add {test_files}
git commit -m "test(phase-${PHASE}): add Nyquist validation tests"
```

2. Persist validation strategy/document updates with:

```bash
gsd-sdk query commit "docs(phase-${PHASE}): add/update validation strategy"
```

3. Results routing:
   - compliant: report Nyquist-compliant and point to `/gsd audit-milestone`
   - partial: report partial/manual-only and keep retry route on `/gsd validate-phase {N}`
4. Do not auto-mutate phase completion state from this workflow slice.

Explicit deferrals in this slice:

- no native TS validation orchestrator parity
- no automatic phase completion mutation
- no implicit secure-phase handoff
- no template-only fallback on unsupported cases
