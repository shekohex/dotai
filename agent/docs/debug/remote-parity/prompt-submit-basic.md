---
status: investigating
trigger: "Reply with PROMPT-SUBMIT-BASIC only."
created: 2026-05-03T17:22:00Z
updated: 2026-05-03T17:22:00Z
---

## Current Focus

hypothesis: remote may accept submit request but fail to ever render prompt or final answer in some fresh sessions
test: rerun with unique final marker `SUBMIT-BASIC-88` and compare settled remote/local panes
expecting: if true, local shows answer while remote remains at idle prompt with no marker
next_action: correlate with other remote no-render scenarios and session boot state

## Symptoms

expected: standalone local Pi accepts prompt immediately and shows first in-progress state before final answer
actual: fresh rerun shows local completed `SUBMIT-BASIC-88`; remote settled pane remains at idle prompt with no prompt echo or answer
errors: none
reproduction: boot paired tmux panes, submit trigger prompt in both panes
started: audit run 2026-05-03

## Eliminated

- hypothesis: current timing file proves first acknowledgement latency
  evidence: marker is final answer text, not first visible ack
  timestamp: 2026-05-03T17:22:00Z

## Evidence

- timestamp: 2026-05-03T17:22:00Z
  checked: .pi/remote-e2e/audit-2026-05-03/prompt-submit-basic/timing.txt
  found: remote_ms=2046 local_ms=1034 to final matching text
  implication: remote end-to-end slower, but ack-phase parity still unproven

- timestamp: 2026-05-03T17:22:00Z
  checked: .pi/remote-e2e/audit-2026-05-03/prompt-submit-basic/remote-client.clean.txt and local.clean.txt
  found: both panes show submitted prompt and spinner phrase
  implication: visible acceptance exists in both modes

- timestamp: 2026-05-03T17:54:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch6b/prompt-submit-basic/local-final.clean.txt
  found: local pane shows prompt and final `SUBMIT-BASIC-88`
  implication: reference basic submit path is healthy

- timestamp: 2026-05-03T17:54:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch6b/prompt-submit-basic/remote-final.clean.txt and remote-client.log
  found: remote pane stayed at idle prompt and remote log contains no `SUBMIT-BASIC-88`
  implication: remote submit/render can fail before any visible transcript change

## Resolution

root_cause:
fix:
verification:
files_changed: []
