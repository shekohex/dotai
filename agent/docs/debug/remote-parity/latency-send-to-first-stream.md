---
status: resolved
trigger: "Count from 1 to 100, one per line, no extra text."
created: 2026-05-03T17:22:00Z
updated: 2026-05-03T17:22:00Z
---

## Current Focus

hypothesis: remote first visible stream activity is at least as fast as local when measured with unique streamed markers
test: rerun with unique `STREAM-ALPHA-73-*` lines and compare time to first streamed line
expecting: if true, both panes show incremental numbered lines and remote/local first-stream timing stays comparable
next_action: use same prompt style for `streaming-first-token`

## Symptoms

expected: standalone local Pi should surface first streamed assistant content quickly; remote should match closely
actual: corrected measurement shows remote first stream at 10136ms vs local 15187ms, and both panes render full 20-line stream
errors: none
reproduction: boot paired tmux panes, submit count prompt, wait on marker `1`
started: audit run 2026-05-03

## Eliminated

- hypothesis: first-stream timing already validated by earlier numeric run
  evidence: marker `1` existed in prompt content before assistant stream
  timestamp: 2026-05-03T17:22:00Z

## Evidence

- timestamp: 2026-05-03T17:22:00Z
  checked: .pi/remote-e2e/audit-2026-05-03/latency-send-to-first-stream/timing.txt
  found: remote_ms=40 local_ms=42
  implication: measurement likely captured prompt echo

- timestamp: 2026-05-03T17:40:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch5/latency-send-to-first-stream/timing.txt
  found: remote_first_stream_ms=10136 local_first_stream_ms=15187
  implication: unique-marker measurement shows no remote-first-stream penalty in this case

- timestamp: 2026-05-03T17:22:00Z
  checked: .pi/remote-e2e/audit-2026-05-03/latency-send-to-first-stream/local.clean.txt
  found: local settled pane contains visible numeric stream
  implication: scenario viable after marker fix

- timestamp: 2026-05-03T17:40:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch5/latency-send-to-first-stream/remote-final.clean.txt and local-final.clean.txt
  found: both panes show `STREAM-ALPHA-73-1` through `STREAM-ALPHA-73-20`
  implication: visible first-stream and final-stream parity confirmed for this prompt

## Resolution

root_cause: none observed
fix:
verification: unique streamed marker run shows both panes render full 20-line stream; remote first marker did not lag local
files_changed: []
