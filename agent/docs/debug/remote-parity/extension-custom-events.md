---
status: investigating
trigger: "Extension custom event surface if visible"
created: 2026-05-03T18:58:00Z
updated: 2026-05-03T19:24:00Z
---

## Current Focus

hypothesis: `openusage` provides deterministic extension-owned custom surface, and remote fails to project it
test: send `/openusage status` in both panes and compare visible custom surface
expecting: both panes should open same `OpenUsage` surface or both fall back to same status message
next_action: group with extension/custom-surface projection failures

## Symptoms

expected: deterministic extension flow with visible custom event ordering
actual: local opens full `OpenUsage` surface; remote only echoes raw `/openusage status`
errors: none
reproduction: boot paired tmux panes, send `/openusage status`
started: audit run 2026-05-03

## Eliminated

- hypothesis: no harness-ready custom extension surface exists
  evidence: `/openusage status` opens visible extension-owned surface in standalone local Pi
  timestamp: 2026-05-03T19:24:00Z

## Evidence

- timestamp: 2026-05-03T18:58:00Z
  checked: docs/debug/remote-parity/extension-ui-request-response.md
  found: even basic extension UI request/response already diverges remotely
  implication: custom event scenario is likely related but still lacks direct evidence

- timestamp: 2026-05-03T19:24:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch19/openusage/local.clean.txt
  found: local pane opens `OpenUsage (Esc/q/Enter to close)` with provider tabs, account info, summary, and quota bars
  implication: standalone local Pi exposes deterministic extension-owned custom surface

- timestamp: 2026-05-03T19:24:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch19/openusage/remote.clean.txt
  found: remote pane only shows raw `/openusage status` text and idle chrome
  implication: remote fails to project this extension custom surface

## Resolution

root_cause:
fix:
verification: paired `/openusage status` run diverges immediately at first visible extension surface
files_changed: []
