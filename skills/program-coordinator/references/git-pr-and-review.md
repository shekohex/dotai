# Git, pull requests, and review

## Worktrees and recovery

Code-changing workers use isolated worktrees. Before moving dirty/staged branch, owner creates immutable recovery object covering tracked, staged, and untracked work and reports identifier. Do not identify recovery solely by moving stash index.

After each merge:

1. Fetch remote and fast-forward clean local main to remote main. Never rebase shared main.
2. Record exact main SHA and recompute dependency/overlap graph.
3. Prompt active workers and open PR owners to snapshot and rebase onto new main.
4. Owner resolves own semantic conflicts and revalidates affected behavior.
5. Parked/unstarted work rebases on resume, not every merge.
6. Lease-protected force-push only after applicable gates.

Generated conflicts resolve from authoritative source and regenerate outputs. Never choose entire generated side without source-intent audit.

## Ordinary versus stacked PRs

One coherent PR may deliver several tightly coupled tasks. Record every task-to-PR association in `pull_request_tasks` while retaining the legacy `pull_requests.task_id` value for existing consumers. `pull-request-upsert --task-ids-json` treats supplied IDs as the complete set and replaces stale links atomically; omit it to preserve existing links. Keep review, signoff, and completion evidence per task; one PR merge does not collapse task gates.

Use ordinary PRs for independent changes. Use stack only when later same-repository change truly depends on unmerged lower layer and each layer remains independently reviewable/revertible.

GitHub stacked PRs require GitHub CLI 2.90+ and Git 2.20+. Install only with user permission:

```bash
gh extension install github/gh-stack
gh skill install github/gh-stack
```

Useful flow:

```bash
gh stack init
gh stack add BRANCH-NAME
gh stack push
gh stack submit
gh stack view
```

Default maximum depth: 4. Deeper stack requires approval. Same repository only. Feature is public preview; detect capability and fall back to ordinary PRs.

- https://docs.github.com/en/pull-requests/get-started/about-stacked-prs
- https://docs.github.com/en/pull-requests/get-started/stacked-prs-quickstart

## Independent review

Coordinator never performs substantive review. Required review uses separate agent and exact base/head plus charter/spec, standards, risk, and prior validation.

- Review pass increments only when reviewer completes assessment.
- Builder fixes/follow-ups do not consume review pass.
- Round 1: independent reviewer.
- Round 2: same reviewer verifies fixes and regressions.
- Round 3: fresh reviewer.
- Default maximum: 3. Unresolved findings then become hard blocker requiring user decision.

Reviewer never edits builder branch. Builder owns fixes. Any head change invalidates head-bound readiness and requires affected verification.

## PR evidence

For user-visible changes, require evidence proportional to behavior:

- screenshots for representative stable states, including relevant responsive, theme, locale, and error states;
- short agent-browser recording when interaction or transition matters and CLI is installed;
- test/log/trace evidence for non-visual contracts.

Attach through `gh pr create --attach` or `gh pr edit --attach`; use corresponding `gh issue create/edit --attach` commands for issue evidence. Store hosted URL, media type, hash, provenance, and verification status. Verify hosted response and rendered remote PR/issue body. Never claim a local artifact as published evidence. Document why video is unsuitable when intentionally omitted.

Keep screenshots, recordings, traces, and ad-hoc evidence outside Git. GitHub issue/PR attachments are durable published record; SQLite stores their URLs and hashes. Retain local copies through merge and required deployment verification, then remove them unless needed for active diagnosis or user-requested retention. Commit media only when repository test contract requires it, such as approved visual-regression baselines or fixtures.

## Merge batching

Present exact ordered queue: PR, head, dependencies, risks, gates, review outcome. One approval may cover exact batch. Merge serially. Stop affected remainder on drift or failed post-merge rebase/check. Deployment approval is always separate.
