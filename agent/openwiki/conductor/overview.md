# Pi Conductor

`pi conductor` is the repo/project worker that turns GitHub Projects v2 work items into steerable Pi coding sessions. It claims eligible issues, creates an isolated git worktree per run, launches a Pi session visible in Herdr, routes PR/check/comment feedback back to that session, and records lifecycle state in a SQLite store. It is a **separate CLI command surface** (`pi conductor <subcommand>`) that early-exits before the interactive Pi loop — it is _not_ an extension.

This page documents the conductor's config model, command surface, run lifecycle, resilience model, and expression system. Decisions are recorded in the ADR set under `docs/adr/` (52 ADRs); the ubiquitous language is in `CONTEXT.md`. Both are primary sources for this page.

## What it does

A "run" is one Pi session attached to one issue's lifecycle. The conductor:

1. **Scans** configured GitHub Projects v2 items (via `gh`, GitHub CLI first — [ADR 0008](../../docs/adr/0008-github-integration-uses-gh-cli-first.md)).
2. **Claims** a work item when its issue is open, has no merged PR for the planned branch, has the dispatch label, **and** is assigned to the authenticated `gh` account ([ADR 0013](../../docs/adr/0013-dispatch-requires-configurable-label-and-assignee.md)).
3. **Dispatches**: creates a conductor-owned git worktree ([ADR 0010](../../docs/adr/0010-conductor-owns-git-worktrees.md)), writes a prompt artifact, moves the project card to `in_progress`, and launches the Pi session in a Herdr tab.
4. **Reconciles**: watches PR feedback (checks, reviews, comments, statuses), marks reactable feedback with best-effort GitHub reactions, and routes actionable feedback into the running session ([ADR 0037](../../docs/adr/0037-pr-watcher-routes-all-actionable-feedback.md), [ADR 0059](../../docs/adr/0059-feedback-routing-uses-best-effort-reactions.md)).
5. **Completes**: a run is `done` only after its PR merges ([ADR 0029](../../docs/adr/0029-runs-complete-only-after-pr-merge.md)); merged runs can be cleaned up.

## Configuration layers

Conductor config has global, repo-workflow, and CLI layers, merged in that precedence order. All schemas are TypeBox ([ADR 0017](../../docs/adr/0017-global-conductor-config-is-json-under-pi-agent.md), [0018](../../docs/adr/0018-repo-workflow-policy-lives-under-pi.md), [0006](../../docs/adr/0006-configuration-has-global-repo-and-cli-layers.md), [0007](../../docs/adr/0007-cli-workflow-global-config-precedence.md)).

| Layer         | File                                                              | Scope                                                                                | Defined in                                              |
| ------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Global        | `~/.pi/agent/conductor/config.json` (overridable via `stateRoot`) | repos list, polling interval, webhook, stateRoot                                     | `src/conductor/config.ts` `GlobalConductorConfigSchema` |
| Repo workflow | `<repo>/.pi/WORKFLOW.md` frontmatter                              | dispatch label, branch template, status field/options, launch rules, prompt template | `src/conductor/workflow.ts` `WorkflowFrontmatterSchema` |
| CLI           | `pi conductor run … --<key>=<value>`                              | per-invocation overrides                                                             | `src/conductor/commands/parser.ts` `configOverrides`    |

Merge precedence (highest wins), from `mergeRepositoryConfig` (`src/conductor/config.ts`): **CLI overrides > WORKFLOW.md frontmatter > global repo entry > defaults**. `statusOptions` additionally layers over `DEFAULT_STATUS_OPTIONS` (`Draft / Todo / In Progress / Review / Done / Blocked`).

Defaults applied by `resolveRepositoryConfig`: `dispatchLabel = "ready-for-agent"`, `branchTemplate = "pi/${{ github.issue.number }}-${{ github.issue.slug }}"`, `worktreeRoot = <stateRoot>/worktrees/<owner>/<repo>`, `statusField = "Status"`, `effortField = "Effort"`, `priorityField = "Priority"`.

Quick start:

