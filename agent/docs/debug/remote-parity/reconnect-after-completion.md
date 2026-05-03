---
status: resolved
trigger: "Reply with RECONNECT-AFTER-COMPLETE-77 only."
created: 2026-05-03T17:29:00Z
updated: 2026-05-03T17:29:00Z
---

## Current Focus

hypothesis: remote reconnect after completion restores transcript and idle state closely enough to local
test: complete run in both panes, restart remote client with `--continue`, compare settled snapshots
expecting: if true, remote restored transcript contains final answer and lands in idle state
next_action: use same settle wrapper on detach/reattach repeat

## Symptoms

expected: standalone local Pi shows completed answer and idle prompt; remote reattach should restore same visible session truth
actual: remote reattach restored submitted prompt, final answer, and idle state after restart
errors: none
reproduction: boot paired tmux panes, run simple prompt, restart remote client after completion, wait for restored marker
started: audit run 2026-05-03

## Eliminated

## Evidence

- timestamp: 2026-05-03T17:29:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch2/reconnect-after-completion/remote-final.clean.txt
  found: remote pane after `--continue` shows prompt and `RECONNECT-AFTER-COMPLETE-77`
  implication: remote transcript restoration works for simple completed run

- timestamp: 2026-05-03T17:29:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch2/reconnect-after-completion/local-final.clean.txt
  found: local pane shows same completed answer and idle state
  implication: remote behavior matches local reference closely enough

## Resolution

root_cause: none observed
fix:
verification: stable final remote/local snapshots both show completed marker and idle session after reconnect
files_changed: []
