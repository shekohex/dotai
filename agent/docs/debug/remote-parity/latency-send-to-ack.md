---
status: investigating
trigger: "Reply with ACK-LATENCY only."
created: 2026-05-03T17:22:00Z
updated: 2026-05-03T20:10:00Z
---

## Current Focus

hypothesis: first visible acknowledgement timing is near-parity, but remote final settled render still lags or was captured pre-answer
test: compare first post-submit pane diff timing using before/after snapshots with unique answer marker, then capture settled panes in same run
expecting: if true, first-diff times stay close while later render path still diverges
next_action: treat ack timing as parity and keep final render divergence under prompt/stream bug family

## Symptoms

expected: standalone local Pi shows first visible acknowledgement quickly after Enter; remote should be close
actual: repeated runs show first visible pane diff equal at 28ms/28ms and 31ms/31ms, but settled remote pane still returns to idle with no prompt echo or answer while local shows `ACK-LAT-27`
errors: none
reproduction: boot paired tmux panes, capture baseline, submit short unique reply prompt, detect first pane diff, then settle and capture final panes
started: audit run 2026-05-03

## Eliminated

- hypothesis: final answer timing equals ack timing
  evidence: first-diff wrapper proved ack timing is separate from final answer timing
  timestamp: 2026-05-03T17:22:00Z

## Evidence

- timestamp: 2026-05-03T17:22:00Z
  checked: .pi/remote-e2e/audit-2026-05-03/latency-send-to-ack/timing.txt
  found: remote_ms=2049 local_ms=1035 to final answer text
  implication: remote slower end-to-end; ack-phase parity still unverified

- timestamp: 2026-05-03T17:40:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch5/latency-send-to-ack/timing.txt
  found: remote_first_diff_ms=28 local_first_diff_ms=28
  implication: first visible acknowledgement timing is effectively parity in this run

- timestamp: 2026-05-03T17:22:00Z
  checked: .pi/remote-e2e/audit-2026-05-03/latency-send-to-ack/remote-client.clean.txt and local.clean.txt
  found: both panes show submitted prompt and spinner surface
  implication: visible work starts in both modes

- timestamp: 2026-05-03T20:10:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch27/latency-send-to-ack/timing.txt
  found: remote_first_diff_ms=31 local_first_diff_ms=31
  implication: repeated first-diff measurement again shows ack-phase parity

- timestamp: 2026-05-03T20:10:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch27/latency-send-to-ack/local-final.clean.txt
  found: local settled pane shows submitted prompt, final `ACK-LAT-27`, and idle footer
  implication: short unique reply prompt is a valid reference for same-run settle capture

- timestamp: 2026-05-03T20:10:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch27/latency-send-to-ack/remote-client-final.clean.txt
  found: remote settled pane returns to idle placeholder with `ctx 0`, no prompt echo or `ACK-LAT-27`
  implication: ack timing can be parity even while final visible render still diverges

## Resolution

root_cause:
fix:
verification:
files_changed: []