```bash
pi conductor config init        # upsert current repo into config.json, write schema + .pi/WORKFLOW.md
pi conductor config validate    # check config + gh auth + repo access + branch template
pi conductor serve              # foreground polling (+webhook if configured)
```

`config init` is idempotent and safe to rerun: it migrates config structure, preserves repo-specific settings, and upserts the current GitHub repo. To manage more repositories, run it from each checkout. Config automation commands (`config get/set/format/edit`) operate on the global config via dot/bracket paths (e.g. `repositories[0].project.number`).

## Command surface

Routed by `src/conductor/commands/parser.ts` → `runConductorCommand` (`src/conductor/command.ts`). All commands exit with a process code; stateful commands open the SQLite store.

| Command                                         | Purpose                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config init\|validate\|format\|edit\|get\|set` | Manage `config.json` (see layers above).                                                                                                                                                                                                                                                                                                                                             |
| `serve`                                         | Foreground supervisor: webhook server + polling loop + hot config reload.                                                                                                                                                                                                                                                                                                            |
| `daemon start\|stop\|restart\|status`           | Local background helper (pid/log/err files under `<stateRoot>/daemon`).                                                                                                                                                                                                                                                                                                              |
| `reconcile`                                     | One-shot scan + dispatch of eligible work items.                                                                                                                                                                                                                                                                                                                                     |
| `run <owner/repo#N>`                            | Manual dispatch; bypasses eligibility ([ADR 0043](../../docs/adr/0043-manual-run-bypasses-eligibility.md)). Accepts multiple refs, `--mode-*` launch flags, and `--<key>=<value>` overrides.                                                                                                                                                                                         |
| `status` / `runs`                               | List runs as a human table (`--json` for JSON).                                                                                                                                                                                                                                                                                                                                      |
| `logs <run-id>`                                 | Run event log (JSONL) from `<stateRoot>/runs/...`.                                                                                                                                                                                                                                                                                                                                   |
| `send <run-id> "<msg>"`                         | Send a message to the session. Default delivery is `steer` (real-time); `--follow-up` queues until the session is idle ([ADR 0026](../../docs/adr/0026-send-queues-by-default-with-explicit-delivery-overrides.md), [0027](../../docs/adr/0027-follow-ups-use-herdr-idle-gate.md)).                                                                                                  |
| `stop\|pause\|resume\|retry <run-id>`           | Lifecycle controls. `stop` cleans worktree + local branch ([ADR 0024](../../docs/adr/0024-stop-cleans-worktree-and-local-branch.md)); `pause` stops automation, not the Pi process ([ADR 0023](../../docs/adr/0023-pause-stops-automation-not-pi.md)); `retry` starts a new attempt on the same branch ([ADR 0025](../../docs/adr/0025-retry-starts-new-attempt-on-same-branch.md)). |
| `cleanup <run-id>\|--merged\|--failed`          | Remove worktrees/branches. `--merged` cleans completed merged runs and deletes remote branches ([ADR 0019](../../docs/adr/0019-merged-runs-delete-worktrees.md)); `--failed` cleans blocked runs with local cleanup semantics.                                                                                                                                                       |
| `cleanup gc [--older-than-days N] [--vacuum]`   | Delete old events/deliveries, WAL checkpoint, optional VACUUM.                                                                                                                                                                                                                                                                                                                       |
| `help [topic]` / `completion bash\|zsh`         | Help text and shell completion scripts.                                                                                                                                                                                                                                                                                                                                              |

## Run lifecycle

Lifecycle statuses (`src/conductor/store/types.ts` `LifecycleStatusSchema`): `draft`, `ready`, `in_progress`, `in_review`, `done`, `blocked`. A status is "active" unless `done`/`blocked` (`isActiveLifecycleStatus`). The conductor maps these to configurable GitHub Project status options via `statusOptions`.

The dispatch flow (`orchestrator.ts` `dispatchWorkItem`):

