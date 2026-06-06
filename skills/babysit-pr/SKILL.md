---
name: babysit-pr
description: Babysit a GitHub pull request after creation by waiting for compact PR events, handling CI/review blockers, retrying likely flaky failures, and continuing until the PR is ready, merged, closed, or blocked on user help. Use when the user asks to monitor, watch, babysit, keep an eye on, handle PR CI, or respond to PR review feedback.
---

# PR Babysitter

## Objective
Monitor one PR until exactly one terminal outcome happens:

- PR is merged or closed.
- PR is ready to merge: CI green, review feedback handled, required approval not blocking, no merge conflict risk.
- User help is required: permissions/auth failure, exhausted flaky retries, ambiguous review request, unsafe local state.

## Quick Start

```bash
python3 <skill-dir>/scripts/gh_pr_watch.py --pr auto --watch
```

`--watch` is agent-first: it blocks silently, emits one compact JSON event, then exits. Reuse the returned `cursor` on the next invocation; no state file is needed.

```bash
python3 <skill-dir>/scripts/gh_pr_watch.py --pr auto --watch --cursor '<cursor>'
```

## Agent Loop

1. Run `--watch` with the latest cursor, if any.
2. Read the single JSON event.
3. Act on `actions` and `event`.
4. After any fix, commit, push, or retry, run `--watch` again with returned cursor.
5. Stop only on terminal event or user-help blocker.

## Event Handling

| Event | Action |
| --- | --- |
| `review_feedback` | Inspect `review_items`; patch only correct/actionable feedback. |
| `ci_failed` | Inspect `failed_runs`/`failed_checks`; diagnose logs before retry/fix. |
| `sha_changed` | Note new SHA; continue watching with cursor. |
| `mergeability_changed` | Re-check merge conflict/review state; continue or stop if blocked. |
| `ci_green` | Report concise progress; keep watching for review/mergeability changes. |
| `heartbeat` | No useful change before max wait; continue watching with cursor. |
| `ready` | Final success summary; stop. |
| `closed` | Final closed/merged summary; stop. |
| `blocked` | Explain blocker; stop and ask user. |

Retry flaky failures only when `actions` includes `retry_failed_checks`:

```bash
python3 <skill-dir>/scripts/gh_pr_watch.py --pr auto --retry-failed-now --cursor '<cursor>'
```

## CI Failure Rules

- Treat compile/typecheck/lint/test failures in touched areas as branch-related; fix, commit, push.
- Treat runner/network/registry/GitHub infra failures as likely flaky; retry only when watcher allows it.
- If ambiguous, inspect logs once before deciding.

Commands:

```bash
gh run view <run-id> --json jobs,name,workflowName,conclusion,status,url,headSha
gh run view <run-id> --log-failed
```

## Review Rules

- Watcher surfaces trusted human/bot review activity once per cursor.
- Address only technically correct, actionable feedback that fits user intent.
- If feedback is ambiguous, product-level, or conflicts with instructions, stop and ask.

## Git Safety

- Work only on the PR head branch.
- Before edits, stop if unrelated uncommitted changes exist.
- Avoid destructive git commands and unnecessary branch switches.
- After each fix: commit, push, then resume `--watch` with cursor.

## Final Summary

Include PR SHA, CI summary, mergeability/review state, fixes pushed, retry cycles used, and remaining blockers.

## References

- Event schema: `./references/watcher-events.md`
- CI/review heuristics: `./references/heuristics.md`
- GitHub CLI/API notes: `./references/github-api-notes.md`
