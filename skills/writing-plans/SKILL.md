---
name: writing-plans
description: Write an implementation plan from an established design when a plan or engineering handoff is requested.
---

# Writing Implementation Plans

Produce an executable plan from an established design. Preserve the user's requested level of detail and output location; otherwise use `docs/plans/YYYY-MM-DD-<feature-name>.md` when a saved artifact is useful.

Include:

- Goal, scope, and observable completion criteria.
- Relevant architecture decisions and dependencies.
- Tasks in dependency order, with concrete file paths or symbols and expected behavior.
- Verification for each meaningful behavior change and required final checks.
- Unresolved decisions or approval boundaries that affect execution.

Size tasks around independently verifiable outcomes. Include exact commands and code examples where they prevent ambiguity; do not prewrite the entire implementation, prescribe minutes per step, or add a commit after every action.

Use repository conventions for tests and worktrees. A planning request alone does not require a new worktree, subagents, or commits.

Completion means another engineer can execute the plan without rediscovering key decisions. If the user asked for planning only, return the plan. If they also requested implementation, continue once material decisions are resolved, honoring any explicit review checkpoint.
