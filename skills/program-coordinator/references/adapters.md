# Harness adapters

Coordinator discovers capabilities at runtime. Core policy remains harness-neutral.

## Paseo

When Paseo exists:

1. List configured profiles and read every profile note before agent selection.
2. Create worktree-isolated workspace before code-changing agent.
3. Create worker in that workspace with completion notification enabled.
4. Use follow-up prompt for feasible retries, review fixes, rebase, and feedback.
5. Do not poll running agents; consume completion and permission notifications.
6. Use heartbeat only when no event subscription can wake coordinator.
7. Archive agent/workspace only after merge and recovery verification.

For external agent delegated by user, message named agent through Paseo and enable notification. This grants no authority over unrelated worktree resources.

## Generic harness

Prefer native worktree/session APIs. Otherwise use repository worktree script. Standard Git worktree is final fallback. Record workspace path, branch, base, owner, external status, and recovery reference.

If harness lacks delegation, coordinator stops before implementation. It may still research, plan, inspect metadata, and prepare charter.

## GitHub

Use GitHub events/webhooks when available for PR open/update/review/check/merge changes. Otherwise use bounded PR babysitting, not busy polling. Detect stacked-PR support before use. PR attachments, comments, labels, and bodies remain GitHub artifacts; coordinator stores URLs and hashes.

Do not create GitHub status comments or project-summary comments by default. Use them only when user requests a tracker-visible summary; then edit one canonical item instead of appending repeated updates.

Attach evidence with GitHub CLI using `gh pr create --attach`, `gh pr edit --attach`, `gh issue create --attach`, or `gh issue edit --attach` as appropriate. Verify every returned hosted URL and remote rendered body; a local path or successful upload command alone is not published evidence.

## Browser evidence

Detect `agent-browser` before planning browser evidence. When installed, use its screenshot and recording features for visual/interactive PRs. Record short, focused interaction videos only when motion, state transition, navigation, focus, responsiveness, or workflow behavior benefits from demonstration. Pair with representative screenshots for stable visual states.

Skip video for backend-only changes, invisible infrastructure, or long static waits; record reason in PR evidence. Recorder absence does not block non-visual work. Browser evidence never substitutes for behavior tests or required validation.

## Code mode

Prefer code mode for composing state queries with harness calls. Keep state mutation behind coordinator_state.py; do not expose SQL to workers. Parse JSON output, act, then persist result and correlation ID.
