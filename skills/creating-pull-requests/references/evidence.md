# PR Evidence

Read when a PR needs demos, screenshots, or supporting artifacts beyond validation commands.

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

