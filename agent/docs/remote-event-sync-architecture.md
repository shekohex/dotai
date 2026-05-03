# Remote Event Sync Architecture

## Purpose

This document describes remote event sync problem space, current gap areas, and architecture goals for reaching parity with standalone local Pi.

This is not a completion report.

## Current Problem Statement

Remote mode still diverges from standalone local Pi in ways users can see.

Known problem classes include:

- prompt submission feels slower remotely
- client TUI does not always update in real time while server runtime is producing work
- SSE-backed streaming can appear delayed, bursty, or incomplete
- visible feature surface in remote mode is not yet proven feature-complete against standalone local Pi

## Reference Comparison

- Reference behavior: standalone local Pi
- Compared behavior: remote client connected to remote server runtime
- Audit method: side-by-side tmux comparison using:
  - `scripts/remote-e2e-direct-tmux.sh`
  - `scripts/remote-e2e-scenarios.sh`

Detailed scenario catalog lives in [docs/remote-parity-audit-spec.md](/home/coder/dotai/agent/docs/remote-parity-audit-spec.md:1).

## Remote Critical Path

Visible remote behavior depends on this path staying correct and timely:

1. user input reaches remote client
2. remote client sends command over typed RPC path
3. server runtime accepts and executes command
4. server emits session and stream updates
5. SSE transport delivers updates without harmful buffering or loss
6. client reducer updates local projection
7. stock upstream `InteractiveMode` renders new state

Relevant code areas:

- [src/remote/runtime-api/client.ts](/home/coder/dotai/agent/src/remote/runtime-api/client.ts:1)
- [src/remote/routes/session-sync.ts](/home/coder/dotai/agent/src/remote/routes/session-sync.ts:1)
- [src/remote/client/runtime.ts](/home/coder/dotai/agent/src/remote/client/runtime.ts:1)
- [src/remote/client/session.ts](/home/coder/dotai/agent/src/remote/client/session.ts:1)
- [src/remote/session-registry.ts](/home/coder/dotai/agent/src/remote/session-registry.ts:1)

## Divergence Classes To Investigate

### Latency and visible responsiveness

- Enter accepted later than in standalone local Pi
- first visible acknowledgement appears late
- first assistant output appears late
- stream advances in bursts instead of incrementally
- remote UI only becomes correct near completion instead of during execution

### State propagation and ordering

- event ordering differs from standalone local Pi
- partial tool or bash updates arrive stale, collapsed, or missing
- queue, interrupt, retry, or compaction state surfaces late or incorrectly
- reconnect hides earlier live-state drift by rehydrating from later snapshot

### Feature-surface incompleteness

- standalone-visible feature has no remote equivalent
- remote projection omits state `InteractiveMode` expects to read
- extension UI or custom event flow is incomplete
- session, tree, settings, or summary surfaces are missing or materially different

### Failure and recovery behavior

- auth, transport, server restart, or interrupted-run states render worse than standalone local Pi
- multi-client attach/detach behavior causes stale or conflicting visible state

## Architecture Goals

- Every standalone-local-Pi-visible state transition needed by TUI must exist remotely
- Remote client must surface in-progress work with same useful granularity as standalone local Pi
- Remote sync correctness must hold during active execution, not only after snapshot recovery
- Reconnect must preserve usable live truth and make drift obvious, not silently paper over it
- Architecture progress is measured by parity audit evidence, not by implementation intent

## Mapping Audit Findings To Architecture

Use parity audit outcomes to classify likely ownership area:

- send accepted late:
  - command path, auth, server dispatch, or client-side request sequencing
- first token or first tool update late:
  - server emission timing, SSE buffering, or client event application bottleneck
- stream bursty but final output correct:
  - patch granularity, coalescing, sequential processing, or TUI update triggers
- feature visible locally but absent remotely:
  - missing schema, missing patch type, missing mirror state, or missing `InteractiveMode` bridge
- reconnect fixes live drift:
  - live patch path incomplete even if snapshot path is correct

## Expected Outputs From QA

Each distinct divergence should produce or update debug artifact under `docs/debug/remote-parity/` using audit spec template.

Architecture work should then consume those artifacts to:

- identify likely boundary where parity breaks
- cluster repeated symptoms under same root cause when warranted
- keep unresolved gaps visible until verified closed

## Non-Goals

- claiming parity based only on unit or integration tests
- treating snapshot correctness as enough proof of interactive correctness
- assuming current remote feature list is complete without side-by-side validation
- writing executable test implementation in this document
