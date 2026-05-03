---
status: investigating
trigger: "Visible settings/theme/resource surfaces"
created: 2026-05-03T18:58:00Z
updated: 2026-05-03T20:13:00Z
---

## Current Focus

hypothesis: settings surface and theme mutation are parity; resource-specific sync lacks a deterministic visible tmux path in current command/UI surface
test: confirm visible `/settings` and theme parity, then search codebase for any user-visible resource mutation path comparable in tmux
expecting: if no visible resource surface exists, theme/settings evidence stands while resource-specific half remains blocked by scenario design
next_action: keep scenario at partial parity unless a concrete visible resource command or menu path is found

## Symptoms

expected: visible settings/theme/resource sync behavior
actual: `/settings` opens in both panes; `Theme` submenu opens in both; selecting `light` returns to settings with `Theme light` in both
errors: none
reproduction: boot paired tmux panes, run `/settings`, type `theme`, Enter, Down, Enter
started: audit run 2026-05-03

## Eliminated

- hypothesis: no deterministic visible settings path exists in tmux harness
  evidence: `/settings` opens selector immediately in both panes
  timestamp: 2026-05-03T19:05:55Z

- hypothesis: resource-specific sync is reachable through same visible settings selector used for theme/thinking
  evidence: code search found settings RPC/resource plumbing and theme-path mutation internals, but no exposed slash-command or visible selector entry for resource paths in current tmux flows
  timestamp: 2026-05-03T20:13:00Z

## Evidence

- timestamp: 2026-05-03T18:58:00Z
  checked: docs/debug/remote-parity/header-footer-status-sync.md
  found: even simple chrome-affecting command handling already diverges remotely
  implication: settings/theme/resource sync may be affected by broader chrome update issues, but direct evidence is still missing

- timestamp: 2026-05-03T19:05:55Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch16/settings/local-settings.clean.txt and .pi/remote-e2e/audit-2026-05-03-batch16/settings/remote-settings.clean.txt
  found: both panes open settings selector with `Auto-compact`, `Auto-resize images`, `Block images`, `Skill commands`, and footer chrome preserved
  implication: base settings surface is parity; scenario is no longer blocked on path discovery

- timestamp: 2026-05-03T19:12:10Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch17/theme-submenu/local-theme-submenu.clean.txt and .pi/remote-e2e/audit-2026-05-03-batch17/theme-submenu/remote-theme-submenu.clean.txt
  found: both panes show `Theme` submenu with `catppuccin-latte`, `catppuccin-mocha`, `dark`, `light`
  implication: theme-selection surface is parity

- timestamp: 2026-05-03T19:12:10Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch17/theme-select/local-theme-select.clean.txt and .pi/remote-e2e/audit-2026-05-03-batch17/theme-select/remote-theme-select.clean.txt
  found: both panes return to settings with `Theme light`
  implication: visible theme mutation is parity; remaining gap is resource sync only

- timestamp: 2026-05-03T20:13:00Z
  checked: `rg` over `src/remote/client/session-settings.ts`, `src/remote/session/registry-state-commands.ts`, and related runtime-sync files
  found: resource/theme sync internals expose `setThemePaths` and resource snapshot plumbing, but current visible tmux-covered commands only surfaced `/settings` theme/thinking controls
  implication: resource-specific sync remains blocked on lack of deterministic visible user path, not lack of backend plumbing evidence

## Resolution

root_cause:
fix:
verification: paired `/settings` and `Theme` runs show matching selector open and matching theme change to `light`
files_changed: []
