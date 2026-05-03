---
status: resolved
trigger: "!for i in $(seq 1 80); do echo BASH-LARGE-81-$i; sleep 0.05; done"
created: 2026-05-03T18:10:00Z
updated: 2026-05-03T18:10:00Z
---

## Current Focus

hypothesis: remote sustained bash projection stays aligned with standalone local Pi across longer output tails
test: compare settled pane captures after 80-line bash stream with unique line prefix `BASH-LARGE-81-*`
expecting: both panes show tail through `BASH-LARGE-81-80` with no stale running indicator
next_action: use same evidence family for `stream-smoothness` and `repeated-stability`

## Symptoms

expected: standalone local Pi and remote both show ongoing bash output and return to idle after completion
actual: both settled panes show `BASH-LARGE-81-80` and idle prompt surfaces
errors: none
reproduction: boot paired tmux panes, wait for `ctx `, run same bash command in both panes
started: audit run 2026-05-03

## Eliminated

- hypothesis: long bash output truncates remotely before final tail line
  evidence: remote settled pane contains `BASH-LARGE-81-80`
  timestamp: 2026-05-03T18:10:00Z

## Evidence

- timestamp: 2026-05-03T18:10:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch8/bash-stream-large-output/remote-final.clean.txt
  found: remote pane shows bash output tail including `BASH-LARGE-81-80` and idle footer
  implication: remote sustained bash projection reached completion

- timestamp: 2026-05-03T18:10:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch8/bash-stream-large-output/local-final.clean.txt
  found: local pane shows `BASH-LARGE-81-80` and idle prompt
  implication: reference behavior matches remote on final visible state

## Resolution

root_cause: none observed
fix:
verification: unique 80-line bash stream reached identical final tail marker in both panes
files_changed: []