1. Load repo runtime (config + WORKFLOW.md), validate same-repo.
2. `worktrees.plan(...)` derives branch (from `branchTemplate`) + worktree path + base ref.
3. Reject if an active run already exists for that issue (idempotency — [ADR 0032](../../docs/adr/0032-sqlite-enforces-dispatch-idempotency.md)).
4. `selectLaunchFlags` from ordered launch rules (unless manual flags given).
5. `createRun` in the store; move project card to `in_progress`.
6. Prepare worktree, render + write the prompt artifact, launch the Herdr session.

`reconcile` (`reconcileOnce`) scans each managed repo's project items, filters by eligibility (open issue + no merged PR for the planned branch + `dispatchLabel` + assignee), blocks stale active runs for closed project items only when their branch has no merged PR, and dispatches the rest. `reconcileActiveRuns` re-scopes to live PR feedback and updates run status (e.g. `in_review`, `done` on merge, `blocked`). PR association is branch-first ([ADR 0028](../../docs/adr/0028-pr-association-is-branch-first.md)). Human project-card moves do not stop a run ([ADR 0044](../../docs/adr/0044-human-project-moves-do-not-stop-runs.md)).

### Run IDs and branches

Run IDs (`src/conductor/run-id.ts` `createRunId`): `<owner>__<repo>__<issue>__<uuidv7>` — a human-readable prefix plus a UUIDv7 timestamp ([ADR 0051](../../docs/adr/0051-run-ids-combine-human-prefix-and-uuidv7.md)). Branches render from `branchTemplate` using the same `${{ }}` expression engine as prompts ([ADR 0012](../../docs/adr/0012-branch-names-use-repo-configurable-templates.md)). Legacy `{issue}`/`{slug}` placeholders are **not** supported.

## Webhook + polling resilience

`serve` runs a webhook server (when configured) **and** a polling loop as a safety net ([ADR 0015](../../docs/adr/0015-webhooks-and-polling-ship-together.md), [0016](../../docs/adr/0016-webhook-listener-is-configured-explicitly.md)).

GitHub operations shell out through `gh` with bounded command timeouts. A reconcile error showing `timeout: ...ms (process killed)` and `signal: SIGTERM` means Conductor killed a stuck `gh` child after the configured timeout; empty stdout/stderr is normal for that failure mode.

- **Webhook** (`src/conductor/webhook.ts`): GitHub gets an HTTP response only after the delivery is durably recorded in SQLite — _before_ reconcile work runs. Supported events: `issues`, `issue_comment`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `check_run`, `check_suite`, `status`, `workflow_run`, `projects_v2_item`. Delivery IDs dedupe retries; failures retry with exponential backoff; GitHub rate-limit errors back off ~15 min (`rate-limit.ts` `GITHUB_RATE_LIMIT_BACKOFF_MS`). Unknown events are ACKed and ignored.
- **Crash recovery**: on startup, `processPendingWebhookDeliveries` replays deliveries left in `received`/`processing`.
- **Polling** (`startPolling`): avoids overlapping reconcile runs, respects `pollingIntervalSeconds` (default 60, [ADR 0038](../../docs/adr/0038-polling-interval-has-config-with-default.md)), and backs off on rate-limit errors. Webhooks narrow reconcile scope to the affected repo/issue/PR/item.
- **Hot reload** (`createConfigReloader`): watches `config.json` and each repo's `.pi/WORKFLOW.md`; on change reloads config, revalidates, swaps polling/webhook, and re-reconciles. Changing `stateRoot` requires a restart.

GitHub webhook setup:

| GitHub field     | Value                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| Payload URL      | Public HTTPS URL ending with configured `webhook.path`, e.g. `https://agent.example.com/github/webhook` |
| Content type     | `application/json`                                                                                      |
| Secret           | Same value as `webhook.secret` env/file; Conductor verifies `X-Hub-Signature-256`                       |
| SSL verification | Enable SSL verification                                                                                 |
| Events           | Let me select individual events                                                                         |
| Active           | Checked                                                                                                 |

