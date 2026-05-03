---
status: investigating
trigger: "Write lines QFA-71-1 through QFA-71-120, one per line, no extra text. Then send follow-up: After current response finishes, reply QFA-FOLLOWUP-71 only."
created: 2026-05-03T18:10:00Z
updated: 2026-05-03T18:10:00Z
---

## Current Focus

hypothesis: remote loses active-run projection before queued follow-up state can render
test: compare same interaction in both panes while injecting follow-up during active run
expecting: local shows queued/steering surface; remote may stay idle or miss queue state entirely
next_action: inspect remote live-state patch path for queued steering and follow-up arrays

## Symptoms

expected: standalone local Pi shows active run plus visible queued follow-up state during streaming
actual: local pane shows `Steering: After current response finishes, reply QFA-FOLLOWUP-71 only.` while remote settled pane returns to idle prompt with no run or queue markers
errors: none
reproduction: boot paired tmux panes, wait for `ctx `, start long streamed prompt, send follow-up 2s later
started: audit run 2026-05-03

## Eliminated

- hypothesis: local also failed to accept queued follow-up
  evidence: local log and final pane show steering line and queued edit hint
  timestamp: 2026-05-03T18:10:00Z

## Evidence

- timestamp: 2026-05-03T18:10:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch8/queue-followup-active/local-final.clean.txt
  found: local pane shows `Steering: After current response finishes, reply QFA-FOLLOWUP-71 only.` and `↳ Alt+Up to edit all queued messages`
  implication: reference queue/follow-up state is visibly rendered locally

- timestamp: 2026-05-03T18:10:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch8/queue-followup-active/remote-final.clean.txt
  found: remote pane only shows idle prompt chrome such as `What should I simplify?`
  implication: remote missed active run and queued follow-up visible state

- timestamp: 2026-05-03T18:10:00Z
  checked: .pi/remote-e2e/pi-remote-e2e-batch8-queue/logs/local-pi.log
  found: local log records prompt, follow-up injection, and repeated steering surface updates
  implication: divergence is not capture timing noise on local side

## Resolution

root_cause:
fix:
verification:
files_changed: []
