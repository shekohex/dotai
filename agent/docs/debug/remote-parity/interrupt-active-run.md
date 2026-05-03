---
status: investigating
trigger: "Count from 1 to 500, one per line, no extra text."
created: 2026-05-03T17:34:00Z
updated: 2026-05-03T17:34:00Z
---

## Current Focus

hypothesis: remote mode fails to propagate active-run progress, queued follow-up visibility, and interrupt state during long assistant stream
test: run long count in both panes, queue follow-up, press Escape in both panes, compare settled snapshots
expecting: if true, local shows completed stream + queued prompt + `Operation aborted`, while remote remains early in stream with no queue/abort surface
next_action: inspect remote live patch path for active run, queue state, and interrupt events

## Symptoms

expected: standalone local Pi continues long stream, shows queued follow-up prompt, and surfaces `Operation aborted` after interrupt
actual: local shows count through 500, queued follow-up text, and `Operation aborted`; remote settled snapshot still shows only lines 1..14 with spinner and no queued/aborted state
errors: none
reproduction: boot paired tmux panes, submit long count, submit follow-up during run, press Escape, settle snapshots
started: audit run 2026-05-03

## Eliminated

- hypothesis: remote did not accept follow-up or interrupt input at all
  evidence: prompt and active stream are visible remotely, but queued/interrupt surfaces never appear after inputs
  timestamp: 2026-05-03T17:34:00Z

## Evidence

- timestamp: 2026-05-03T17:34:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch4/interrupt-active-run/local-final.clean.txt
  found: local pane shows count through 500, queued follow-up text, and `Operation aborted`
  implication: reference behavior exposes queue and interrupt state clearly

- timestamp: 2026-05-03T17:34:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch4/interrupt-active-run/remote-final.clean.txt
  found: remote pane remains at count 1..14 with spinner only
  implication: remote live projection diverges badly under long active run

- timestamp: 2026-05-03T17:34:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch4/interrupt-active-run/local-vs-remote.diff
  found: large transcript and state gap between local and remote settled panes
  implication: same root area may overlap with long-stream render gap

## Resolution

root_cause:
fix:
verification:
files_changed: []
