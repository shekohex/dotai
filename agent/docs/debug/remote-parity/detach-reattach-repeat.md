---
status: investigating
trigger: "Reply REATTACH-99 only. Restart remote client three times with --continue."
created: 2026-05-03T18:45:00Z
updated: 2026-05-03T20:16:00Z
---

## Current Focus

hypothesis: repeated remote reattach path is blocked-by-prior-bug because remote transcript restore/projection is already failing in simpler continue/reconnect scenarios
test: seed one prompt, restart remote client three times, compare final remote pane against local reference and prior restore bugs
expecting: if prior bug is responsible, reattach path will keep using `--continue` but never restore visible transcript
next_action: treat as blocked-by-prior-bug under `session-continue` and `reconnect-mid-stream` restore/projection failures

## Symptoms

expected: local reference shows `REATTACH-99`; each remote reattach should preserve same visible transcript
actual: local pane shows `Reply REATTACH-99 only.` and `REATTACH-99`; remote repeated reattach commands run with `--continue`, but final pane shows startup lines only; scenario is blocked-by-prior-bug in remote restore/projection
errors: none
reproduction: boot paired tmux panes, send source prompt, restart remote pane three times
started: audit run 2026-05-03

## Eliminated

- hypothesis: reattach did not use continue mode
  evidence: remote log records three restart commands with `--continue`
  timestamp: 2026-05-03T18:45:00Z

## Evidence

- timestamp: 2026-05-03T18:45:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch13/detach-reattach-repeat/local-final.clean.txt
  found: local pane shows `Reply REATTACH-99 only.` and `REATTACH-99`
  implication: source session was visible in reference pane

- timestamp: 2026-05-03T18:45:00Z
  checked: .pi/remote-e2e/pi-remote-e2e-batch13-reattach/logs/remote-client.log
  found: three restart command blocks include `--continue`
  implication: repeated reattach path executed mechanically

- timestamp: 2026-05-03T18:45:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch13/detach-reattach-repeat/remote-final.clean.txt
  found: remote pane shows restarted `pi:remote` startup lines, not restored `REATTACH-99` transcript
  implication: visible repeated-reattach parity remains blocked

- timestamp: 2026-05-03T20:16:00Z
  checked: docs/debug/remote-parity/session-continue.md and docs/debug/remote-parity/reconnect-mid-stream.md
  found: remote already loses visible restored transcript after `--continue` and after mid-stream reconnect
  implication: detach/reattach-repeat is blocked-by-prior-bug, not an independent untriaged gap

## Resolution

root_cause:
fix:
verification:
files_changed: []