Select these individual events in GitHub: Issues, Issue comments, Pull requests, Pull request reviews, Pull request review comments, Check runs, Check suites, Statuses, and Workflow runs. Repository webhooks usually do not show a “Projects v2 items” checkbox. Conductor supports `projects_v2_item` when a webhook source exposes it, but polling remains the safety net for project-only changes such as status/field updates. Do not choose “Just the push event”; Conductor ignores push events. “Send me everything” is safe but noisy because unsupported events are ACKed and ignored.

## Workflow expressions and launch rules

The prompt template (WORKFLOW.md body) and `branchTemplate` use GitHub-Actions-style `${{ }}` expressions, evaluated by `src/conductor/expression.ts` ([ADR 0049](../../docs/adr/0049-workflow-prompts-use-github-expression-placeholders.md)). HTML comments (`<!-- … -->`) are stripped from the body before the prompt is sent, so repos keep inline notes/examples out of the live prompt.

Contexts: `github.repository`, `github.issue.{number,title,body,url,labels,assignees}`, `github.project.{status,priority,effort,fields}`, `conductor.{branch,baseRef,worktreePath,runId}`, plus `env.NAME` (process env), `vars.NAME` (`PI_CONDUCTOR_VAR_NAME`), `secrets.NAME` (`PI_CONDUCTOR_SECRET_NAME` — use intentionally; values enter the prompt).

Supported: dot/bracket paths, indexes, object filters (`.*.name`), functions (`contains`, `startsWith`, `endsWith`, `join`, `format`, `toJSON`, `fromJSON`, `hashFiles`, `success`/`failure`/`cancelled`/`always`), comparison + boolean operators, and bare `if:` expressions ([ADR 0048](../../docs/adr/0048-launch-rules-use-github-actions-like-expressions.md)).

**Launch rules** (`WorkflowFrontmatterSchema` `launchRules`) are an ordered list of `{ if, flags }`. `selectLaunchFlags` picks the first rule whose `if` matches the work item and returns its `flags` as Pi launch flags (e.g. `--mode-deep`); manual `run --mode-*` flags override ([ADR 0021](../../docs/adr/0021-pi-launch-flags-come-from-ordered-rules.md)).

**Follow-Up Rules** (`followUpRules`, [ADR 0053](../../docs/adr/0053-workflow-customizes-follow-ups-and-conductor-comments.md)) customize GitHub feedback messages sent back to the Pi session. Rules are ordered; every matching rule renders, consecutive same-delivery templates join with a blank line, and delivery changes produce separate `steer`/`followUp` sends. No `if` means always match; no match falls back to the built-in feedback wrapper. Context is live API/reconciliation data: `feedback.*`, `github.pull_request`, `github.review`, `github.comment`, `github.review_comment`, `github.check`, `github.merge_conflict`, and `conductor.*`. Merge conflicts are routed as `feedback.kind == 'merge_conflict'` when GitHub reports `mergeable: CONFLICTING` or `mergeStateStatus: DIRTY`. Reactable GitHub feedback gets best-effort progress reactions: `EYES` when seen, `THUMBS_UP` after successful Herdr delivery. Every rendered Follow-Up includes non-optional guidance to include `<!-- pi-conductor -->` in any GitHub comment/review response the agent posts for that feedback.

**Conductor Comments** (`conductorComments`, [ADR 0053](../../docs/adr/0053-workflow-customizes-follow-ups-and-conductor-comments.md)) customize Conductor-authored GitHub issue comments for `prAssociated`, `runCompleted`, `runStopped`, and `runBlocked`. Each entry supports `template` and `enabled`; posted comments get the hidden `<!-- pi-conductor -->` marker automatically.

## Worktree hooks

`WorktreeManager` runs optional shell hooks around git worktree lifecycle:

| Phase        | Source keys                                                                                        | CWD           | Failure behavior          |
| ------------ | -------------------------------------------------------------------------------------------------- | ------------- | ------------------------- |
| `postCreate` | `.pi/WORKFLOW.md` `worktreeHooks.postCreate`, then local git config `pi.conductor.hook.postCreate` | worktree path | blocks launch             |
| `preRemove`  | `.pi/WORKFLOW.md` `worktreeHooks.preRemove`, then local git config `pi.conductor.hook.preRemove`   | worktree path | blocks cleanup/removal    |
| `postRemove` | `.pi/WORKFLOW.md` `worktreeHooks.postRemove`, then local git config `pi.conductor.hook.postRemove` | repo root     | best effort after removal |

