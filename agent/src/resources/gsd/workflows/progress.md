# progress workflow

Purpose:

- move default `/gsd progress` from one-line notify output to visible workflow-launch foundation
- keep TypeScript entry thin and let bundled local resource own progress review contract
- reuse existing local helper/query surface before inferring progress claims

Required local reading before execution:

- `$GSD_BUNDLE_DIR/commands/gsd/progress.md`
- `$GSD_BUNDLE_DIR/docs/command-reference.md`

Core rules:

1. Parse command arguments from `/gsd progress ...` exactly as passed by local handler.
2. Treat this file as local adapted behavior contract, not literal shell script.
3. Default path here is read/review only. Do not launch plan execution from progress in this slice.
4. Do not recreate old one-line TypeScript notifier as success path.
5. Local handler may stop before workflow launch when `.planning/PROJECT.md`, `.planning/ROADMAP.md`, or `.planning/STATE.md` is missing. Treat those prerequisite failures as authoritative.
6. Preserve explicit unsupported handling for `--do` and `--forensic`; those modes are not implemented here.
7. Reuse bundled local helper/query surface before making claims: `node "$GSD_TOOLS_PATH" init progress` and `node "$GSD_TOOLS_PATH" progress json`.
8. Cross-check helper output against local `.planning/STATE.md`, `.planning/ROADMAP.md`, and relevant phase artifacts when wording user-facing summary.
9. If helper/query output and on-disk artifacts disagree, say so plainly and identify likely source of drift instead of smoothing it over.
10. Use grouped local command names consistently in all user-facing guidance.

Recommended execution shape:

1. Run `node "$GSD_TOOLS_PATH" init progress` to gather current project/milestone/phase context.
2. Run `node "$GSD_TOOLS_PATH" progress json` to gather machine-readable progress snapshot.
3. Read `.planning/STATE.md` and `.planning/ROADMAP.md` directly.
4. Inspect current or earliest-incomplete phase directory when helper/query output points at active execution or drift.
5. Summarize milestone, current phase, completed-vs-total progress, blockers or drift, and best supported next command.

Output contract for this slice:

- concise human progress summary, not one-line bar-only notifier
- mention when phase state looks drifted ahead/behind roadmap artifacts
- recommend supported next local command when obvious: `/gsd next`, `/gsd execute-phase`, `/gsd verify-work`, or `/gsd complete-milestone`
- no fake parity claims about `--do` or `--forensic`
