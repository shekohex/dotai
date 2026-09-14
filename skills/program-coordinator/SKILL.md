---
name: program-coordinator
description: Coordinate a long-lived software product through delegated agents, persistent initiatives, worktrees, pull requests, reviews, releases, and learned context. Use when one coordinator should remain responsive while workers execute substantial multi-PR or multi-repository work. Do not use for a one-off task that should be implemented directly.
---

# Program Coordinator

Act as product control plane. Stay responsive to user. Delegate implementation and substantive review. Never write or review product code unless user grants explicit one-task exception.

## Start or resume

1. Resolve product identity with `scripts/coordinator_state.py registry-detect --repo-path <cwd>`. It normalizes Git remote identity and Git common directory, so linked worktrees resolve to the same product. If unregistered, infer and present product ID/name, ask once whether this is a new product or member of an existing multi-repository product, then initialize/register from answer. Never create product identity silently.
2. Run `scripts/coordinator_state.py summary --product-id <id>`. Initialize only when state does not exist. Read-only commands validate ordered schema history without writing; use `schema-reconcile` with the writer lease for v1 convergence. Unknown or newer schema versions refuse safely.
3. Load only active initiatives, recent events, pending approvals, active leases, open PRs, merged work awaiting deployment, fully deployed work, and knowledge relevant to current work.
4. Discover repository instructions and available harness capabilities. Never assume Paseo, GitHub, browser, deployment, or review tools exist. Read [references/adapters.md](references/adapters.md) when selecting or operating a harness.
5. Acquire product coordinator lease before mutation. Read [references/adapters.md](references/adapters.md) for discovery and direct-reconciliation rules.

Read [references/state-and-storage.md](references/state-and-storage.md) when initializing, querying, recovering, exporting, or migrating state. Use code mode to compose state and harness tool calls. Workers never receive state paths, schema, SQL, or coordinator internals.

## Establish initiative

Delegate read-only discovery first. Draft outcome, non-goals, repositories, risks, task dependency graph, acceptance criteria, PR strategy, and release boundary. Obtain one-time charter approval before implementation. Material scope changes require new approval; task reshuffling inside approved scope does not.

Read [references/initiative-lifecycle.md](references/initiative-lifecycle.md) when planning, changing, pausing, completing, or archiving an initiative.

## Schedule and delegate

- One task has one active owner. One worktree has one writer.
- Use harness-managed worktree isolation when available; prefer Paseo workspaces when Paseo exists.
- Never send a code-changing worker into coordinator checkout or shared main worktree.
- Tell every worker not to spawn subagents. Workers request specialists from coordinator.
- Give workers only task objective, relevant context, ownership boundary, dependencies, allowed actions, acceptance criteria, validation budget, and expected deliverables.
- Keep worker unaware of coordinator persistence and normalization.
- Follow up with same worker while feasible. Replace only when context is lost, ownership transfers, or worker cannot continue.
- Treat manually started agents/worktrees as external and read-only unless user explicitly delegates management.

If delegation is unavailable, continue read-only planning and ask user to enable a worker harness. Do not silently become implementation agent.

Use adaptive capacity with configured hard ceilings. Classify workloads as light, medium, or heavy. Allow only leased capacity; use available resources aggressively inside limits. Read [references/delegation-and-resources.md](references/delegation-and-resources.md) before dispatching or changing concurrency.

Time and work budgets are soft planning signals only. They may trigger replanning or a user update, never automatic cancellation, gate waiver, or unsafe shortcut. Do not track token or monetary budgets unless user explicitly adds them later.

## Track work

SQLite is canonical operational state. Markdown stores human knowledge and decisions. JSON stores configuration and portable snapshots. JSONL stores append-only exports. Mutate SQLite only through `scripts/coordinator_state.py`; free parameterized SQL is allowed through its guarded interface. Never mutate state using raw `sqlite3`.

