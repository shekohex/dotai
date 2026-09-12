---
name: systematic-debugging
description: Investigate persistent failures with unclear causes using evidence-backed hypotheses and regression checks.
---

# Systematic Debugging

Use this framework when failures persist or the cause is unclear. For constructing a reproduction harness, consult [diagnosing-bugs](../diagnosing-bugs/SKILL.md); do not load both workflows automatically.

## Investigate

Capture the exact symptom and relevant error output. Reproduce with the smallest useful test or invocation, inspect the failing path and recent changes, and distinguish the reported bug from setup failures.

For multi-component failures, inspect the boundary where evidence goes missing. Add temporary instrumentation only where it can distinguish hypotheses. Log sanitized values or presence indicators, not credentials or entire environments.

For an error deep in a call chain, use [root-cause-tracing](../root-cause-tracing/SKILL.md) when backward tracing is needed.

## Explain and test

Compare relevant working behavior, state one evidence-backed hypothesis, and test it with a small discriminating change. Do not stack speculative fixes. Code inspection can help construct the reproduction; label hypotheses separately from confirmed causes.

If attempts stop producing new evidence, reassess assumptions and the reproduction before trying more edits. Ask for help when missing access, inputs, or a scope-changing architecture decision prevents progress, not after an arbitrary number of attempts.

## Fix and verify

Add a regression test that fails on the original symptom before fixing it. Correct the source of the failure, remove temporary instrumentation you added, and run the regression plus affected and required checks. Continue correcting in-scope failures.

If the failure cannot be reproduced, report what evidence exists and what is missing. Do not call an unverified hypothesis a fix, or add retries and monitoring without evidence they address the requirement.

Done means the original symptom is resolved with supporting evidence, or a concrete blocker and the needed next input are identified.
