# plan-phase workflow

Slice 1 local baseline plus shipped route extensions.

Default route:

1. Resolve explicit phase or omitted-phase fallback using local roadmap-aware selection.
2. Omitted phase prefers next unplanned roadmap phase first.
3. Reuse existing research unless `--research`; skip when `--skip-research`.
4. Optionally write `RESEARCH.md`.
5. Optionally write `PATTERNS.md`.
6. Planner writes canonical `*-PLAN.md` artifacts directly to disk.
7. Parent validates filename, frontmatter, and minimum task structure before checker.
8. Checker reads disk plans and returns pass/issues.
9. Parent revision loop max 3 attempts.
10. On checker pass or `--skip-verify`, run roadmap dependency annotation and post-planning helper before finalizing `STATE.md` and `ROADMAP.md`.

Research-only route:

1. Resolve explicit `--research-phase`.
2. `--view` reads existing research and exits.
3. Otherwise run researcher to refresh research and exit before planner/checker.

Gaps route:

1. Resolve explicit or omitted target phase through local route selection.
2. Require `VERIFICATION.md` or `UAT.md` evidence before planner runs.
3. Skip research.
4. Feed route context into planner and checker as gap-closure inputs only.

Reviews route:

1. Resolve explicit or omitted target phase through local route selection.
2. Require `REVIEWS.md`.
3. Skip research.
4. Feed review context into planner and checker as replan inputs only.

Core local rules:

- mutually exclusive route flags must fail closed
- canonical plan source of truth stays on disk under `.planning/phases/<phase-dir>/<padded-phase>-<NN>-PLAN.md`
- no JSON-to-markdown synthesis on parity path
- `--view` only works with `--research-phase`
- unsupported upstream flags remain explicit deferred local errors, not silent no-ops
