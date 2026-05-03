---
status: resolved
trigger: "!for i in $(seq 1 60); do echo hot-bash-$i; sleep 0.03; done"
created: 2026-05-03T17:30:00Z
updated: 2026-05-03T17:30:00Z
---

## Current Focus

hypothesis: remote hot bash stream remains usable and converges with local under dense output
test: run 60-line fast bash loop in both panes and compare logs plus settled snapshots
expecting: if true, both panes show high-number tail, overflow summary, and no stuck active state
next_action: use same evidence for `stream-smoothness` linkage

## Symptoms

expected: standalone local Pi shows dense bash output, truncates older lines as needed, and returns to idle
actual: remote and local both show tail through `hot-bash-60`, overflow summary, and idle state
errors: none
reproduction: boot paired tmux panes, run fast 60-line bash loop in both panes
started: audit run 2026-05-03

## Eliminated

## Evidence

- timestamp: 2026-05-03T17:30:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch3/bash-stream-hot-output/remote-client.log
  found: remote log contains sequential `hot-bash-*` lines through `hot-bash-60`
  implication: remote did not burst-collapse final line delivery completely

- timestamp: 2026-05-03T17:30:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch3/bash-stream-hot-output/local-pi.log
  found: local log contains same sequence through `hot-bash-60`
  implication: local reference behavior matches remote at log level

- timestamp: 2026-05-03T17:30:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch3/bash-stream-hot-output/local-vs-remote.diff
  found: visible differences are layout width and overflow count only, not missing tail lines or stuck running state
  implication: treat as parity for hot bash streaming

## Resolution

root_cause: none observed
fix:
verification: remote/local settled panes both show `hot-bash-42`..`hot-bash-60`, overflow summary, and idle state
files_changed: []
