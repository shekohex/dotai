---
status: investigating
trigger: "Start remote session with PI_REMOTE_SESSION_NAME=SESSION-RENAME-100"
created: 2026-05-03T18:53:00Z
updated: 2026-05-03T19:42:00Z
---

## Current Focus

hypothesis: direct `/name <value>` plus `/session` gives deterministic visible rename surface in both panes
test: send `/name SESSION-DELTA-42`, then `/session`, compare visible `Session name set` and `Name:` rows
expecting: both panes should render same rename acknowledgement and same `Session Info` name field
next_action: mark scenario parity; startup-name override probe is no longer needed

## Symptoms

expected: renamed session identity should be visible in header/title or session metadata surface
actual: both panes show `Session name set: SESSION-DELTA-42` and `Session Info` with `Name: SESSION-DELTA-42`
errors: none
reproduction: boot paired tmux panes, send `/name SESSION-DELTA-42`, then `/session`
started: audit run 2026-05-03

## Eliminated

- hypothesis: local default header obviously exposes session name
  evidence: local capture only shows usual mode/model/footer chrome
  timestamp: 2026-05-03T18:53:00Z

- hypothesis: rename parity cannot be judged because no deterministic visible surface exists
  evidence: `/name` and `/session` expose same rename acknowledgement and name field in both panes
  timestamp: 2026-05-03T19:42:00Z

## Evidence

- timestamp: 2026-05-03T18:53:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch14/session-rename/local-final.clean.txt
  found: local pane shows standard header `commiter codex-openai/gpt-5.4-mini:low` and `ctx 0`, with no visible rename-specific signal
  implication: current probe is insufficient for parity judgment

- timestamp: 2026-05-03T19:42:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch20/session-rename/remote.clean.txt
  found: remote pane shows `Session name set: SESSION-DELTA-42` and `Session Info` with `Name: SESSION-DELTA-42`
  implication: remote rename surface works on direct command path

- timestamp: 2026-05-03T19:42:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch20/session-rename/local.clean.txt
  found: local pane shows same rename acknowledgement and same `Session Info` name field
  implication: remote matches standalone local Pi on rename surface

## Resolution

root_cause:
fix:
verification: paired `/name` + `/session` run shows matching visible rename state in both panes
files_changed: []
