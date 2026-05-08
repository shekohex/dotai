# Agent Contracts

Use for `/gsd execute-phase` orchestrator and delegated executor/verifier workers.

Principles:

- orchestrator owns sequencing, gating, merge bookkeeping, and final state transitions
- executor owns single-plan task execution via `workflows/execute-plan.md`
- verifier owns post-execution truth checking against phase goal
- workers return structured status; orchestrator never infers completion from silence alone

Executor contract:

1. Read only required plan/context files plus explicit bundle references.
2. Return plan id, status, summary path, commit hashes, checkpoint payloads, and pending UAT items.
3. If checkpoint hit, return structured continuation state instead of pretending plan completed.
4. If worktree path safety fails, stop and report reason explicitly.

Verifier contract:

1. Consume merged tree state, summaries, phase goal, and pending UAT/checkpoint context.
2. Return pass/fail plus evidence, blockers, warnings, and outstanding human validation.
3. Failed verification blocks `phase.complete`.

Orchestrator contract:

1. Never skip lower-wave safety.
2. Never promote partial-wave run into verification/completion path.
3. Never mark plan or phase complete only because worker exited cleanly.
4. Use summary/UAT/checkpoint artifacts for completion-signal spot-check fallback when worker output is ambiguous.
