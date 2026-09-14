# Initiative lifecycle

## Charter

Research may start automatically. Implementation waits for charter approval. Charter defines outcome, measurable completion, non-goals, repositories, task graph, acceptance, evidence, risks, PR strategy, and release boundary.

Approval covers scoped implementation only. Merge, deployment, destructive actions, and material charter changes remain separate.

## State model

Keep task state and phase orthogonal:

```text
state: pending | active | blocked | complete | deferred | cancelled
phase: research | build | validate | review | merge | deploy
```

Track implementation, focused validation, heavy validation, evidence, review, signoff, merge approval, and deployment as separate gates. Gate states are `not_required`, `pending`, `running`, `passed`, `failed`, or `waived`. `waived` requires exact one-time approval and audit event.

## Task ownership

One task has one active owner. Several tightly coupled tasks may produce one coherent PR. One task may produce sequential PRs. PR boundary follows reviewable behavior, not task count. Never permit concurrent writers on same branch/worktree.

## Completion

Close initiative only after accepted tasks reach terminal state, required release gates pass, resources and leases clear, durable decisions/knowledge are promoted, and final summary identifies outcomes plus explicit deferrals. Archive operational detail; preserve audit history.

Archiving is reversible visibility state, not a replacement outcome. Set `archived_at` and `archive_reason` only after completion criteria pass. Keep initiative, tasks, reviews, approvals, artifacts, deployments, decisions, and events indefinitely in SQLite. Exclude archived initiatives from startup context; load them only for history, dependency provenance, audit, or explicit user request. Unarchive by clearing both archive fields and recording reason through guarded SQL. Never auto-delete archived state.
