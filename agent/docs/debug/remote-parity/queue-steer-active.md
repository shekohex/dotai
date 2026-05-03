---
status: investigating
trigger: "Write STEER-93-1 through STEER-93-120, one per line, no extra text. Then steer: Instead stop at STEER-93-20 and then say STEER-SWITCH-93 only."
created: 2026-05-03T18:24:00Z
updated: 2026-05-03T18:24:00Z
---

## Current Focus

hypothesis: remote active-run steering visibility fails in same family as queued follow-up and interrupt scenarios
test: compare long streaming run plus mid-run steering message in both panes
expecting: local shows steering surface and continued active transcript; remote may stay idle or miss steering state entirely
next_action: group with remote queue/live-state patch failures

## Symptoms

expected: standalone local Pi should show active stream plus visible steering line during run
actual: local pane shows `STEER-93-*` stream and `Steering: Instead stop at STEER-93-20 and then say STEER-SWITCH-93 only.` while remote settled pane stays at idle placeholder with `ctx 0`
errors: none
reproduction: boot paired tmux panes, wait for `ctx `, start long stream, send steering instruction 2s later
started: audit run 2026-05-03

## Eliminated

- hypothesis: local also failed to enter steer-visible state
  evidence: local log and final pane show steering line and queued-edit hint during active stream
  timestamp: 2026-05-03T18:24:00Z

## Evidence

- timestamp: 2026-05-03T18:24:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch10/queue-steer-active/local-final.clean.txt
  found: local pane shows `STEER-93-1` through `STEER-93-27`, steering line, queued-edit hint, and `tps` footer
  implication: reference steer-visible path is working locally

- timestamp: 2026-05-03T18:24:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch10/queue-steer-active/remote-final.clean.txt
  found: remote pane only shows idle placeholder `What should I simplify?` and footer `ctx 0`
  implication: remote missed both active stream and steer-visible state

- timestamp: 2026-05-03T18:24:00Z
  checked: .pi/remote-e2e/pi-remote-e2e-batch10-qs/logs/local-pi.log
  found: local log records repeated stream tail updates followed by `Steering:` lines
  implication: divergence is stable enough to attribute beyond capture timing

## Resolution

root_cause:
fix:
verification:
files_changed: []
