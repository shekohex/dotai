# Remote Parity Audit Spec

## Goal

Run exhaustive side-by-side parity audit between remote mode and standalone local Pi.

This document defines scenarios, evidence requirements, and debug artifact format for future human or agent execution. It does not define executable tests.

## Reference And System Under Test

- Reference behavior: standalone local Pi
- System under test: remote client connected to remote server runtime
- Comparison rule: same prompt or interaction, same expected visible behavior unless explicitly documented otherwise

## Required Harness

- `scripts/remote-e2e-direct-tmux.sh`
- `scripts/remote-e2e-scenarios.sh`

Expected tmux layout:

- remote server pane
- remote client pane
- standalone local Pi pane

## Audit Workflow Goals

For each scenario:

1. start or reuse paired tmux environment
2. drive same prompt, keys, or session action in remote client and standalone local Pi
3. compare visible timing, ordering, in-progress state, and final state
4. capture remote and local evidence
5. create or update debug artifact immediately

Do not write fixes during parity audit. Goal is accurate behavior inventory and bug documentation.

## Prompt-Writing Rules

Use detailed, outcome-first prompts fit for future operator execution.

Each scenario definition should make operator capture:

- exact action to perform
- exact remote pane behavior to observe
- exact standalone local Pi behavior to observe
- what counts as parity
- what counts as divergence
- what evidence to save
- when scenario can stop

Avoid vague instructions like "test streaming". Every scenario must ask concrete comparison question.

## Debug Artifact Location

- directory: `docs/debug/remote-parity/`
- filename convention: `<scenario-slug>.md`
- one scenario per file by default
- split into multiple files only when one scenario reveals clearly distinct bugs

## Debug File Template

```markdown
---
status: gathering | investigating | fixing | verifying | awaiting_human_verify | resolved
trigger: "[verbatim user input]"
created: [ISO timestamp]
updated: [ISO timestamp]
---

## Current Focus

<!-- OVERWRITE on each update - always reflects NOW -->

hypothesis: [current theory being tested]
test: [how testing it]
expecting: [what result means if true/false]
next_action: [immediate next step]

## Symptoms

<!-- Written during gathering, then immutable -->

expected: [what should happen]
actual: [what actually happens]
errors: [error messages if any]
reproduction: [how to trigger]
started: [when it broke / always broken]

## Eliminated

<!-- APPEND only - prevents re-investigating after /new -->

- hypothesis: [theory that was wrong]
  evidence: [what disproved it]
  timestamp: [when eliminated]

## Evidence

<!-- APPEND only - facts discovered during investigation -->

- timestamp: [when found]
  checked: [what was examined]
  found: [what was observed]
  implication: [what this means]

## Resolution

<!-- OVERWRITE as understanding evolves -->

root_cause: [empty until found]
fix: [empty until applied]
verification: [empty until verified]
files_changed: []
```

## Debug File Rules

### Frontmatter

- `status`: overwrite; reflects current phase
- `trigger`: immutable; verbatim user input or operator scenario prompt
- `created`: immutable; set once
- `updated`: overwrite on every change

### Current Focus

- overwrite completely on every update
- always show what is being tested now
- must be enough for another agent to resume after `/new`

### Symptoms

- write during initial gathering
- immutable after gathering complete
- define expected standalone local Pi behavior versus actual remote behavior

### Eliminated

- append only
- record dead hypotheses to prevent repeated investigation

### Evidence

- append only
- keep entries factual and short

### Resolution

- overwrite as understanding evolves
- final state records confirmed root cause, fix, verification, and changed files when relevant

## Size Constraint

Keep debug files focused:

- evidence entries: 1-2 lines each
- eliminated entries: hypothesis plus why it failed
- no narrative prose

If evidence grows very large, check `Eliminated` and split only when findings clearly belong to separate bugs.

## Scenario Catalog

Each scenario below defines goal only. Future execution can use one or more prompts or key sequences as needed, but must preserve comparison intent and evidence contract.

### Prompt Lifecycle

#### `prompt-submit-basic`

- action: submit simple prompt in both panes
- compare:
  - when input is visibly accepted
  - when first acknowledgement appears
  - whether final answer shape matches
- parity requires remote feel and render order to match standalone local Pi closely enough that no obvious lag or missing state is visible

#### `prompt-submit-multi-turn`

- action: submit prompt, wait for completion, submit follow-up in same session
- compare:
  - transcript append order
  - prior context preserved
  - second turn start visibility

#### `prompt-submit-large-input`

- action: submit long prompt in both panes
- compare:
  - input handling
  - acceptance latency
  - no dropped or malformed prompt content

### Real-Time Rendering

#### `streaming-first-token`

- action: use prompt that yields visible streamed output
- compare:
  - time from Enter to first visible assistant content
  - whether remote shows incremental updates instead of waiting for large chunk or completion

#### `streaming-long-response`

- action: use long-answer prompt
- compare:
  - chunk cadence
  - in-progress text growth
  - no burst-only flush near end

#### `streaming-visible-status`

- action: run prompt likely to expose any visible progress or status surfaces
- compare:
  - status/header/footer/progress updates
  - ordering relative to assistant output

### Tool Execution

#### `tool-lifecycle-basic`

- action: run prompt that triggers one tool call
- compare:
  - tool start visibility
  - tool progress visibility
  - tool completion and assistant continuation

#### `tool-lifecycle-multi-tool`

- action: run prompt that triggers multiple tools in one run
- compare:
  - ordering
  - intermediate state transitions
  - no missing tool updates

#### `tool-partial-output-long`

- action: trigger long-running tool output
- compare:
  - partial updates
  - append behavior
  - stale or collapsed output

