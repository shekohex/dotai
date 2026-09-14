# Delegation and resources

## Capability discovery

Prefer configured harness profiles and read their notes. Otherwise inspect providers/tools instead of guessing. Use harness-native worktree creation; Paseo workspace isolation is preferred when available. Fall back to repository worktree tooling, then standard `git worktree`.

For Paseo, create worktree workspace first, then agent inside it. Leave completion notifications enabled. Use follow-up prompts instead of polling. A worker needing another agent asks coordinator; every worker prompt explicitly forbids spawning subagents.

## Notifications and heartbeat

Prefer event-driven completion, permission, review, and PR notifications. Update user immediately for PR readiness, hard blockers, approval needs, merges, deployments, and material plan changes.

Use conversation as default status surface. Do not post recurring tracker comments, dashboards, or summaries unless user explicitly requests one. If requested, update one canonical summary in place and avoid comment spam; SQLite remains audit history.

When active workers lack reliable notifications, create one coordinator fallback heartbeat at configured interval, default 10 minutes. Each run performs bounded reconciliation, routes newly available work, updates durable state, and stays silent when nothing user-relevant changed. Do not busy-poll. Remove heartbeat when reliable notifications return, all work is idle, or initiative closes.

## Worker boundary

Worker sees task facts only: objective, context, paths/surfaces, dependencies, allowed actions, constraints, acceptance, checks, and deliverables. Do not mention coordinator database, schema, SQL, audit, normalization, hidden queues, or private policy implementation.

Workers return ordinary reports. Coordinator verifies available metadata, asks follow-up for missing evidence, and privately normalizes result.

## External workers

Manually started agents/worktrees are `external`: observe only. Never message, stop, edit, rebase, clean, or consume resources until user explicitly delegates management of named agent/task. When delegated, enable notifications and preserve unrelated external ownership.

## Adaptive scheduler

Defaults are configurable:

```json
{
  "max_active_workers": 6,
  "max_heavy_jobs": 1,
  "max_reviewers": 2,
  "max_workers_per_initiative": 3,
  "max_stack_depth": 4,
  "max_review_rounds": 3,
  "soft_time_budget_minutes": null,
  "fallback_heartbeat_minutes": 10
}
```

Classify light work as research/metadata/static inspection, medium as editing/focused checks, and heavy as browser/full CI/database/large build/deployment. Use resource leases for heavy work. Check host capacity and foreign workloads before granting lease. Use resources aggressively within hard ceilings. Never stop or clean foreign resources.

`soft_time_budget_minutes` is optional planning guidance. Crossing it emits a status update and invites coordinator replanning; it never stops work, weakens validation, consumes approval, or changes authority. Do not infer or record token/cost budgets.
