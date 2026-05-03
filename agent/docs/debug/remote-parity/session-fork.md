---
status: investigating
trigger: "Reply with FORK-SOURCE-91 only."
created: 2026-05-03T17:29:00Z
updated: 2026-05-03T17:29:00Z
---

## Current Focus

hypothesis: remote mode fails to surface fork selection UI and instead reports no forkable messages
test: answer one user prompt in both panes, invoke `/fork`, compare visible surfaces after settle
expecting: if true, local shows fork picker while remote shows error or no-op state
next_action: inspect remote session history projection for forkable entry metadata

## Symptoms

expected: standalone local Pi shows `Fork from Message` picker with prior user message selectable
actual: local shows fork picker; remote shows `No messages to fork from` and returns to idle
errors: "No messages to fork from"
reproduction: boot paired tmux panes, submit one prompt, wait for completion, run `/fork`
started: audit run 2026-05-03

## Eliminated

- hypothesis: remote never recognized `/fork` command
  evidence: remote command menu highlighted `fork` before failure
  timestamp: 2026-05-03T17:29:00Z

## Evidence

- timestamp: 2026-05-03T17:29:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch2/session-fork/local-final.clean.txt
  found: local pane shows `Fork from Message` UI and selectable prior message
  implication: standalone local Pi exposes forkable history correctly

- timestamp: 2026-05-03T17:29:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch2/session-fork/remote-client.log
  found: remote log shows `/fork`, menu highlight, then `No messages to fork from`
  implication: remote projection/runtime believes fork source list is empty

## Resolution

root_cause:
fix:
verification:
files_changed: []
