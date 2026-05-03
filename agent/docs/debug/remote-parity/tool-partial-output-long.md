---
status: investigating
trigger: "Use one shell tool call. Run bash -lc 'for i in 1 2 3 4 5; do echo TOOL-PART-77-$i; sleep 1; done'. Then answer TOOL-PART-DONE-77 only."
created: 2026-05-03T18:58:00Z
updated: 2026-05-03T20:01:00Z
---

## Current Focus

hypothesis: remote projection drops paced tool partial output entirely before any visible tool row or final continuation reaches TUI
test: compare mid-run and settled snapshots for a paced shell tool with unique line markers and unique final answer marker
expecting: local should show incremental `TOOL-PART-77-*` lines and line-count updates; remote may remain idle or spinner-only
next_action: inspect remote tool-event replay/projection path shared with earlier tool lifecycle failures

## Symptoms

expected: standalone local Pi shows incremental tool output over time, then final `TOOL-PART-DONE-77`
actual: local mid-run pane shows partial tool output and line-count progress; remote mid/final panes stay idle with no prompt, tool row, or final marker
errors: none
reproduction: boot paired tmux panes, wait for `ctx `, send paced shell-tool prompt to both panes, capture at ~4s and ~14s
started: audit run 2026-05-03

## Eliminated

- hypothesis: prompt itself was invalid or failed locally too
  evidence: local mid-run and final snapshots show tool row, incremental lines, and final answer marker
  timestamp: 2026-05-03T20:01:00Z

## Evidence

- timestamp: 2026-05-03T18:58:00Z
  checked: docs/debug/remote-parity/tool-lifecycle-basic.md and docs/debug/remote-parity/tool-failure-visible.md
  found: remote already drops visible tool lifecycle and tool failure surfaces in simpler cases
  implication: partial long tool output scenario is likely blocked on same remote rendering family, but still needs direct evidence

- timestamp: 2026-05-03T20:01:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch25/tool-partial-output-long/local-mid.clean.txt
  found: local pane shows `▏$ Runs requested loop command`, `TOOL-PART-77-1`, and `↳ 1 line so far (0s)`
  implication: standalone local Pi visibly streams partial tool output

- timestamp: 2026-05-03T20:01:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch25/tool-partial-output-long/local-self.diff
  found: local mid-to-final diff advances from partial row to `· ok took 5s (5 lines)` and final answer `TOOL-PART-DONE-77`
  implication: local tool surface appends incrementally, then completes normally

- timestamp: 2026-05-03T20:01:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch25/tool-partial-output-long/local.log
  found: local log records `TOOL-PART-77-1` through `TOOL-PART-77-5` with successive `↳ N lines so far` updates
  implication: partial-output behavior is deterministic and strong enough for parity reference

- timestamp: 2026-05-03T20:01:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch25/tool-partial-output-long/remote-client-mid.clean.txt
  found: remote pane stays idle with `What should I align?` and no prompt or tool markers
  implication: remote misses even initial visible tool execution state

- timestamp: 2026-05-03T20:01:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch25/tool-partial-output-long/remote-client-final.clean.txt
  found: remote pane still shows idle chrome with only prompt text variation, no `TOOL-PART-77-*` or `TOOL-PART-DONE-77`
  implication: remote never projects partial tool stream or final continuation

- timestamp: 2026-05-03T20:01:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch25/tool-partial-output-long/remote-self.diff
  found: only idle placeholder text changes between mid and final remote snapshots
  implication: remote pane remained stuck in pre-command state

## Resolution

root_cause:
fix:
verification:
files_changed: []
