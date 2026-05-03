---
status: investigating
trigger: "Use one shell tool call. Run printf \"TOOL-UNIQ-42\\n\". Then answer TOOL-DONE-42 only."
created: 2026-05-03T17:22:00Z
updated: 2026-05-03T17:22:00Z
---

## Current Focus

hypothesis: remote projection loses tool lifecycle surface and final assistant continuation after tool execution
test: compare stable final snapshots using unique tool marker and final answer marker
expecting: if true, local shows tool row + `TOOL-DONE-42`, remote remains on prompt + spinner
next_action: inspect remote tool-event propagation and client projection path

## Symptoms

expected: standalone local Pi shows tool start/update surface, then final `TOOL-DONE-42`
actual: local settled snapshot shows tool row and final answer; remote settled snapshot shows prompt and spinner only
errors: none
reproduction: boot paired tmux panes, submit unique tool prompt, wait for final answer marker, settle by repeated captures
started: audit run 2026-05-03

## Eliminated

- hypothesis: earlier path match proved tool success remotely
  evidence: original marker `/home/coder/dotai/agent` matched startup command, not tool output
  timestamp: 2026-05-03T17:22:00Z

## Evidence

- timestamp: 2026-05-03T17:22:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-wrapper/tool-lifecycle-basic/local-final.clean.txt
  found: local pane shows `▏$ Prints unique tool marker · ok (1 line)` and `TOOL-DONE-42`
  implication: reference tool lifecycle is visible locally

- timestamp: 2026-05-03T17:22:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-wrapper/tool-lifecycle-basic/remote-final.clean.txt
  found: remote pane still shows prompt and spinner, no tool row, no final answer
  implication: remote tool lifecycle and continuation diverge visibly

- timestamp: 2026-05-03T17:22:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-wrapper/tool-lifecycle-basic/remote-self.diff
  found: only spinner glyph changed between early and settled snapshots
  implication: remote pane stayed stuck in pre-result state

## Resolution

root_cause:
fix:
verification:
files_changed: []