Hook environment: `REPO_ROOT`, `WORKTREE_PATH`, `BRANCH`, `PI_CONDUCTOR_OWNER`, `PI_CONDUCTOR_REPO`, `PI_CONDUCTOR_ISSUE_NUMBER`. Shared repo hooks belong in `.pi/WORKFLOW.md`; private/ignored hooks use `.git/config`, e.g. `git config --local --add pi.conductor.hook.postCreate "cp ../.env .env || true"`.

## State store

State lives under `stateRoot` (default `~/.pi/agent/conductor`, [ADR 0005](../../docs/adr/0005-conductor-state-is-global-user-state.md)): `config.json`, `config.schema.json`, `state.sqlite`, `daemon/`, `runs/` (logs), and `worktrees/<owner>/<repo>/` ([ADR 0011](../../docs/adr/0011-worktrees-live-under-global-conductor-state.md)).

The store is a driver abstraction (`src/conductor/store/types.ts` `ConductorStore`) with a SQLite implementation (`store/sqlite.ts`, via `node:sqlite`) and an in-memory one (`store/memory.ts`). Tables/records: `RunRecord`, `RunEvent`, `WebhookDelivery`. SQLite enforces one active run per issue for dispatch idempotency ([ADR 0032](../../docs/adr/0032-sqlite-enforces-dispatch-idempotency.md), [0033](../../docs/adr/0033-state-store-uses-driver-abstraction.md)). Run logs live under `<stateRoot>/runs` ([ADR 0050](../../docs/adr/0050-run-logs-live-under-global-run-directory.md)); `status` is a human table with a `--json` option ([ADR 0052](../../docs/adr/0052-status-is-human-table-with-json-option.md)).

Recovery notes: automated reconciliation skips already completed issues and planned branches that already have a matching merged PR ([ADR 0055](../../docs/adr/0055-completed-work-is-not-automatically-redispatched.md)). Cleanup tolerates stale conductor-owned paths that are no longer git worktrees and removes them best-effort ([ADR 0056](../../docs/adr/0056-stale-worktree-cleanup-is-best-effort.md)). Herdr-backed background tabs use the current `HERDR_WORKSPACE_ID` so run-local tabs stay in the run workspace ([ADR 0054](../../docs/adr/0054-herdr-background-tabs-use-current-workspace.md)). During each reconcile, Conductor reads Herdr's JSON agent status for owned panes; `agent_status: "blocked"` moves the run/card to Blocked and posts `runBlocked` on the PR when known, otherwise the issue. Herdr attention blocks stay reconcilable so GitHub answers can still route into the blocked pane, and they clear when Herdr later reports `idle`, `working`, or `done` ([ADR 0057](../../docs/adr/0057-herdr-blocked-status-blocks-the-run-and-comments.md)). After a PR merges, Conductor closes the owned Herdr pane, cleans the worktree, and fetches/rebases the source repo's local base checkout only if it is already on that base branch and clean ([ADR 0058](../../docs/adr/0058-merged-pr-refreshes-local-base-checkout.md)).

## Notes for future agents

- The conductor is **independent of the extension/mode system**. It shells out to `pi` (launch flags from launch rules/manual args) and talks to GitHub via `gh` and Herdr via CLI. Do not assume it shares provider/mode config.
- Config and the store schemas are TypeBox (`src/conductor/config.ts`, `store/types.ts`); the repo's lint rules apply — keep boundary-crossing shapes typed.
- The full decision log is `docs/adr/0001`–`0056`. When changing conductor behavior, check whether an existing ADR governs it and update or supersede accordingly.
- Tests live in `test/conductor.test.ts` — cover config, expressions, command parsing, and store behavior.
