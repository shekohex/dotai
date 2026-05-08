# diagnose-issues workflow

Purpose:

- close verify-work issue branch after UAT completes with one or more issues
- persist diagnosis fields into authoritative UAT artifact for local gap-closure planning

Core flow:

1. Load current `*-UAT.md` and read `## Gaps` entries with `status: failed`.
2. Auto-run diagnosis when `issues > 0`.
3. Spawn `gsd-debugger` per gap in diagnose-only mode.
4. Persist `root_cause`, `artifacts`, `missing`, and `debug_session` into UAT via `node "$GSD_TOOLS_PATH" verify-work apply-diagnosis --file <uat> --diagnosis <json-or-file>`.
5. Keep diagnosed UAT shape compatible with local `/gsd plan-phase --gaps` planner path.
6. Run planner in gap-closure mode.
7. Run checker.
8. Revision loop max 3.
9. End at ready-to-execute summary for `/gsd execute-phase {phase} --gaps-only`.
