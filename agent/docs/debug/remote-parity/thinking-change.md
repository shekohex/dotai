---
status: investigating
trigger: "Inspect visible startup thinking-level surface"
created: 2026-05-03T18:53:00Z
updated: 2026-05-03T19:05:55Z
---

## Current Focus

hypothesis: remote and local both handle visible thinking-level change through `/settings`
test: open `/settings`, search `thinking`, open submenu, select `medium`, compare footer and selector state
expecting: both panes should show same `Thinking Level` submenu and update footer from `:low` to `:medium`
next_action: keep grouped with settings/theme surfaces; theme/resource still needs direct exercise

## Symptoms

expected: both panes expose and update current thinking level through visible settings UI
actual: both panes open `Thinking Level`, show current selection at `low`, then return to settings with `Thinking level medium` and footer `gpt-5.4-mini:medium`
errors: none
reproduction: boot paired tmux panes, run `/settings`, type `thinking`, Enter, Down, Enter
started: audit run 2026-05-03

## Eliminated

- hypothesis: baseline visible chrome lacks thinking-level text entirely
  evidence: local idle header includes `gpt-5.4-mini:low`
  timestamp: 2026-05-03T18:53:00Z

- hypothesis: actual thinking-level change path is not reachable deterministically in tmux harness
  evidence: `/settings` search plus Enter reliably opens `Thinking Level` submenu in both panes
  timestamp: 2026-05-03T19:05:55Z

## Evidence

- timestamp: 2026-05-03T18:53:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch14/thinking-change/local-final.clean.txt
  found: local pane shows `commiter codex-openai/gpt-5.4-mini:low`
  implication: thinking level is visibly represented at baseline

- timestamp: 2026-05-03T19:05:55Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch16/thinking2/local-thinking.clean.txt and .pi/remote-e2e/audit-2026-05-03-batch16/thinking2/remote-thinking.clean.txt
  found: both panes show `Thinking Level` submenu with `low` selected
  implication: remote opens same visible change surface as standalone local Pi

- timestamp: 2026-05-03T19:05:55Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch16/thinking-select/local-thinking-select.clean.txt and .pi/remote-e2e/audit-2026-05-03-batch16/thinking-select/remote-thinking-select.clean.txt
  found: both panes return to settings with `Thinking level medium`; footer updates from `:low` to `:medium`
  implication: visible thinking-level change is parity, not blocked

## Resolution

root_cause:
fix:
verification: paired tmux run shows matching submenu open and matching footer update to `gpt-5.4-mini:medium`
files_changed: []
