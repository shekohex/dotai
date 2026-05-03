---
status: investigating
trigger: "Write STATUS-91-1 through STATUS-91-60, one per line, no extra text."
created: 2026-05-03T18:17:00Z
updated: 2026-05-03T18:17:00Z
---

## Current Focus

hypothesis: remote loses status/footer progression together with streamed transcript when a long assistant run should visibly update chrome
test: compare long streamed prompt in both panes and inspect footer/status lines in settled captures
expecting: local shows nonzero context growth and in-progress surface; remote may stay at idle chrome
next_action: group with remote no-render family and later inspect UI state patch delivery for working/status surfaces

## Symptoms

expected: standalone local Pi should show streamed response plus changing footer/status surfaces during run
actual: local settled pane shows submitted prompt and `ctx 17`; remote settled pane shows idle placeholder `What should I unblock first?` and `ctx 0`
errors: none
reproduction: boot paired tmux panes, wait for `ctx `, send same 60-line status stream prompt
started: audit run 2026-05-03

## Eliminated

- hypothesis: both panes merely completed too fast to observe status differences
  evidence: local final pane retains submitted prompt and higher context count while remote remains at idle baseline
  timestamp: 2026-05-03T18:17:00Z

## Evidence

- timestamp: 2026-05-03T18:17:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch9/streaming-visible-status/local-final.clean.txt
  found: local pane shows prompt `Write STATUS-91-1 through STATUS-91-60...` and footer `ctx 17 (0%)`
  implication: reference pane visibly entered and tracked run state

- timestamp: 2026-05-03T18:17:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch9/streaming-visible-status/remote-final.clean.txt
  found: remote pane shows idle placeholder `What should I unblock first?` and footer `ctx 0 (0%)`
  implication: remote did not project matching run/status state

## Resolution

root_cause:
fix:
verification:
files_changed: []
