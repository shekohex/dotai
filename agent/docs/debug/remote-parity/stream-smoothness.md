---
status: investigating
trigger: "Use long streamed response or high-output bash/tool case"
created: 2026-05-03T18:58:00Z
updated: 2026-05-03T20:07:00Z
---

## Current Focus

hypothesis: smoothness is runtime-domain specific; bash streaming is healthy, but assistant and tool partial streams are missing or burst-collapsed remotely
test: aggregate prior assistant, bash, and long partial-tool evidence
expecting: bash should remain parity while assistant/tool domains diverge
next_action: no separate rerun needed unless a single mixed-domain comparison is required later

## Symptoms

expected: smooth incremental updates in both remote and local
actual: bash hot/large output reached parity, but assistant long-stream and long partial-tool scenarios diverged with remote stuck or idle
errors: none
reproduction: see prior bash and streaming debug files
started: audit run 2026-05-03

## Eliminated

- hypothesis: all stream classes are uniformly broken remotely
  evidence: bash-stream-hot-output and bash-stream-large-output reached parity
  timestamp: 2026-05-03T18:58:00Z

## Evidence

- timestamp: 2026-05-03T18:58:00Z
  checked: docs/debug/remote-parity/bash-stream-hot-output.md and bash-stream-large-output.md
  found: high-frequency and sustained bash output reached parity
  implication: remote can stream smoothly in some runtime domains

- timestamp: 2026-05-03T18:58:00Z
  checked: docs/debug/remote-parity/streaming-long-response.md and streaming-visible-status.md
  found: assistant streaming scenarios remain visibly divergent
  implication: smoothness gap is domain-specific, not universal

- timestamp: 2026-05-03T20:07:00Z
  checked: docs/debug/remote-parity/tool-partial-output-long.md
  found: local tool stream shows `TOOL-PART-77-1..5` with `↳ N lines so far`, while remote stays idle with no visible tool stream
  implication: smoothness gap also affects long partial tool output, not only assistant prose streaming

## Resolution

root_cause:
fix:
verification:
files_changed: []
