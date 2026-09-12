---
name: long-running-agent
description: Manage autonomous multi-milestone project development across sessions. Use for whole-project builds, not a single end-to-end feature.
---

# Long-Running Agent Orchestrator

Deliver a multi-milestone project with persistent state, isolated implementation tasks, and review at milestone boundaries.

## Establish the project

Use the conversation and repository to identify outcome, constraints, non-goals, and acceptance criteria. Ask about unresolved choices that materially affect delivery; do not repeat an interview already completed.

Maintain the existing `.agent/` files:

- `goal.md`: outcome, constraints, and completion criteria.
- `plans.md`: milestones, tasks, dependencies, and verification.
- `standards.md`: project-specific implementation constraints.
- `implement.md`: worker instructions and authorized operations.
- `progress.md`: completed work, current milestone, decisions, evidence, and blockers.

Read [references/project-templates.md](references/project-templates.md) when creating these files. Adapt templates to actual project needs and preserve existing state. Present a new or materially changed plan for sign-off; an already approved plan needs no repeated approval.

## Execute milestones

1. Read current state when starting or resuming a milestone, or when another worker may have changed it. Reuse unchanged context between routine actions.
2. Identify independent tasks and dependency order. Delegate substantial independent implementation in separate worktrees using the host's available tools and limits. Handle trivial or tightly coupled work locally when more efficient.
3. Give workers the relevant task, standards, architecture context, allowed paths and actions, verification, and return contract. Commits and branch integration must follow the user's existing authorization.
4. Inspect worker diffs and checks. Integrate onto the agreed branch after verification; do not assume direct merges to main are authorized.
5. Arrange architectural review of the milestone against its requirements and standards. Resolve confirmed blockers and verify changes. Re-review when corrections affect the prior assessment.
6. Update progress at meaningful state transitions: task integration, review outcome, changed decision, or blocker. Record enough evidence and remaining work to resume without rediscovery.

When review stops converging, investigate why. Do not declare success or defer critical requirements merely because a fixed number of iterations elapsed. Resolve routine tradeoffs from evidence; ask when new scope, access, or a consequential user decision is required. Continue independent authorized tasks meanwhile.

## Completion

Review the integrated project against the original scope and acceptance criteria. Run required checks and exercise requested end-to-end flows. Fix in-scope failures, rerun affected checks, and update final progress with results and any real limitations.

Stop when all agreed milestones and completion criteria are satisfied, the user stops the task, or a concrete blocker prevents further authorized progress. Report completed work and any remaining blocker; do not promise unattended execution beyond the host's capabilities.
