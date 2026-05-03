---
status: investigating
trigger: "/model"
created: 2026-05-03T18:58:00Z
updated: 2026-05-03T19:01:00Z
---

## Current Focus

hypothesis: remote command surface fails to project visible model picker even though standalone local Pi opens it immediately
test: send `/model` in both panes and compare visible picker surface
expecting: local shows model selector list; remote may stay on raw command echo
next_action: group with remote command/chrome no-render family

## Symptoms

expected: standalone local Pi opens model picker with selectable provider/model list
actual: local pane shows model picker and details for `gpt-5.4-mini`; remote pane only shows raw `/model` text
errors: none
reproduction: boot paired tmux panes, send `/model`
started: audit run 2026-05-03

## Eliminated

- hypothesis: baseline local TUI has no visible model-change surface
  evidence: local `/model` opens selector with 75 entries and current model marker
  timestamp: 2026-05-03T19:01:00Z

## Evidence

- timestamp: 2026-05-03T19:01:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch15/probes/\_model-local.clean.txt
  found: local pane shows `Only showing models from configured providers`, selector entries, current checkmark on `gpt-5.4-mini`, and detail line `Model Name: GPT-5.4 Mini`
  implication: reference visible model-change surface is healthy

- timestamp: 2026-05-03T19:01:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch15/probes/\_model-remote.clean.txt
  found: remote pane only shows `/model`
  implication: remote does not project visible model selector surface

## Resolution

root_cause:
fix:
verification:
files_changed: []
