---
status: investigating
trigger: "Summary or compacted-history surface if visible"
created: 2026-05-03T18:58:00Z
updated: 2026-05-03T19:05:55Z
---

## Current Focus

hypothesis: `/compact` is deterministic, but remote fails to preserve enough transcript state to open compaction summary when local does
test: send one simple prompt, then run `/compact` in both panes and compare visible compaction summary surface
expecting: local and remote should both render compaction summary or both reject compaction for same reason
next_action: group with remote transcript/live-state loss family; rerun after a scenario with proven remote transcript entries

## Symptoms

expected: visible summary surface and navigation
actual: local renders `[compaction]` summary card with compacted token count; remote shows `Nothing to compact (no messages yet)`
errors: none
reproduction: boot paired tmux panes, send `Reply exactly COMPACT-41.`, wait, run `/compact`
started: audit run 2026-05-03

## Eliminated

- hypothesis: no deterministic visible summary path exists
  evidence: `/compact` reliably triggers visible compaction result locally
  timestamp: 2026-05-03T19:05:55Z

## Evidence

- timestamp: 2026-05-03T18:58:00Z
  checked: docs/remote-parity-audit-spec.md
  found: summary surface is required scenario but no deterministic harness prompt has been recorded yet
  implication: scenario remains uncovered pending UI-path discovery

- timestamp: 2026-05-03T19:05:55Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch16/compact/local-compact.clean.txt
  found: local pane shows two `[compaction]` summary cards and `Compacted from 7,808 tokens`
  implication: standalone local Pi exposes visible compaction summary surface

- timestamp: 2026-05-03T19:05:55Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch16/compact/remote-compact.clean.txt
  found: remote pane shows `Warning: Nothing to compact (no messages yet)`
  implication: remote did not retain enough visible session history to match local summary behavior

## Resolution

root_cause:
fix:
verification: paired `/compact` run diverges; local summary surface exists, remote falls back to no-messages warning
files_changed: []
