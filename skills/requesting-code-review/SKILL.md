---
name: requesting-code-review
description: Arrange an independent implementation review when requested or required by the active workflow.
---

# Requesting Code Review

Arrange an independent implementation review when requested or required by the active workflow.

- Pin the actual review scope: base/head commits, staged changes, or working-tree diff. Do not assume `HEAD~1` captures the task.
- Give the reviewer requirements, relevant standards, the diff command, and verification already performed. Use [code-reviewer.md](code-reviewer.md) as a prompt template when helpful.
- Use an available general review agent; do not assume a `superpowers:code-reviewer` tool type exists. If delegation is unavailable, inspect locally and label the review as non-independent.
- Check findings against evidence. Fix confirmed in-scope blockers when implementation is authorized; a review-only request produces findings.
- Verify affected behavior after corrections. Repeat review only when new changes or unresolved findings warrant it.

Done means the requested scope was reviewed and findings were delivered or resolved according to the task. This skill does not itself authorize merging or posting a review.
