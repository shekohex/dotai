---
name: subagent-driven-development
description: Execute a plan using implementation agents and review between tasks. Use when delegated development in the current session is requested.
---

# Subagent-Driven Development

Execute an implementation plan through bounded agent tasks and independent review in the current session.

1. Read the plan, track its acceptance criteria, and identify dependencies. Use the existing plan; do not require a particular authoring skill.
2. Give an implementation agent the relevant task, paths, constraints, checks, and required return data. Keep overlapping edits sequential. Use available delegation tools rather than assuming named host-specific agent types.
3. Inspect the returned diff and evidence. Arrange review of each meaningful completed task using [requesting-code-review](../requesting-code-review/SKILL.md), providing the actual task diff and requirements.
4. Resolve confirmed blocking findings, verify affected behavior, and continue through remaining tasks. Follow up with the same agent when its context helps; use a fresh agent for an independent task or review. Local correction is appropriate when delegation adds no value.
5. Review the integrated result against the full plan and run required checks. Repeat only for new changes or unresolved findings.

Tell agents whether commits are authorized; do not silently include commit or publish steps. Preserve requested review checkpoints without inventing approval pauses between tasks.

Completion means the plan is implemented, reviewed, and verified, or remaining blockers are concrete. Do not depend on an unavailable branch-finishing skill to report completion.
