---
status: investigating
trigger: "Branch/session tree navigation surface if visible"
created: 2026-05-03T18:58:00Z
updated: 2026-05-03T20:13:00Z
---

## Current Focus

hypothesis: `/tree` has parity for single-thread populated sessions; actual branch-load navigation is blocked-by-prior-bug behind broken remote fork/switch surfaces
test: compare populated `/tree` surface, then map missing branch-navigation coverage to existing fork/switch divergences
expecting: populated tree parity can hold even while branch selection remains blocked by upstream session-history bugs
next_action: treat branch-load half as blocked-by-prior-bug on `session-fork` and `session-switch` until remote can create/select comparable branches

## Symptoms

expected: visible tree or branch/session navigation surface
actual: both panes open non-empty `Session Tree` with `user: Reply TREE-NAV-31 only.` and selected `assistant: TREE-NAV-31`
errors: none
reproduction: boot paired tmux panes, send `Reply TREE-NAV-31 only.`, wait, then run `/tree`
started: audit run 2026-05-03

## Eliminated

- hypothesis: no deterministic visible tree command path exists
  evidence: `/tree` opens `Session Tree` selector in both panes
  timestamp: 2026-05-03T19:05:55Z

- hypothesis: current coverage is limited to empty-tree placeholder because remote cannot populate tree content
  evidence: prompt-seeded run shows matching user and assistant entries in both panes
  timestamp: 2026-05-03T19:55:00Z

- hypothesis: actual branch-load navigation can be exercised independently of fork/switch bugs
  evidence: remote already diverges on `/fork` and `/resume`, which are needed to create or select comparable alternate branches
  timestamp: 2026-05-03T20:13:00Z

## Evidence

- timestamp: 2026-05-03T18:58:00Z
  checked: docs/debug/remote-parity/session-fork.md and session-switch.md
  found: related session/tree operations already diverge or remain blocked
  implication: tree-navigation likely intersects same area but still lacks direct scenario evidence

- timestamp: 2026-05-03T19:05:55Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch16/tree4/local-tree.clean.txt and .pi/remote-e2e/audit-2026-05-03-batch16/tree4/remote-tree.clean.txt
  found: both panes open `Session Tree`; both show `No entries found` and current model footer
  implication: tree surface path is parity, but actual navigation coverage is still missing

- timestamp: 2026-05-03T19:55:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch24/tree-navigation/local.clean.txt and remote.clean.txt
  found: both panes show non-empty `Session Tree` with same user row and selected assistant row `(2/2)`
  implication: remote matches local on populated tree surface for single-thread session content

- timestamp: 2026-05-03T20:13:00Z
  checked: docs/debug/remote-parity/session-fork.md and docs/debug/remote-parity/session-switch.md
  found: remote `/fork` says `No messages to fork from`; remote `/resume` picker diverges from local under same setup
  implication: branch-creation and branch-selection prerequisites are already broken remotely, so loaded-branch navigation is currently blocked by prior documented bugs

## Resolution

root_cause:
fix:
verification: paired prompt-seeded `/tree` run shows matching populated tree surface in both panes
files_changed: []
