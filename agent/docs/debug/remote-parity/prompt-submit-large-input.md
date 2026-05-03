---
status: investigating
trigger: "Repeat LARGE-INPUT-55 only. Ignore filler: [2043-char prompt]"
created: 2026-05-03T17:41:00Z
updated: 2026-05-03T17:41:00Z
---

## Current Focus

hypothesis: remote accepts large prompt text but fails to advance to final assistant answer render while local completes normally
test: submit 2043-char prompt in both panes and compare settled snapshots
expecting: if true, local ends with `LARGE-INPUT-55` while remote remains dominated by prompt text + spinner
next_action: inspect remote handling of large input submission and downstream render path

## Symptoms

expected: standalone local Pi accepts long prompt and answers `LARGE-INPUT-55`
actual: local shows final `LARGE-INPUT-55`; remote settled pane still shows wrapped prompt text and spinner without answer
errors: none
reproduction: boot paired tmux panes, submit 2043-char prompt with unique answer marker
started: audit run 2026-05-03

## Eliminated

- hypothesis: remote dropped prompt before submission
  evidence: remote final pane contains wrapped full prompt body with expected marker in prompt text
  timestamp: 2026-05-03T17:41:00Z

## Evidence

- timestamp: 2026-05-03T17:41:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch5c/prompt-submit-large-input/local-final.clean.txt
  found: local pane shows full prompt followed by `LARGE-INPUT-55`
  implication: standalone local Pi handles long input correctly

- timestamp: 2026-05-03T17:41:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch5c/prompt-submit-large-input/remote-final.clean.txt
  found: remote pane shows wrapped prompt text and spinner only
  implication: remote large-input path diverges after acceptance

## Resolution

root_cause:
fix:
verification:
files_changed: []
