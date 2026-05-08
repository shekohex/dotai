# Project File Templates

Templates for `.agent/` project files. Customize to your project's tech stack and patterns.

## goal.md

```markdown
# Project Goal

## Problem Statement
[What problem are we solving? Why does it matter?]

## Desired Outcome
[What does the finished product look like? Be specific.]

## Acceptance Criteria
- [ ] [Criterion 1 — measurable, verifiable]
- [ ] [Criterion 2]
- [ ] [Criterion 3]

## Non-Goals
- [Thing we are explicitly NOT building]
- [Scope boundary we will not cross]

## Constraints
- [Technical constraint: language, framework, deployment target]
- [Business constraint: timeline, compatibility, licensing]

## Tech Stack
- Language: [e.g., TypeScript]
- Framework: [e.g., Next.js 14]
- Database: [e.g., PostgreSQL]
- Other: [e.g., Redis, Docker]
```

## plans.md

```markdown
# Project Plan

## Architecture Overview
[High-level description of the system. Components, data flow, key boundaries.]

## Milestones

### Milestone 1: [Name]
**Goal:** [What this milestone delivers]
**Depends on:** None

#### Tasks

##### Task 1.1: [Name]
- **Parallel:** yes/no
- **Files:** [src/auth/*, src/middleware/auth.ts]
- **Approach:** [How to implement — specific enough for a subagent]
- **Tests:** [What to test — happy path, error cases, edge cases]
- **Acceptance criteria:** [When is this task done?]
- **Status:** pending

##### Task 1.2: [Name]
- **Parallel:** yes (with 1.1) / no (depends on 1.1)
- **Files:** [...]
- **Approach:** [...]
- **Tests:** [...]
- **Acceptance criteria:** [...]
- **Status:** pending

### Milestone 2: [Name]
**Goal:** [...]
**Depends on:** Milestone 1

#### Tasks
[Same structure as above]
```

## standards.md

```markdown
# Project Standards

These standards define the quality bar. Every line of code must meet them.
Subagents: read this file before writing any code.

## Code Quality

Write code that a senior staff engineer would be proud of. Not "good enough" — exceptional.

- Names reveal intent. If you need a comment to explain what something does, rename it.
- Functions do one thing. If you're describing what a function does with "and", split it.
- Error handling is explicit. No swallowed errors, no empty catch blocks.
- No type safety escape hatches (`as any`, `@ts-ignore`, `@ts-expect-error`).

## Testing

- Write tests first (TDD). Test describes behavior, not implementation.
- Every public API has tests. Every error path has tests.
- Tests are independent — no shared mutable state, no order dependence.
- Assertions are specific. `toBe(expected)` not `toBeTruthy()`.

## Architecture

- Dependencies flow inward. Core logic never imports from infrastructure.
- Interfaces at boundaries. Concrete implementations behind abstractions at system edges.
- No premature abstraction. Three concrete uses before extracting a pattern.
- Configuration is explicit. No magic strings, no implicit defaults.

## Git

- Each commit is a single logical change that compiles and passes tests.
- Commit messages explain WHY, not WHAT. The diff shows what changed.
- No merge commits in feature work. Rebase onto main.
```

## implement.md

```markdown
# Subagent Workflow

You are a subagent implementing a specific task. Follow this workflow exactly.

## Before You Start

1. Read `.agent/goal.md` — understand the project's purpose
2. Read `.agent/standards.md` — understand the quality bar
3. Read your task description carefully — understand exactly what to build
4. If anything is unclear, state your assumptions in your report

## Implementation Workflow

1. **Design:** Think through the approach before writing code. Identify edge cases.
2. **Test first:** Write a failing test for the first behavior.
3. **Implement:** Write minimal code to pass the test.
4. **Refactor:** Clean up while tests pass.
5. **Repeat:** Next behavior, next test, next implementation.
6. **Verify:** Run full test suite. Run linter. Run type checker. All must pass.
7. **Commit:** One commit per logical change. Message explains why.
8. **Self-review:** Read your own diff. Would you approve this in code review?

## Rules

- **No scope creep.** Build exactly what the task specifies. Nothing more.
- **No new dependencies** without documenting justification in your report.
- **Stay in your worktree.** Do not modify files outside your task scope.
- **No shortcuts.** No `// TODO`, no `any`, no skipped tests, no "fix later".
- **Ask rather than assume.** If a requirement is ambiguous, state your assumption explicitly.

## Report Format

When done, report:
- What you implemented (brief summary)
- Test results (passing count, any notable coverage)
- Files changed (list)
- Assumptions made (if any)
- Concerns or risks (if any)
```

## progress.md

```markdown
# Project Progress

## Current Status
**Phase:** Setup / Milestone N / Complete
**Current milestone:** [name]
**Current task:** [name or "between tasks"]
**Last action:** [what just happened]

## Completed Milestones

### Milestone 1: [Name] — COMPLETE
- Tasks completed: [list]
- Review iterations: [N]
- Deferred items: [any issues punted]

## Current Milestone: [Name]

### Task Status
| Task | Status | Subagent | Notes |
|------|--------|----------|-------|
| [Task name] | pending/in_progress/complete/failed | [agent_id] | [notes] |

### Review Feedback
[Latest reviewer feedback, if in review cycle]

## Decisions Log

### Decision: [topic]
- Options considered: [A, B, C]
- Chose: [B]
- Rationale: [why]
- Trade-offs accepted: [what you gave up]

## Architecture State

### Components
- [Component]: [purpose, key files]

### Connections
- [Component A] → [Component B]: [how they communicate]

### Patterns Established
- [Pattern]: [where used, why chosen]

### Known Issues
- [Issue]: [severity, plan to address]
```
