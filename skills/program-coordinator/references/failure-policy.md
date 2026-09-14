# Failure policy

Classify before retrying:

- Invocation mistake: correct, maximum 2 corrections.
- Missing prerequisite/build artifact: satisfy, maximum 2.
- Capacity contention: release owned resources and requeue.
- Known transient infrastructure failure: maximum 2 bounded retries with backoff.
- Suspected flaky test: one isolated unchanged retry; retain both results.
- Deterministic product/test failure: zero blind retries; diagnose and route blocker.
- Permission or scope expansion: stop and ask.

Follow up with owning worker while feasible. Same unresolved blocker after 3 coordinator cycles becomes hard blocker.

Never increase timeout, weaken assertion, skip data/gate, hide failure, or edit unrelated ownership merely to obtain green. Canonical workflow must pass; custom successful path does not prove release readiness.

Hard blockers are missing authority/access, material product ambiguity, unapproved destructive action, unavailable external dependency, exhausted review/retry budget, unresolved ownership conflict, or required gate needing scope expansion.

Report failure chain, evidence, owner, attempted bounded recovery, remaining options, and exact requested user decision.

