---
status: investigating
trigger: "/stash"
created: 2026-05-03T17:29:00Z
updated: 2026-05-03T17:29:00Z
---

## Current Focus

hypothesis: remote extension UI opens stash picker and reports success, but does not advance to same post-selection content view as local
test: seed one stash entry, run `/stash`, press Enter in both panes, compare settled snapshots
expecting: if true, local shows opened stash content while remote remains on selection modal
next_action: inspect remote extension UI request/response lifecycle after selection submit

## Symptoms

expected: standalone local Pi opens stash entry content after selection
actual: local shows opened stash content line; remote shows `Opened stash entry (1 lines)` but remains in `Select stash entry` modal
errors: none
reproduction: seed stash entry, boot paired tmux panes, run `/stash`, press Enter on first item
started: audit run 2026-05-03

## Eliminated

- hypothesis: remote failed before receiving selection input
  evidence: remote log shows `Prompt Stash` then `Opened stash entry (1 lines)`
  timestamp: 2026-05-03T17:29:00Z

## Evidence

- timestamp: 2026-05-03T17:29:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch2/extension-ui-request-response/local-final.clean.txt
  found: local pane shows stash entry content `remote stash entry for extension ui proof`
  implication: reference behavior exits modal and renders selected content

- timestamp: 2026-05-03T17:29:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch2/extension-ui-request-response/remote-final.clean.txt
  found: remote pane still shows selection modal with first entry highlighted
  implication: remote extension response state does not drive final visible transition

## Resolution

root_cause:
fix:
verification:
files_changed: []
