Current milestone: Tighten validate-phase target resolution.

Tasks:

1. Re-audit local `/gsd validate-phase` after helper-alignment work.
2. Make validation target resolution fully deterministic and fail-closed before broader native validate orchestration.
3. Run focused tests, then full repo checks.
4. Run review loop, fix real findings, sync audit score/claims.

Acceptance:

- `/gsd validate-phase` materially improves by making validation inventory and writable-target resolution fully honest and fail-closed
- audit doc reflects same score and deltas
- no meaningful correctness findings remain in slice scope
