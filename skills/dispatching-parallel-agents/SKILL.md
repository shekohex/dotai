---
name: dispatching-parallel-agents
description: Delegate independent failure investigations to parallel agents when work can be isolated without shared-state conflicts.
---

# Dispatching Parallel Agents

Parallelize investigations only when domains are independent and available agents can work without shared-state conflicts.

- First group failures by likely cause; several failing tests may share one cause.
- Give each agent a bounded task, relevant failures and files, allowed edits, verification criteria, and a return contract covering cause, changes, checks, and blockers.
- Assign disjoint files or isolated worktrees for concurrent edits. Keep dependent work sequential and coordinate any newly discovered overlap.
- Use available delegation tools and concurrency limits. Do useful independent work locally while agents run.
- Inspect returned diffs and evidence, resolve conflicts, and run affected integration checks plus repository-required gates.

Do not increase timeouts or weaken test assertions merely to make a failure disappear. Confirm whether changed behavior or faulty implementation explains each expectation.

Finish when all assigned domains are resolved and integrated, or report specific unresolved blockers. Agent reports alone do not prove integration succeeds.
