---
status: investigating
trigger: "Reply CONTINUE-SOURCE-94 only. Restart remote client with --continue."
created: 2026-05-03T18:24:00Z
updated: 2026-05-03T19:48:00Z
---

## Current Focus

hypothesis: deterministic pre-state via `/name` can verify whether remote `--continue` preserves session metadata across restart
test: set session name, restart remote client with `--continue`, then run `/session`, compare visible restored name field
expecting: if parity holds, remote after restart should still show `Name: CONTINUE-NAME-66` like local
next_action: group with remote restore/projection loss family

## Symptoms

expected: local reference shows source prompt and completed context growth; remote after restart should restore same session transcript
actual: local keeps `Session name set: CONTINUE-NAME-66` and `/session` shows `Name: CONTINUE-NAME-66`; remote restart command uses `--continue`, but restored `/session` pane lacks `Name:` field entirely
errors: none
reproduction: boot paired tmux panes, send `/name CONTINUE-NAME-66`, restart remote pane, then send `/session`
started: audit run 2026-05-03

## Eliminated

- hypothesis: remote restart omitted `--continue`
  evidence: remote log shows restarted command with `--continue`
  timestamp: 2026-05-03T18:24:00Z

- hypothesis: current `session-continue` coverage is blocked only because source transcript marker was too weak
  evidence: rename-based pre-state still disappears from remote restored pane after `--continue`
  timestamp: 2026-05-03T19:48:00Z

## Evidence

- timestamp: 2026-05-03T18:24:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch10/session-continue/local-final.clean.txt
  found: local pane shows source prompt `Reply CONTINUE-SOURCE-94 only.` and footer `ctx 8`
  implication: reference session had visible transcript before reattach

- timestamp: 2026-05-03T18:24:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch10/session-continue/remote-final.clean.txt
  found: remote pane shows restarted `pi:remote` and `tsx src/cli.ts ... --continue` startup lines only
  implication: current run cannot prove remote transcript restore behavior

- timestamp: 2026-05-03T18:24:00Z
  checked: .pi/remote-e2e/pi-remote-e2e-batch10-cont/logs/remote-client.log
  found: remote log contains restart command with `--continue`
  implication: reattach path executed, but visible restore evidence stayed weak

- timestamp: 2026-05-03T19:48:00Z
  checked: .pi/remote-e2e/audit22-cont/logs/remote-client.log
  found: remote log contains `Session name set: CONTINUE-NAME-66` before restart and restarted command with `--continue`
  implication: named session existed before reattach and continue path definitely ran

- timestamp: 2026-05-03T19:48:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch22/session-continue/remote.clean.txt
  found: remote restored pane shows `Session Info` with file/id only, no `Name:` field
  implication: remote did not visibly restore renamed session metadata

- timestamp: 2026-05-03T19:48:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch22/session-continue/local.clean.txt
  found: local pane shows `Session name set: CONTINUE-NAME-66` and `/session` shows `Name: CONTINUE-NAME-66`
  implication: local reference preserves session metadata that remote restore loses

## Resolution

root_cause:
fix:
verification: paired rename -> restart -> `/session` run diverges; remote loses visible session name after `--continue`
files_changed: []
