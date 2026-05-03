---
status: investigating
trigger: "attach extra remote client directly to created target session"
created: 2026-05-03T18:02:00Z
updated: 2026-05-03T19:52:00Z
---

## Current Focus

hypothesis: direct `/resume` after creating two named sessions gives deterministic visible switch surface in both panes
test: name first session, run `/new`, name second session, run `/resume`, compare visible picker contents
expecting: both panes should show comparable current-folder session list or same empty-state message
next_action: group with session catalog/picker divergence

## Symptoms

expected: both panes should expose same resume picker state after creating two named sessions
actual: local picker says `No sessions in current folder. Press Tab to view all.` while remote picker shows two `(no messages)` rows under current-folder scope
errors: none
reproduction: boot paired tmux panes, `/name FIRST-SESSION-11`, `/new`, `/name SECOND-SESSION-22`, `/resume`
started: audit run 2026-05-03

## Eliminated

- hypothesis: local harness has no direct analogue for session-switch surface
  evidence: `/resume` opens visible session picker in both panes
  timestamp: 2026-05-03T19:52:00Z

## Evidence

- timestamp: 2026-05-03T18:02:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch7/session-switch/target-session.id and switch-session.log
  found: target remote session was created and extra client attached to it
  implication: remote-only attach flow executed

- timestamp: 2026-05-03T18:02:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch7/session-switch/remote-final.clean.txt
  found: remote primary pane remained usable idle session
  implication: no visible primary-pane crash, but no direct local parity judgement yet

- timestamp: 2026-05-03T19:52:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch23/session-switch/local.clean.txt
  found: local `Resume Session` picker reports `No sessions in current folder. Press Tab to view all.`
  implication: local current-folder scope does not surface the earlier named session chain

- timestamp: 2026-05-03T19:52:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch23/session-switch/remote.clean.txt
  found: remote picker in current-folder scope shows two `(no messages)` rows instead of same empty-state text
  implication: remote session picker state diverges from standalone local Pi

- timestamp: 2026-05-03T19:52:00Z
  checked: .pi/remote-e2e/audit23-switch/logs/remote-client.log and local-pi.log
  found: both logs include `Session name set: FIRST-SESSION-11`, `✓ New session started`, `Session name set: SECOND-SESSION-22`, then `/resume`
  implication: divergence is in picker/catalog projection, not setup failure

## Resolution

root_cause:
fix:
verification: paired `/resume` run diverges in visible picker contents after same setup
files_changed: []
