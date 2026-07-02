---
name: creating-pull-requests
description: Create GitHub pull requests with `gh` in the user's concise, emoji-free style. Use this whenever the user asks to create, open, publish, or send a PR or pull request, including phrases like "create a new PR", "create a new pull request", "open a PR", "publish this branch", or "create a draft PR". Infer the upstream repo and base branch automatically, inspect the last 5-7 authored PRs and issues to mirror tone and structure, verify relevant local quality checks before opening, prefer any repo-provided PR template when present, and produce a brief high-signal PR with validation, review guidance, optional demo notes, optional Mermaid diagrams, and closing issue references when relevant.
---

# Creating Pull Requests

Open GitHub pull requests with `gh` in the author's style. Write like the author already writes. Stay brief. Skip fluff.

## Goal

Create a PR that is ready for review, uses the correct repo and base branch, reflects the author's writing style, and includes only the context reviewers actually need.

## Use This Skill When

- The user asks to create, open, publish, or send a PR or pull request
- The user asks for a draft PR or signals the work is not ready to merge
- The branch is done and opening a PR is the next obvious step

## Non-Negotiables

- Use `gh` for GitHub operations
- Be concise and direct
- Do not use emojis
- Do not open a PR until the branch is pushed and relevant local checks are done or a clear blocker is reported
- Do not depend on `gh pr create --fill` unless the repo template makes that the cleanest option
- Return the PR URL after creation
- When no repo template exists, prefer a problem-first PR body: problem, rationale, user impact, evidence, and focused visual/demo proof when useful

## Core Workflow

1. Inspect branch state and confirm there is real work to propose.
2. Check whether a PR already exists for the current branch. Do not create duplicates.
3. Infer the target repo, remote, and base branch automatically.
4. Look for a repo-provided PR template. Use it when present.
5. Inspect the last 5-7 PRs and issues authored by the user and mirror the style.
6. Identify and run the most relevant local quality checks for this repo.
7. If checks fail, fix in-scope issues when reasonable. Otherwise stop and report the blocker instead of opening the PR.
8. Push the branch if needed.
9. Draft a concise PR title and body with problem, impact, and evidence clear enough for async review.
10. Create the PR with `gh pr create`, adding `--draft` when appropriate.
11. Verify the created PR and return the URL with a short status note.

## Infer Repo and Base Branch

Prefer signals in this order:

1. Explicit user instruction
2. Current branch upstream tracking info
3. `origin`
4. `upstream`
5. Repo default branch from `gh repo view`

Useful checks:

```bash
git branch --show-current
git rev-parse --abbrev-ref --symbolic-full-name @{u}
gh repo view --json nameWithOwner,defaultBranchRef
gh pr status
```

If the branch has no upstream yet, push with `git push -u <remote> HEAD` before creating the PR.

## Prefer Repo Templates First

Before drafting the PR body, check whether the repo already defines a PR template. Prefer the repo's template over any bundled example in this skill.

Common locations:

