---
name: verification-before-completion
description: Check completion claims against current evidence when asked to audit verification or when an active workflow requires this gate.
---

# Verification Before Completion

Match each completion claim to observed evidence for the current artifact.

| Claim | Evidence |
| --- | --- |
| Tests pass | Completed test command, exit status, and passing summary |
| Build succeeds | Successful build for the affected target |
| Bug fixed | Original symptom reproduced before the fix and absent afterward |
| Requirements met | Requested behavior or artifact checked against acceptance criteria |
| Delegated work complete | Inspected changes and relevant validation, beyond agent's report |

Use the smallest check that establishes the claim, plus repository-required gates. A targeted test establishes that behavior; it does not establish that the full suite passes.

Reuse results from this session while the checked code, inputs, and environment remain unchanged. Rerun affected checks after changes or when new evidence makes the result uncertain; do not rerun solely because another message or checklist asks for completion evidence.

Fix in-scope failures and continue through validation without repeated permission requests. If a check is unavailable or blocked, report what was checked, what remains unverified, and the concrete blocker. Do not label unrun checks as passing.

Stop once acceptance criteria and required checks pass. Report concise results and material limits.
