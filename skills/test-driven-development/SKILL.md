---
name: test-driven-development
description: Apply red-green-refactor when test-first behavior changes are requested or required by repository guidance.
---

# Test-Driven Development

Use red-green-refactor for requested or repository-required test-first behavior changes. For the broader integration-test workflow, use [tdd](../tdd/SKILL.md); do not load both by default.

1. **Red:** write a focused test for an observable requirement, run it, and confirm it fails for the missing behavior or reported bug. Fix setup errors before treating failure as evidence.
2. **Green:** implement the smallest change that satisfies the requirement, then run the test and affected checks.
3. **Refactor:** improve only code involved in the change, keeping tests green. Repeat for remaining behaviors.

Test public behavior rather than every helper or mock interaction. Use real collaborators where practical; isolate external side effects at appropriate boundaries. For concrete mocking pitfalls, consult [testing-anti-patterns](../testing-anti-patterns/SKILL.md) only when needed.

If implementation already exists, preserve user work. Demonstrate the regression against the pre-fix state in an isolated copy or by a narrowly reversible change to your own patch; restore it afterward. Do not delete working code to reenact test-first history, or claim tests were written first when they were not.

Documentation-only edits and generated artifacts need checks appropriate to their output unless the repository requires otherwise. Do not invent unit tests that merely mirror text or implementation.

Done means requested behavior is covered, the test's failure signal was demonstrated, and affected plus required checks pass. Report any limits to that evidence.
