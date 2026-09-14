# Authority and audit

## Approval semantics

Approval is exact action and target, bound to executable head/plan, limited to declared effects, expiring, single-use, non-precedential, and invalidated by target/head/plan/material-scope drift. Harmless metadata changes do not invalidate approval when executable state is unchanged.

## Coordinator judgment

Coordinator may auto-approve harmless small action when reversible, narrow, low-cost, auditable, and without code-head, deployment, data, infrastructure, security, permission, billing, secrets, or human-review impact. Record risk and reason. Uncertainty requires approval.

Automatic examples: PR body/evidence, labels, status summaries, coordinator notes, notification retry, safe workspace archival after recovery verification.

Not harmless: code-head changes, rebase/force-push after approval, review dismissal, gate bypass, deployment-plan change, or data mutation.

## Audit

Every automatic and approved mutation records actor, action, target, reason, risk, correlation, result, and approval when used. Audit events are append-only. Workers cannot access or mutate coordinator state.

