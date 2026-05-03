# QA

## Purpose

Remote mode is not done until it matches standalone local Pi for every visible TUI behavior that matters to end users.

This file defines QA goals, evidence rules, and completion bar for remote parity work. It does not define executable tests.

## Reference Behavior

- Reference product: standalone local Pi
- System under test: remote server + remote client Pi
- Primary workflow: run both side-by-side in tmux and compare visible behavior under same prompt or key flow
- Required harness:
  - `scripts/remote-e2e-direct-tmux.sh`
  - `scripts/remote-e2e-scenarios.sh`

## QA Goals

- Confirm remote mode matches standalone local Pi across every visible feature area
- Detect real-time rendering gaps, not only final-state correctness gaps
- Document every divergence as structured debugging artifact instead of loose notes
- Build parity status from terminal evidence, not from code assumptions

## Feature Coverage Requirement

Parity audit must cover every visible feature area, including:

- prompt submission and first visible acknowledgement
- assistant streaming and final render
- visible thinking/progress/status surfaces
- tool start/update/end lifecycle
- bash start/chunk/end lifecycle
- queue, steer, follow-up, clear queue, interrupt
- session create, continue, switch, fork, clone, rename
- reconnect, detach, reattach, extra attach, fanout, restart recovery
- extension UI request/response and custom event surfaces
- model, thinking, settings, theme, resource, header, footer, status sync
- tree navigation, summaries, branch/session history surfaces
- user-visible error handling and interrupted-state handling
- large output, long-running flow, repeated-run stability, and latency-sensitive behavior

Full scenario catalog lives in [docs/remote-parity-audit-spec.md](/home/coder/dotai/agent/docs/remote-parity-audit-spec.md:1).

## Evidence Rules

Each scenario run must compare remote mode against standalone local Pi and capture enough evidence to decide parity or divergence.

Minimum evidence per scenario:

- scenario name
- prompt or interaction used
- remote capture or log path
- standalone local Pi capture or log path
- expected standalone behavior
- observed remote behavior
- parity result or divergence summary

## Debug Artifact Requirement

Every audited scenario must produce or update one debug markdown file under `docs/debug/remote-parity/`.

Use one file per scenario unless distinct bugs require separate files.

Required file format is defined in [docs/remote-parity-audit-spec.md](/home/coder/dotai/agent/docs/remote-parity-audit-spec.md:1) and must use this lifecycle model:

- `status`: current investigation phase
- `Current Focus`: overwrite on each update
- `Symptoms`: immutable after initial gathering
- `Eliminated`: append-only
- `Evidence`: append-only
- `Resolution`: overwrite as understanding evolves

## Completion Bar

Remote parity work is complete only when every scenario in audit spec is either:

- confirmed equivalent to standalone local Pi, or
- linked to debug file with current status and documented next action

Passing unit tests, passing repo gates, or having a plausible architecture is not enough.

## Output Expectations For Future Runs

Any future audit execution should leave behind:

- updated debug files for scenarios exercised
- clear parity vs divergence status
- links to captures and logs
- code pointers when evidence suggests likely ownership area
