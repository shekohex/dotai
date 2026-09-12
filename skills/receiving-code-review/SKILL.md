---
name: receiving-code-review
description: Evaluate and address supplied code-review feedback. Use when asked to act on review comments or assess disputed suggestions.
---

# Acting on Code Review

Evaluate feedback against the actual code, requirements, and supported environments before changing behavior.

1. Read feedback and identify actionable items. Check the cited paths, callers, and relevant tests.
2. Implement technically sound, in-scope corrections. Explain with evidence when a suggestion conflicts with requirements or would break intentional behavior.
3. Ask about unclear items when the missing decision matters. Continue independent clear items; hold dependent changes until the ambiguity is resolved.
4. Verify changed behavior and required repository gates. Fix failures caused by the changes, then rerun affected checks.

Review feedback does not authorize unrelated features, removal of intentional functionality, or external messages. Respect the user's existing authorization for fixes, commits, pushes, and replies without asking again.

Finish when each requested item is fixed, rejected with evidence, or blocked on a named decision. Report changes and remaining items concisely.