### Bash Lifecycle

#### `bash-stream-basic`

- action: trigger bash command with visible streamed output
- compare:
  - bash start/chunk/end surfaces
  - chunk smoothness
  - completion cleanup

#### `bash-stream-hot-output`

- action: trigger high-frequency bash output
- compare:
  - live chunk visibility
  - no remote burst collapse
  - no stuck active-state after end

#### `bash-stream-large-output`

- action: trigger longer bash output session
- compare:
  - sustained update correctness
  - no truncation or projection drift

### Queue And Interruption

#### `queue-steer-active`

- action: send second instruction while first run active
- compare:
  - steer behavior
  - queue visibility
  - eventual ordering

#### `queue-followup-active`

- action: queue follow-up during active run
- compare:
  - queued state visibility
  - follow-up execution after active turn

#### `queue-clear`

- action: create queued work, then clear it
- compare:
  - visible queue count/state
  - cleared result

#### `interrupt-active-run`

- action: interrupt active run with normal TUI path
- compare:
  - visible interruption timing
  - final interrupted state
  - no stale running indicators

### Session Operations

#### `session-new`

- action: create new session
- compare:
  - session reset behavior
  - header/title/session metadata updates

#### `session-continue`

- action: continue existing session
- compare:
  - transcript restored
  - prompt resumes in correct session

#### `session-switch`

- action: switch between sessions
- compare:
  - visible session identity changes
  - transcript and state swap correctness

#### `session-fork`

- action: fork current session
- compare:
  - transcript branching behavior
  - active session target after fork

#### `session-clone`

- action: clone target session if exposed
- compare:
  - clone result visibility
  - transcript equivalence and new identity

#### `session-rename`

- action: rename session if visible
- compare:
  - title/header updates
  - persistence after navigation

### Reconnect And Multi-Client

#### `reconnect-mid-stream`

- action: disconnect remote during active streamed response, then reattach
- compare:
  - what remote preserves or rehydrates
  - whether visible state converges back to standalone local Pi expectations

#### `reconnect-after-completion`

- action: disconnect after run completion, then reattach
- compare:
  - restored transcript
  - idle state correctness

#### `detach-reattach-repeat`

- action: repeat attach/detach flow multiple times
- compare:
  - consistency
  - no accumulating stale UI state

#### `extra-attach`

- action: attach second remote client
- compare:
  - initial visible state
  - no crash or broken projection

#### `fanout-live`

- action: run prompt while multiple remote clients attached
- compare:
  - convergence across clients
  - no client lagging or drifting

#### `server-restart-recovery`

- action: restart remote server during or after scenario, then reconnect
- compare:
  - visible interrupted state
  - recovery path
  - usability after restart

### Extension And UI Flows

#### `extension-ui-request-response`

- action: trigger extension UI interaction
- compare:
  - request visibility
  - response handling
  - resulting session state

#### `extension-custom-events`

- action: trigger extension flow with custom event surface if visible
- compare:
  - event ordering
  - durable versus ephemeral visible behavior

### Config And State Sync

#### `model-change`

- action: change model through normal UI path
- compare:
  - visible selected model state
  - persistence through next prompt

#### `thinking-change`

- action: change thinking level if visible
- compare:
  - control state
  - effect on next run surfaces

#### `settings-theme-resource-sync`

- action: exercise visible settings/theme/resource surfaces
- compare:
  - immediate render correctness
  - persistence across navigation or reconnect where applicable

#### `header-footer-status-sync`

- action: exercise flows that change visible chrome
- compare:
  - header/footer/status consistency
  - no stale metadata

### Tree And History Surfaces

#### `summary-surface`

- action: navigate summary or compacted-history surfaces if visible
- compare:
  - summary content visibility
  - navigation correctness

#### `tree-navigation`

- action: navigate branch/session tree surfaces if visible
- compare:
  - selection changes
  - loaded branch correctness

### Error And Recovery Surfaces

#### `tool-failure-visible`

- action: trigger tool failure or invalid operation that surfaces error
- compare:
  - timing and content of visible error
  - no silent failure remotely if standalone local Pi shows error

#### `transport-auth-server-error`

- action: induce remote-only failure path when feasible
- compare:
  - error surfacing
  - recovery affordance
  - stale-state cleanup

#### `interrupted-state-visible`

- action: trigger interrupted runtime domain and inspect UI
- compare:
  - visible interrupted markers
  - eventual recovery behavior

### Performance-Specific Scenarios

#### `latency-send-to-ack`

- action: measure from Enter to first visible acknowledgement
- compare:
  - remote vs standalone local Pi
  - whether delay is obvious or systematic

#### `latency-send-to-first-stream`

- action: measure from Enter to first assistant or tool stream activity
- compare:
  - remote vs standalone local Pi
  - whether delay comes before or after command acceptance

#### `stream-smoothness`

- action: use long streamed response or high-output tool/bash case
- compare:
  - smooth incremental updates
  - burst behavior
  - final-state-only rendering

#### `repeated-stability`

- action: repeat representative scenarios several times
- compare:
  - consistency
  - regression after prior runs
  - no worsening latency or stale UI accumulation

## Scenario Output Contract

Each scenario execution should leave:

- debug file path
- remote capture path
- standalone local Pi capture path
- parity result
- divergence summary if any
- likely ownership area if bug suspected

## Stop Conditions

Stop scenario when one of these is true:

- parity is confirmed with sufficient evidence
- divergence is documented in debug file with next action
- scenario is blocked by prior documented bug and that dependency is recorded

Do not stop with undocumented ambiguity.