- `.github/pull_request_template.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `.github/PULL_REQUEST_TEMPLATE/*.md`
- `docs/pull_request_template.md`

Rules:

- If the repo has a PR template, use it as the starting structure
- If the repo has multiple templates, pick the closest match to the change
- If the template is noisy, still keep the final prose concise
- If the repo has no template, use `./references/pr-template.md` as a fallback example only

`./references/pr-template.md` is guidance, not a rigid schema.

## Mine the Author's Style

Before writing the PR, inspect recent authored examples. Prefer the same repo first. Broaden only if needed.

Useful commands:

```bash
gh pr list --author "@me" --limit 7 --state all --json number,title,body,url
gh issue list --author "@me" --limit 7 --state all --json number,title,body,url
```

If repo-local history is sparse, use broader search with `gh search prs` or `gh search issues`.

Match the author's habits:

- title length and casing
- summary level and abstraction
- section names that actually recur
- bullet density
- closing reference style such as `Fixes`, `Closes`, or `Refs`

Do not imitate exact sentences. Capture tone, brevity, and structure.

## Verify Quality Before Opening

Check the repo for authoritative local commands before guessing. Prefer the narrowest command that best matches the normal review gate.

Look for signals in:

- `package.json`
- `justfile`
- `Makefile`
- `pyproject.toml`
- `Cargo.toml`
- `go.mod`
- `.github/workflows/`

Preferred order:

1. A single repo gate such as `just ci`, `make ci`, or equivalent
2. Targeted lint, typecheck, and tests for touched areas
3. Build step when the repo treats build success as part of the review gate

Rules:

- Run tests when they exist and are relevant
- Run lint and typecheck when the repo uses them
- If new tests were added or a demo path changed, mention that tests were run and no issues found when true
- If some CI checks cannot be reproduced locally, run the closest local equivalent and say so in the PR body
- Never claim validation that did not happen

## Decide Draft vs Ready

Create a draft PR when any of these are true:

- The user explicitly says `draft`
- The user says WIP, not ready, or wants early feedback
- Important follow-up work is intentionally left open

Otherwise create a normal PR.

## PR Title Guidance

Write a short title focused on the change outcome.

- Prefer the author's observed style over generic defaults
- Keep it specific enough for a PR list
- Avoid commit-log phrasing, implementation trivia, hype, and emojis

## PR Body Guidance

Keep the body high-signal. Explain what this PR changes, how it was validated, and how to review it.

Fallback sections when no repo template exists:

- `Related: #123` when useful
- `## What Problem This Solves`
- `## Why This Change Was Made`
- `## User Impact`
- `## Evidence`
- `## Demo` or focused before/after proof when useful

Shorter fallback sections remain acceptable for small changes:

- `## Summary`
- `## Validation`
- `## Review Guide`
- `## Demo`
- `## Diagram`

Rules:

- Use `What Problem This Solves` to describe current broken/confusing/expensive behavior, not implementation details
- Use `Why This Change Was Made` to state design constraints, compatibility choices, links to specs/docs, or tradeoffs
- Use `User Impact` for observable behavior changes, preferably concrete bullets
- Use `Evidence` for commands, test counts, builds, screenshots, CI status, review passes, and manual verification that actually happened
- Keep `Summary` high-level when using shorter format
- `Validation` should list the commands or checks that actually ran when using shorter format
- Include `No issues found` only when the listed checks passed cleanly
- Include `## Demo`, screenshots, or before/after tables only when there is a meaningful demo, repro flow, or user-facing change
- Include `## Diagram` only when Mermaid materially improves understanding
- End with `Fixes #123`, `Closes #123`, or `Refs #123` when relevant

If the repo template defines different headings, follow the repo template first and adapt the wording to stay concise.

## Evidence Expectations

Good evidence is concrete and independently useful to reviewers.

Prefer evidence bullets like:

- exact commands that passed
- exact test names, counts, or suites when available
- build target, simulator/device, browser, or runtime used for UI changes
- `git diff --check`, formatters, linters, typechecks, and CI status when actually checked
- visual capture notes, screenshot tables, or attachment links for UI changes
- structured review or agent-review results only when such review actually ran
- known warning-only or pre-existing failures, clearly labeled

Avoid vague evidence like:

- `tested locally`
- `all tests pass` without command or scope
- `verified manually` without scenario
- claiming screenshots, CI, review, or device coverage that did not happen

For larger PRs, include enough evidence for reviewers to trust both the main change and risky follow-ups. For small PRs, keep evidence to 1-3 bullets.

## Visual Proof Guidance

For UI, UX, docs rendering, CLI output, or generated artifact changes, include visual proof when useful and available.

Useful formats:

- before/after screenshot table
- final-state screenshot table by theme/device/screen
- short repro transcript or CLI output excerpt
- linked artifact or recording

Rules:

- label screenshots with what changed, not only file names
- include environment details when they affect rendering
- keep tables scoped to high-value surfaces
- do not add visual sections for backend-only or invisible changes

## Review Guide Expectations

Write review guidance for humans and agents. Tell reviewers where to spend time.

Good review bullets call out:

- the files or subsystem that matter most
- behavior changes and invariants to verify
- risky edges, migrations, or compatibility concerns
- what was intentionally left unchanged when that matters

Avoid filler like "please review carefully".

## Mermaid Guidance

Use Mermaid only for flows, migrations, or architecture shifts that are genuinely easier to understand visually than in prose. Keep diagrams small and accurate. Skip them for simple fixes.

## Issue References

Add a closing reference only when it is actually relevant. Infer likely issue links from the conversation, branch name, commits, or GitHub issues you inspected. Prefer the author's observed phrasing.

Examples:

- `Closes #42`
- `Fixes #42`
- `Refs #42`

## Creation Command Pattern

Prefer explicit title and body content:

```bash
gh pr create \
  --repo <owner/repo> \
  --base <base-branch> \
  --head <head-branch> \
  --title "<title>" \
  --body "$(cat <<'EOF'
<body>
EOF
)"
```

Add `--draft` when needed.

## Follow-Up Skills

After creating the PR, consider whether another skill should take over.

- If the user asks to monitor CI, watch feedback, handle review comments, or keep an eye on the PR, load `babysit-pr`
- If the user asks to address review feedback, keep using normal coding workflow, then hand back to `babysit-pr` if they still want monitoring

## Final Output

After creation, report:

- PR URL
- whether it is draft or ready
- checks that ran
- any notable follow-up or known blocker
- whether `babysit-pr` is the logical next skill when the user asked for monitoring
