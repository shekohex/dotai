# Goal

Fix remote parity bugs one by one using the parity audit artifacts in `docs/debug/remote-parity/` as the source of truth. Start with highest-leverage bug families first, implement the smallest correct fix, verify it, then move to the next bug.

# Success criteria

- Each fix is driven by one or more existing parity debug files.
- For each bug family, identify exact failing code path before editing.
- Implement the smallest change that closes the observed gap.
- Re-run the most relevant targeted verification first.
- Update or add automated tests when the bug is reproducible in unit/integration tests.
- Re-run parity scenario commands or equivalent focused checks when feasible.
- Keep a running checklist of fixed, still failing, and blocked items.
- Do not stop at analysis if a safe code change is possible.

# Constraints

- Do not rewrite the audit files except to update them after a verified fix.
- Do not broaden scope into refactors unless required for the fix.
- Prefer existing repo patterns, Hono RPC, TypeBox validation, and current session/runtime architecture.
- No backward-compatibility work unless the fix requires it.
- If multiple bugs share one root cause, fix root cause once and validate against all linked scenarios.
- Treat standalone local Pi behavior as reference unless evidence in the repo proves otherwise.

# Inputs

Use these artifacts:

- `docs/debug/remote-parity/index.md`
- all scenario files in `docs/debug/remote-parity/`
- `docs/remote-parity-audit-spec.md`
- `docs/remote-event-sync-architecture.md`
- `QA.md`

Prioritize these bug families in order:

1. remote transcript / render / restore loss
   - `prompt-submit-basic`
   - `streaming-first-token`
   - `streaming-long-response`
   - `streaming-visible-status`
   - `tool-lifecycle-basic`
   - `tool-partial-output-long`
   - `queue-steer-active`
   - `queue-followup-active`
   - `queue-clear`
   - `interrupt-active-run`
   - `interrupted-state-visible`
   - `reconnect-mid-stream`
   - `session-continue`
   - `summary-surface`
   - `latency-send-to-ack`
2. session history / catalog bugs
   - `session-switch`
   - `session-fork`
   - `session-clone`
   - `tree-navigation` blocked branch-load half
3. command / custom surface bugs
   - `extension-ui-request-response`
   - `extension-custom-events`
   - `model-change`
   - `header-footer-status-sync`
4. blocked / weak scenarios after root-cause fixes
   - `tool-lifecycle-multi-tool`
   - `detach-reattach-repeat`
   - `fanout-live`
   - `transport-auth-server-error`

# How to run the bugs

Use the tmux harness as the visible source of truth.

## Harness commands

- bring up paired environment:
  - `PI_REMOTE_E2E_SESSION=<name> PI_REMOTE_E2E_PORT=<port> PI_REMOTE_E2E_REMOTE_URL=http://127.0.0.1:<port> scripts/remote-e2e-direct-tmux.sh up`
- inspect pane/log state:
  - `... scripts/remote-e2e-direct-tmux.sh status`
- wait for TUI ready:
  - `... scripts/remote-e2e-direct-tmux.sh wait-contains remote-client 'ctx '`
  - `... scripts/remote-e2e-direct-tmux.sh wait-contains local 'ctx '`
- send prompt:
  - `... scripts/remote-e2e-direct-tmux.sh send-remote '<prompt>'`
  - `... scripts/remote-e2e-direct-tmux.sh send-local '<prompt>'`
- send raw keys:
  - `... scripts/remote-e2e-direct-tmux.sh send-remote-keys <keys...>`
  - `... scripts/remote-e2e-direct-tmux.sh send-local-keys <keys...>`
- capture panes:
  - `... scripts/remote-e2e-direct-tmux.sh capture-clean remote-client`
  - `... scripts/remote-e2e-direct-tmux.sh capture-clean local`
  - `... scripts/remote-e2e-direct-tmux.sh capture-clean remote-server`
- restart remote client with `--continue`:
  - `... scripts/remote-e2e-direct-tmux.sh restart-remote`
- restart remote server:
  - `... scripts/remote-e2e-direct-tmux.sh restart-server`
- start extra attached remote client:
  - `... scripts/remote-e2e-direct-tmux.sh start-extra-remote`
- tear down:
  - `... scripts/remote-e2e-direct-tmux.sh teardown`

Use distinct session names and ports per run, for example:

- `PI_REMOTE_E2E_SESSION=fix-streaming`
- `PI_REMOTE_E2E_PORT=3191`
- `PI_REMOTE_E2E_REMOTE_URL=http://127.0.0.1:3191`

## Existing scripted scenarios

These are useful for quick smoke checks before or after a fix:

