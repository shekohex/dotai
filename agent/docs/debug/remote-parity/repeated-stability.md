---
status: investigating
trigger: "Repeat representative scenarios several times"
created: 2026-05-03T18:58:00Z
updated: 2026-05-03T19:19:42Z
---

## Current Focus

hypothesis: already-deterministic scenarios keep same parity/divergence shape across fresh sessions
test: repeat multi-turn prompt, paced bash, and theme-selection flow across 3 fresh tmux sessions
expecting: same visible outcomes each run; no worsening stale state between runs
next_action: extend repeat campaign later to one known-divergent transcript-loss scenario

## Symptoms

expected: consistency across repeated runs
actual: 3 fresh runs kept theme-selection parity; remote logs retained repeated multi-turn and bash evidence each run, though settled pane captures sometimes truncated earlier lines
errors: none
reproduction: boot 3 fresh paired sessions, run 2-turn prompt, paced bash loop, then `/settings` -> `theme`
started: audit run 2026-05-03

## Eliminated

- hypothesis: repeated-stability must stay blocked until more scenarios are deterministic
  evidence: 3-run campaign completed on deterministic prompt/bash/theme flows
  timestamp: 2026-05-03T19:19:42Z

## Evidence

- timestamp: 2026-05-03T18:58:00Z
  checked: docs/debug/remote-parity/bash-stream-basic.md, prompt-submit-multi-turn.md, reconnect-after-completion.md
  found: some scenarios are already stable enough to reuse for future repeat campaign
  implication: repeated-stability is feasible later, but direct evidence is still missing

- timestamp: 2026-05-03T19:19:42Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch18/repeated-stability/run1/remote.clean.txt and local.clean.txt
  found: both panes end on `Theme light`; remote settled capture still includes `RPT-T1-1`, `RPT-T2-1`, and bash running surface
  implication: run1 preserved expected repeated behavior

- timestamp: 2026-05-03T19:19:42Z
  checked: .pi/remote-e2e/audit18-r2/logs/remote-client.log and local-pi.log
  found: both logs contain `RPT-T2-2` and ordered `rpt-bash-2-1`..`rpt-bash-2-5`; both pane captures end on `Theme light`
  implication: run2 preserved expected repeated behavior even when settled pane truncated earlier transcript

- timestamp: 2026-05-03T19:19:42Z
  checked: .pi/remote-e2e/audit18-r3/logs/remote-client.log and local-pi.log
  found: both logs contain ordered `rpt-bash-3-1`..`rpt-bash-3-5`; both pane captures end on `Theme light`
  implication: run3 preserved expected repeated behavior

- timestamp: 2026-05-03T19:19:42Z
  checked: .pi/remote-e2e/audit18-r1/logs/remote-client.log and local-pi.log
  found: remote and local both contain repeated prompt/b​ash evidence, but local model did not always obey exact-string prompt literally
  implication: stability campaign measures consistency of remote-vs-local behavior, not prompt purity

## Resolution

root_cause:
fix:
verification:
files_changed: []
