# Subagent Workflow

## Before You Start

1. Read `.agent/goal.md`.
2. Read `.agent/standards.md`.
3. Read assigned task block in `.agent/plans.md`.
4. Stay inside assigned file scope.

## Implementation Workflow

1. Audit current behavior against upstream command/workflow/tests/docs.
2. State current real parity gaps.
3. Write or adjust focused failing tests for selected gap.
4. Implement minimum fix.
5. Run focused tests.
6. Self-review diff for fake support, scope creep, and architecture drift.
7. Report changed files, tests run, remaining risks.

## Rules

- No scope creep.
- No new dependencies without justification.
- No commits unless explicitly requested by orchestrator.
- Prefer explicit unsupported errors over partial hidden behavior.
- Use exact prompt in review loop when requested: `Are you 100% confident in this strategy? If not, find all possible loopholes, suggest proper fixes and run this loop until you are factually 100% confident in the new startegy`