- `scripts/remote-e2e-scenarios.sh list`
- `scripts/remote-e2e-scenarios.sh run normal`
- `scripts/remote-e2e-scenarios.sh run large-stream`
- `scripts/remote-e2e-scenarios.sh run hot-bash`
- `scripts/remote-e2e-scenarios.sh run reconnect-mid-stream`
- `scripts/remote-e2e-scenarios.sh run reconnect-after-completion`
- `scripts/remote-e2e-scenarios.sh run restart-recovery`
- `scripts/remote-e2e-scenarios.sh run queue-interrupt`
- `scripts/remote-e2e-scenarios.sh run fork`
- `scripts/remote-e2e-scenarios.sh run switch-session`
- `scripts/remote-e2e-scenarios.sh run extension-ui`
- `scripts/remote-e2e-scenarios.sh run clone`
- `scripts/remote-e2e-scenarios.sh run extra-attach`
- `scripts/remote-e2e-scenarios.sh run fanout`

## Scenario-to-repro map

Use these exact prompts or flows first because they already produced evidence:

### Transcript / render / restore loss

- `prompt-submit-basic`
  - prompt: `Reply SUBMIT-BASIC-88 only.`
- `streaming-first-token`
  - prompt: use existing marker flow from debug file; preserve unique `FIRST-TOKEN-88-*` markers
- `streaming-long-response`
  - prompt: use existing long numbered-stream prompt from debug file
- `streaming-visible-status`
  - prompt: use status-surface prompt from debug file, then compare footer/header changes
- `tool-lifecycle-basic`
  - prompt: `Use one shell tool call. Run printf "TOOL-UNIQ-42\n". Then answer TOOL-DONE-42 only.`
- `tool-partial-output-long`
  - prompt: `Use one shell tool call. Run bash -lc 'for i in 1 2 3 4 5; do echo TOOL-PART-77-$i; sleep 1; done'. Then answer TOOL-PART-DONE-77 only.`
- `queue-steer-active`
  - start long stream from debug file, then send steer instruction during run
- `queue-followup-active`
  - start active run, then queue `QFA-FOLLOWUP-71`
- `queue-clear`
  - start active run, queue follow-up, then clear with normal TUI path
- `interrupt-active-run`
  - start long count run, interrupt via normal TUI path
- `interrupted-state-visible`
  - run `INTR-98-*` flow from debug file, then interrupt
- `reconnect-mid-stream`
  - prompt: `Write numbers 1 through 200, one per line, no extra text.`
  - restart remote mid-stream with `restart-remote`
- `session-continue`
  - `/name CONTINUE-NAME-66`
  - restart remote with `restart-remote`
  - `/session`
- `summary-surface`
  - submit one prompt
  - run `/compact`
- `latency-send-to-ack`
  - prompt: `Reply ACK-LAT-27 only.`
  - capture baseline, send prompt, detect first diff, then settled panes

### Session history / catalog

- `session-switch`
  - `/name FIRST-SESSION-11`
  - `/new`
  - `/name SECOND-SESSION-22`
  - `/resume`
- `session-fork`
  - submit one prompt
  - `/fork`
- `session-clone`
  - submit one prompt
  - `/clone`
- `tree-navigation`
  - prompt-seeded surface:
    - `Reply TREE-NAV-31 only.`
    - `/tree`
  - branch-load half depends on fixing `session-fork` / `session-switch`

### Command / custom surfaces

- `extension-ui-request-response`
  - use existing stash-entry selection flow from debug file
- `extension-custom-events`
  - `/openusage status`
- `model-change`
  - `/model`
- `header-footer-status-sync`
  - `/tps on`

### Blocked / weaker deterministic cases

- `tool-lifecycle-multi-tool`
  - existing prompt did not produce reliable local multi-tool execution; revisit after basic tool render fix
- `detach-reattach-repeat`
  - `Reply REATTACH-99 only.`
  - restart remote three times with `restart-remote`
- `fanout-live`
  - attach extra remote client, then send `Reply with FANOUT-88 only.`
- `transport-auth-server-error`
  - remote-only startup against bad origin; see debug file for captured failure shape

## Repro discipline

- Reuse exact markers from debug files unless there is a strong reason to change them.
- When changing a prompt, use a new unique marker and record it.
- Save captures under a fresh `.pi/remote-e2e/<run>` path for every rerun.
- Compare remote client pane to local pane under same prompt or same key flow.
- Treat remote server logs as supporting evidence, not source of truth.

# Validation

After each code change, run the most relevant checks available:

- targeted tests for changed behavior
- remote runtime / sync tests if affected
- parity harness scenario rerun when feasible
- then repo gates:
  - `npm run typecheck`
  - `timeout 120s npm test`
  - `npm run lint`
  - `npm run format:check`

If a gate fails for unrelated existing reasons, say so precisely and continue only if the change-specific validation is strong.

# Stop rules

- Stop and report when a bug is fixed and verified, then continue to next bug in later turn.
- Stop and ask only if a fix requires a product decision or missing external information.
- If a scenario remains blocked because there is no local analogue or no visible tmux path, mark it explicitly and move on.
