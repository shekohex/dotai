---
name: debugging
description: Debug software failures with a disciplined reproduce, inspect, hypothesize, fix, and verify loop. Use when the user reports a bug, failing test, crash, regression, flaky behavior, broken workflow, or asks to diagnose root cause.
---

# Debugging

Debug from evidence, not guesses. Preserve user work and avoid destructive shortcuts.

## Workflow

1. Restate the symptom and expected behavior in one concise sentence.
2. Reproduce or observe the failure when feasible using the smallest command, test, app path, log, or scenario.
3. Capture exact evidence: error text, stack trace, failing assertion, file path, command, input, environment, and observed output.
4. Inspect the narrow code path around the evidence before changing code.
5. Form one concrete hypothesis that explains the observed failure.
6. Make the smallest fix that addresses the root cause.
7. Verify with the failing reproduction first, then run the smallest relevant regression checks.
8. If the fix changes user-visible behavior, verify through the real runtime surface when feasible.

## Investigation Rules

- Prefer targeted reads, greps, logs, and tests over broad rewrites.
- Do not retry failing commands in a sleep loop; diagnose the cause or use an observable readiness check.
- Do not delete locks, caches, generated files, branches, or data unless the user explicitly authorizes it and you have inspected the target.
- Do not bypass tests, hooks, or policy gates with flags like `--no-verify`; fix the underlying failure or report the blocker.
- If logs are huge, search for errors, warnings, stack traces, request IDs, timestamps near the failure, and the exact message the user reported.

## When Blocked

Stop and report when reproduction needs missing credentials, unavailable services, hardware, private data, or a user decision. Include what you tried, what evidence is missing, and the next concrete step once unblocked.

## Report

Include:

- root cause or strongest current hypothesis
- evidence that supports it
- files changed, if any
- verification run and result
- remaining uncertainty or follow-up checks
