# plan-phase workflow

Slice 1 local baseline.

Default route:

1. Resolve explicit phase.
2. Reuse existing research unless `--research`; skip when `--skip-research`.
3. Optionally write `RESEARCH.md`.
4. Optionally write `PATTERNS.md`.
5. Planner writes canonical `*-PLAN.md` artifacts directly to disk.
6. Parent validates filename, frontmatter, and minimum task structure before checker.
7. Checker reads disk plans and returns pass/issues.
8. Parent revision loop max 3 attempts.
9. Finalize `STATE.md` and `ROADMAP.md` only after valid plans plus checker pass, or valid plans plus `--skip-verify`.

Research-only route:

1. Resolve explicit `--research-phase`.
2. `--view` reads existing research and exits.
3. Otherwise run researcher to refresh research and exit before planner/checker.