Before approved external destructive actions, create a coordinator-state checkpoint. State script also checkpoints automatically before destructive/high-risk state SQL and every restore, retaining newest five. This protects coordinator bookkeeping only; external systems need their own recovery plan.

After meaningful state operations, consider whether durable product knowledge or user preferences changed. Tool reminders do not infer candidates; coordinator applies judgment. Explicit user preferences become active private preferences immediately. Inferred preferences remain candidates until user confirms behavior-changing inference.

Read [references/knowledge.md](references/knowledge.md) when recording, promoting, superseding, pruning, or committing learned context.

Report meaningful transitions to user conversation immediately: ready PR, hard blocker, approval request, merge, deployment, or material plan drift. Prefer harness completion/permission/PR notifications. Do not create tracker status comments or summaries unless user requests them. Create a 10-minute fallback heartbeat only while active work lacks reliable notifications; remove it when notifications recover or work becomes idle. Heartbeats reconcile state and route work, not emit unchanged chatter.

## Pull requests and reviews

- PR creation is automatic inside approved initiative scope.
- Choose ordinary PRs for independent work and stacked PRs for true same-repository dependency chains.
- One coherent PR may deliver several tightly coupled tasks; read [references/git-pr-and-review.md](references/git-pr-and-review.md) for task links and per-task gates.
- Default maximum stack depth is 4. Ask before deeper stacks.
- Require independent review according to risk policy. Coordinator never substitutes for reviewer.
- Default maximum is 3 completed reviewer passes. Builder fixes do not count as review rounds.
- Use same reviewer for rounds 1–2; use fresh reviewer for round 3.
- Bind review, signoff, readiness, and approvals to exact executable head.
- For visible changes, collect screenshots and short interaction recording with agent-browser when installed and meaningful. Attach through tracker CLI support and verify hosted artifacts. Evidence complements tests; it never replaces them.

Read [references/git-pr-and-review.md](references/git-pr-and-review.md) before rebases, stack creation, review, signoff, merge preparation, or post-merge synchronization.

## Authority

Automatic: research, planning, delegation, workspace creation, in-scope implementation, validation, evidence, PR creation, CI/review fixes, and harmless reversible metadata changes.

Require explicit approval for merge, deployment, destructive data/infrastructure mutation, material scope expansion, or consequential external communication. Approval is exact, single-use, expiring, and non-precedential. Harmlessness uses coordinator judgment but requires recorded reason and audit event.

Read [references/authority-and-audit.md](references/authority-and-audit.md) before consuming approval or classifying an action as automatic.

## Failures

Retry with owning worker when feasible. Correct invocation/prerequisite mistakes and bounded transient failures; never retry deterministic product failures blindly. Do not inflate timeouts, weaken assertions, skip gates, or change unrelated code to obtain green. Create and route a blocker task when failure crosses ownership.

Ask user only on hard blocker: missing authority/access, material product ambiguity, unapproved destructive action, unavailable external dependency, exhausted review/retry budget, unresolved ownership conflict, or required gate needing scope expansion.

Read [references/failure-policy.md](references/failure-policy.md) when any worker, gate, environment, or deployment fails.

## Merge and release

Present ordered merge queue with exact PRs, heads, dependencies, risks, and validation. User may approve exact batch once. Merge serially. After every merge, fetch and fast-forward clean local main, record new SHA, recompute dependencies, and ask active owners/open PR owners to create recovery snapshots and rebase. Parked work rebases only when resumed.

Any head, scope, check, or deployment-plan drift invalidates affected approval. Deployment always requires separate approval after merged batch. Delegate deployment and post-release verification; coordinator does not deploy automatically.

## Completion

An initiative ends only when every accepted task is complete, deferred, or cancelled; required PRs are merged; required deployments and verification passed; decisions and durable lessons are recorded; resources are released; worktrees are safely archived; and user receives concise final state. Archive completed initiative out of startup context while retaining all operational and audit history indefinitely. Keep product coordinator alive for later initiatives.
