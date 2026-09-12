---
name: executing-plans
description: Execute an existing implementation plan through verification. Honor review checkpoints explicitly requested by the user or plan.
---

# Executing Plans

Carry an approved or user-supplied implementation plan through its acceptance criteria.

1. Read the plan and relevant repository guidance. Check dependencies, intended outcome, verification steps, and any explicit review checkpoints.
2. Resolve routine details from code and context. Ask only about gaps that change scope, correctness, or authorization; continue independent tasks meanwhile.
3. Execute in dependency order. Track meaningful tasks, adapt stale mechanics to current APIs, and preserve the intended behavior.
4. Run affected checks and required repository gates. Diagnose and fix in-scope failures, then rerun affected checks.
5. Report progress at useful milestones and continue until all authorized tasks are complete. Pause between batches only when the user or plan explicitly requires review there.

When a blocker cannot be resolved within scope, report the exact missing input or access and work already completed. A failed test is evidence to investigate, not an automatic handoff.

Done means plan requirements are implemented and verified, with remaining limitations identified. Commits, publishing, and deployment follow existing authorization; executing a plan does not independently authorize them.
