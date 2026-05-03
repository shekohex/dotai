---
status: investigating
trigger: "Reply SESSION-NEW-SOURCE-92 only. Then run /new in both panes."
created: 2026-05-03T18:17:00Z
updated: 2026-05-03T19:45:00Z
---

## Current Focus

hypothesis: deterministic pre-state via `/name` is enough to verify `/new` reset parity
test: set session name, run `/new`, then `/session`, compare visible reset state
expecting: both panes should show `✓ New session started` and post-reset `Session Info` without previous name
next_action: use same deterministic pre-state approach on `session-continue` or `session-switch`

## Symptoms

expected: both panes should show source-session activity, then `/new` command menu and reset to fresh idle session
actual: both panes show `✓ New session started`, post-reset `Session Info` with new file/id, no `Name:` row, and idle footer `ctx 0`
errors: none
reproduction: boot paired tmux panes, send `/name PRENEW-SESSION-55`, then `/new`, then `/session`
started: audit run 2026-05-03

## Eliminated

- hypothesis: remote `/new` command was not recognized
  evidence: remote log shows `/new` entry and final pane returns to fresh idle prompt with `ctx 0`
  timestamp: 2026-05-03T18:17:00Z

- hypothesis: `/new` parity requires prior assistant transcript to be visible first
  evidence: rename pre-state plus `/session` proves reset semantics directly in both panes
  timestamp: 2026-05-03T19:45:00Z

## Evidence

- timestamp: 2026-05-03T18:17:00Z
  checked: .pi/remote-e2e/pi-remote-e2e-batch9-new/logs/local-pi.log
  found: local log shows source prompt, `/new` command menu entry `→ new Start a new session`, then fresh idle footer `ctx 0`
  implication: reference `/new` reset path is visible locally

- timestamp: 2026-05-03T18:17:00Z
  checked: .pi/remote-e2e/pi-remote-e2e-batch9-new/logs/remote-client.log
  found: remote log shows `/new` entry and final idle state `ctx 0`, but no visible `SESSION-NEW-SOURCE-92`
  implication: remote reset may work, but parity remains unproven because source-session state was missing before reset

- timestamp: 2026-05-03T18:17:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch9/session-new/remote-final.clean.txt and local-final.clean.txt
  found: both panes end in fresh idle-looking state after `/new`
  implication: post-reset surface converges, but pre/post parity evidence is incomplete

- timestamp: 2026-05-03T19:45:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch21/session-new/remote.clean.txt
  found: remote pane shows `✓ New session started`, `Session Info`, fresh file/id, no `Name:` field, and idle `ctx 0`
  implication: remote reset semantics are visibly correct on deterministic pre-state

- timestamp: 2026-05-03T19:45:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch21/session-new/local.clean.txt
  found: local pane shows same reset acknowledgement and same post-reset metadata shape
  implication: remote matches local reference for `/new`

## Resolution

root_cause:
fix:
verification: paired `/name` -> `/new` -> `/session` run shows matching reset surface in both panes
files_changed: []
