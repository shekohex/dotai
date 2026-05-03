---
status: investigating
trigger: "Use one shell tool call. Run command nonexistent-cmd-97. Then answer TOOL-FAIL-97 only."
created: 2026-05-03T18:38:00Z
updated: 2026-05-03T18:38:00Z
---

## Current Focus

hypothesis: remote tool failure visibility falls into same no-render family before any tool error surface reaches TUI
test: compare explicit failing shell-tool prompt in both panes using unique nonexistent command marker
expecting: local should show tool failure or at least entered run state; remote may stay idle with no marker
next_action: rerun later with even more deterministic failing tool path if local tool error text stays sparse

## Symptoms

expected: standalone local Pi should visibly enter tool execution and surface command failure or follow-on tool state
actual: local pane shows submitted failing-tool prompt and `ctx 22`; remote pane remains idle with `ctx 0` and no `nonexistent-cmd-97` marker
errors: none visible in settled panes
reproduction: boot paired tmux panes, wait for `ctx `, send explicit failing shell-tool prompt
started: audit run 2026-05-03

## Eliminated

- hypothesis: prompt never reached local pane either
  evidence: local pane shows full failing-tool prompt text
  timestamp: 2026-05-03T18:38:00Z

## Evidence

- timestamp: 2026-05-03T18:38:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch12/tool-failure-visible-rerun/local-final.clean.txt
  found: local pane shows prompt `Use one shell tool call. Run command nonexistent-cmd-97...` and footer `ctx 22`
  implication: local at least entered the requested run path

- timestamp: 2026-05-03T18:38:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch12/tool-failure-visible-rerun/remote-final.clean.txt
  found: remote pane stays at idle chrome with `ctx 0` and no failure marker
  implication: remote again fails before visible tool state or error surface appears

- timestamp: 2026-05-03T18:38:00Z
  checked: .pi/remote-e2e/pi-remote-e2e-batch12-toolfail2/logs/remote-client.log
  found: remote log shows only idle chrome updates, not failing-tool marker
  implication: failure surface never became visible remotely

## Resolution

root_cause:
fix:
verification:
files_changed: []
