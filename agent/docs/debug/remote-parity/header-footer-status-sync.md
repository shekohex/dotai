---
status: investigating
trigger: "/tps on"
created: 2026-05-03T18:31:00Z
updated: 2026-05-03T18:31:00Z
---

## Current Focus

hypothesis: remote chrome/status command handling diverges even for simple footer-affecting UI commands
test: send `/tps on` in both panes and compare visible command handling plus resulting footer state
expecting: local and remote both acknowledge command and keep footer/status chrome consistent
next_action: group with remote visible-status loss and footer transport gaps

## Symptoms

expected: both panes should visibly accept `/tps on` and reflect same footer/chrome state
actual: local final pane still shows `/tps on` command line and normal footer; remote final pane stays on idle placeholder with no visible `/tps on` handling
errors: none
reproduction: boot paired tmux panes, wait for `ctx `, send `/tps on` in both panes
started: audit run 2026-05-03

## Eliminated

- hypothesis: local also dropped command visibility
  evidence: local final pane includes `/tps on`
  timestamp: 2026-05-03T18:31:00Z

## Evidence

- timestamp: 2026-05-03T18:31:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch11/header-footer-status-sync/local-final.clean.txt
  found: local pane shows `/tps on` and normal footer `ctx 0 (0%) · $0.00 · 5h 93% wk 73%`
  implication: local command path is at least visibly accepted

- timestamp: 2026-05-03T18:31:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch11/header-footer-status-sync/remote-final.clean.txt
  found: remote pane shows idle placeholder `What should I unblock first?` and no visible `/tps on`
  implication: remote command/chrome update path diverges visibly

## Resolution

root_cause:
fix:
verification:
files_changed: []
