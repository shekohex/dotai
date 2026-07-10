# Plan 001: Host selected Pi Conductor runs through T3 HTTP

> **Executor instructions**: Follow this plan in order. Run every stated verification before moving on. This plan changes two repositories: `/home/coder/dotai/agent` and `/home/coder/project/t3code`. Do not add a `t3 conductor` CLI. Pi Conductor must call T3's authenticated HTTP API directly.
>
> **Dotai drift check (run first)**: `git diff --stat 873e2b0..HEAD -- src/conductor test/conductor.test.ts CONTEXT.md README.md openwiki/conductor docs/adr`
>
> **T3 drift check (run first)**: `git -C /home/coder/project/t3code status --short && git -C /home/coder/project/t3code diff --stat 0de374b28..HEAD -- packages/contracts/src apps/server/src/environment apps/server/src/orchestration apps/server/src/provider`
>
> Current T3 worktree has uncommitted changes in Pi-provider files. Coordinate with their owner before editing any overlapping file. If those changes alter the excerpts below, stop and re-plan rather than merging behavior by guesswork.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: migration
- **Planned at**: Dotai commit `873e2b0`, T3 baseline `0de374b28`, 2026-07-10

## Why this matters

Pi Conductor currently creates a Run Workspace and then launches Pi only inside a Herdr pane. T3 already owns authenticated project, thread, provider-session, and Pi-RPC lifecycle APIs, so creating a second CLI bridge would duplicate transport, authentication, retries, and protocol evolution.

This plan makes T3 an optional Session Host selected in Conductor configuration. Conductor remains owner of GitHub reconciliation, worktrees, prompt artifacts, branches, and lifecycle status. T3 becomes owner of a visible T3 thread and its Pi process. One run must have exactly one active Session Host; never start both a Herdr Pi process and a T3 Pi process for the same run.

## Decisions fixed by this plan

| Decision           | Chosen behavior                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T3 transport       | Direct authenticated HTTP. No T3 CLI bridge and no initial WebSocket client.                                                                                                                                                                     |
| Availability       | T3 is explicitly selected per repository. A configured T3 repository blocks when T3 is unavailable; it never silently falls back to Herdr.                                                                                                       |
| T3 project mapping | `repositories[].project` remains GitHub Projects V2. New `repositories[].t3.projectId` is a separate T3 server-local project ID.                                                                                                                 |
| Project resolution | Explicit ID first, then exact repository-identity match, then optional deterministic project creation. Ambiguity blocks dispatch.                                                                                                                |
| Worktrees          | Conductor creates/removes worktrees. T3 receives the existing worktree path and must not use `bootstrap.prepareWorktree`.                                                                                                                        |
| Follow-ups         | `steer` remains immediate. `followUp` remains queued by Pi, using a new T3 delivery field that maps to Pi RPC `follow_up`.                                                                                                                       |
| Legacy runs        | Existing `herdr` payloads remain readable and migrate in memory to a tagged Herdr session on first read/write.                                                                                                                                   |
| Launch rules       | T3 keeps static operator flags in existing `settings.launchArgs` and receives Conductor per-run modes through one validated `piModeFlags` model option. Only `--mode-<name>` tokens are allowed; all other workflow flags block before dispatch. |

## Current state

### Dotai Conductor

`src/conductor/command.ts:145-153` hard-codes the Herdr implementation:

```ts
const orchestrator = new ConductorOrchestrator({
  config: loadedConfig,
  store,
  github: new GhGitHubClient(undefined, options.logger, { store }),
  herdr: new CliHerdrSessionManager(),
  logger: options.logger,
  cwd: options.cwd,
});
```

`src/conductor/herdr.ts:43-51` is an apparent seam, but its interface is Herdr-native:

```ts
export interface HerdrSessionManager {
  launch(input: HerdrRunInput): Promise<HerdrLocation>;
  find(
    input: Pick<HerdrRunInput, "owner" | "repo" | "issueNumber" | "slug">,
  ): Promise<HerdrLocation | undefined>;
  paneExists(handles: HerdrHandles): Promise<boolean>;
  agentStatus(handles: HerdrHandles): Promise<HerdrAgentStatus | undefined>;
  send(handles: HerdrHandles, message: string, delivery: ConductorDeliveryMode): Promise<void>;
  stop(handles: HerdrHandles): Promise<void>;
}
```

`src/conductor/orchestrator.ts:402-424` creates the worktree and prompt artifact before launching Herdr. Preserve that order:

```ts
await this.worktrees.prepare(runtime.config, plan);
const prompt = renderInitialPrompt(/* ... */);
const promptArtifact = await writePromptArtifact(plan.worktreePath, prompt);
const herdr = await this.deps.herdr.launch({
  /* owner, repo, worktreePath, launchFlags, promptRelativePath */
});
```

`src/conductor/store/types.ts:14-20,51-69` persists a Herdr-only handle:

```ts
export const HerdrHandlesSchema = Type.Object({
  workspaceId: Type.Optional(Type.String()),
  tabId: Type.Optional(Type.String()),
  paneId: Type.Optional(Type.String()),
});

export const RunRecordSchema = Type.Object({
  // ...
  herdr: HerdrHandlesSchema,
});
```

`src/conductor/config.ts:50-79` accepts only config version 1 and has no T3 configuration. It already has `SecretRefSchema` (`env` or `file`) for webhook secrets; reuse that shape for T3 bearer credentials. `migrateGlobalConductorConfig()` is the existing config migration entry point.

The domain vocabulary in `CONTEXT.md` currently says Herdr is the Operator Console and calls a Herdr coordinate a Run Location. ADRs `0001`, `0009`, `0010`, `0026`, `0027`, `0032`, `0034`, `0035`, and `0057` govern current semantics. Preserve Conductor worktree ownership, SQLite dispatch idempotency, prompt artifacts, and Pi-owned follow-up queueing. Supersede only the assumption that every Run Location is a Herdr pane.

### T3 direct API

T3 already publishes a typed HTTP contract:

| Operation               | Endpoint                                   | Required scope          |
| ----------------------- | ------------------------------------------ | ----------------------- |
| Environment probe       | `GET /.well-known/t3/environment`          | none                    |
| Project/thread snapshot | `GET /api/orchestration/snapshot`          | `orchestration:read`    |
| Single-thread snapshot  | `GET /api/orchestration/threads/:threadId` | `orchestration:read`    |
| Project/thread dispatch | `POST /api/orchestration/dispatch`         | `orchestration:operate` |

Evidence:

- `packages/contracts/src/environmentHttp.ts:374-490` defines metadata, snapshot, thread snapshot, and dispatch endpoints.
- `apps/server/src/orchestration/http.ts:75-90` validates and dispatches authenticated commands.
- `packages/contracts/src/orchestration.ts:486-637` defines `project.create`, `thread.create`, and bootstrap-capable `thread.turn.start`.
- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:112-177` stores command receipts keyed by `commandId`; reuse stable command IDs on retries.
- `packages/contracts/src/environment.ts:23-35` currently advertises only `repositoryIdentity`; this plan adds an explicit direct-Conductor capability version.

Do not use `thread.turn.start.bootstrap.createThread` over HTTP. T3 applies that bootstrap only in its WebSocket path (`apps/server/src/orchestration/ws.ts:684-890`); direct HTTP dispatch passes a turn command to the engine, which requires its thread to already exist. Direct Conductor launch must issue `thread.create`, then `thread.turn.start`, as two deterministic commands.

T3's Pi provider starts the local `pi` binary in RPC mode:

```ts
const args = ["--mode", "rpc"];
// session/model/thinking/settings args
args.push(...splitPiLaunchArgs(input.settings.launchArgs));
```

Source: `apps/server/src/provider/Layers/PiAdapter.ts:306-329`.

T3's Pi Agent runtime sets `PI_CODING_AGENT_DIR` from provider `settings.agentDir` (`apps/server/src/provider/piAgentRuntimeConfig.ts:15`). That directory supplies Pi agent resources such as extensions, skills, and modes; configure it to the intended local Pi agent directory when manually testing this integration. There is no `DOTAI_AGENT_DIR` variable. Do not assume a path in that setting selects a different compiled Pi executable.

Pi RPC supports distinct `steer` and `follow_up` commands. T3 currently always emits `steer` for an active Pi session at `PiAdapter.ts:2090-2145`. This plan adds a delivery signal through T3's command path so Conductor's `followUp` behavior remains correct.

T3 thread snapshots already expose `hasPendingApprovals` and `hasPendingUserInput` on `OrchestrationThreadShell` (`packages/contracts/src/orchestration.ts:405-408`; populated by `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:1516-1520`). T3 Session Host inspection must use those thread fields for Conductor's backend-neutral attention block; do not infer blocking from `OrchestrationSession.status`.

## Commands you will need

| Purpose                | Command                                                                                                                                                                                                                        | Expected on success                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Dotai Step 3 tests     | `cd /home/coder/dotai/agent && npm test -- test/conductor.test.ts`                                                                                                                                                             | Exit 0; legacy and generic-session tests pass. |
| Dotai T3 focused tests | `cd /home/coder/dotai/agent && npm test -- test/conductor.test.ts test/conductor-t3-http.test.ts`                                                                                                                              | Exit 0 after Step 4; new T3 tests pass.        |
| Dotai typecheck        | `cd /home/coder/dotai/agent && npm run typecheck`                                                                                                                                                                              | Exit 0; no TypeScript errors.                  |
| Dotai full tests       | `cd /home/coder/dotai/agent && npm test`                                                                                                                                                                                       | Exit 0.                                        |
| Dotai lint             | `cd /home/coder/dotai/agent && npm run lint`                                                                                                                                                                                   | Exit 0.                                        |
| Dotai format check     | `cd /home/coder/dotai/agent && npm run format:check`                                                                                                                                                                           | Exit 0.                                        |
| T3 focused tests       | `cd /home/coder/project/t3code && vp test packages/contracts/src/orchestration.test.ts apps/server/src/environment/ServerEnvironment.test.ts apps/server/src/provider/Layers/PiAdapter.test.ts apps/server/src/server.test.ts` | Exit 0; delivery and capability tests pass.    |
| T3 checks              | `cd /home/coder/project/t3code && vp check && vp run typecheck`                                                                                                                                                                | Exit 0.                                        |
| T3 full tests          | `cd /home/coder/project/t3code && vp test`                                                                                                                                                                                     | Exit 0.                                        |

## Scope

### In scope: Dotai

- `src/conductor/session.ts` — new generic Session Host interface and tagged session schemas.
- `src/conductor/herdr.ts` — retain Herdr implementation as one Session Host adapter; remove ownership of generic interface/types.
- `src/conductor/t3-http.ts` — new injected-fetch T3 HTTP client and T3 Session Host adapter.
- `src/conductor/session-manager.ts` — new configuration-aware adapter selector.
- `src/conductor/config.ts` and `src/conductor/config-access.ts` — config v2 schema, migration, validation, and secret resolution.
- `src/conductor/store/types.ts` and `src/conductor/store/sqlite.ts` — tagged session persistence and legacy run-payload migration.
- `src/conductor/orchestrator.ts`, `run-status.ts`, `follow-up.ts`, `merge-conflict-reconcile.ts`, `cleanup-batch.ts`, `status-format.ts`, and `command.ts` — consume generic Session Host behavior.
- `src/conductor/herdr-attention.ts` — replace with a backend-neutral session-attention module; preserve legacy Herdr run recovery semantics.
- `test/conductor.test.ts` and new `test/conductor-t3-http.test.ts` — migration, adapter, orchestration, recovery, and config coverage.
- `CONTEXT.md`, `README.md`, `openwiki/conductor/overview.md`, and new `docs/adr/0060-configurable-session-hosts.md` — document selected-host behavior.

### In scope: T3

- `packages/contracts/src/environment.ts` and contract tests — advertise a versioned direct-Conductor capability.
- `packages/contracts/src/environmentHttp.ts` — expose a typed, non-sensitive conflict response for a previously rejected orchestration command receipt.
- `apps/server/src/environment/ServerEnvironment.ts` and tests — emit the capability.
- `packages/contracts/src/orchestration.ts`, `packages/contracts/src/provider.ts`, and tests — carry turn delivery from external orchestration command to provider send input.
- `apps/server/src/auth/http.ts`, `apps/server/src/orchestration/http.ts`, `apps/server/src/orchestration/decider.ts`, and `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` — map typed dispatch failures and persist/pass the delivery value.
- `apps/server/src/provider/Layers/PiAdapter.ts` and `PiAdapter.test.ts` — map `followUp` to Pi RPC `follow_up`; append validated per-thread mode flags without changing session/recovery lifecycle.
- `apps/server/src/server.test.ts` — verify direct HTTP dispatch and metadata capability behavior.

### Out of scope

- A `t3 conductor` CLI, shelling out to T3, or parsing CLI output.
- T3 WebSocket subscriptions. HTTP snapshots are sufficient for first implementation.
- Replacing Herdr for non-Conductor subagents, CoreUI background shells, or generic Herdr extensions.
- Removing Herdr support. Existing configurations and existing runs continue using Herdr.
- Silent T3-to-Herdr fallback. Operator must make host selection explicit.
- Storing bearer credentials, pairing credentials, URLs containing credentials, or response bodies in SQLite, run logs, GitHub comments, or repo workflow files.
- T3-controlled git worktree creation. Conductor stays sole worktree owner.
- Arbitrary per-run Pi launch-flag forwarding. T3 provider-level `settings.launchArgs` remains its existing operator-controlled configuration surface, and Conductor may add only validated `--mode-*` flags.

## Git workflow

- Dotai branch: `feat/conductor-t3-http-session-host`.
- T3 branch: `feat/conductor-http-session-contract`.
- Use atomic conventional commits matching recent history.
- Suggested commits: `feat(t3): expose conductor session HTTP capability`, then `feat(conductor): add T3 HTTP session host`, then `docs(conductor): document configurable session hosts`.
- Do not push or open a PR unless operator explicitly asks.

## Steps

### Step 1: Add the minimum T3 contract needed by a direct Conductor client

Create a versioned `conductorSessionApi` capability in T3's `ExecutionEnvironmentCapabilities`. It must decode as absent/false for older servers and be emitted as version `1` by `ServerEnvironment`. Decide exact TypeBox representation before coding: an integer capability version is preferred over a boolean because Conductor must reject incompatible protocol revisions before dispatching work.

Add a `delivery` field with values `steer` and `followUp` to T3's externally dispatchable `thread.turn.start` command, the corresponding turn-start-requested event payload, and provider send input. Existing clients without the field must retain current immediate/steer behavior through a schema default.

Keep this delivery type in a lowest-level contracts module shared by orchestration and provider schemas. Do not introduce a runtime import cycle between `orchestration.ts` and `provider.ts`.

Expose command-receipt rejection explicitly before any client relies on command-ID recovery. Current `orchestrationHttpApiLayer.dispatch` catches every dispatch failure as `EnvironmentInternalError`, which hides `OrchestrationCommandPreviouslyRejectedError` behind HTTP 500. Add a typed `EnvironmentOrchestrationCommandPreviouslyRejectedError` to `packages/contracts/src/environmentHttp.ts` with HTTP 409, code `command_previously_rejected`, opaque `commandId`, and `traceId`. Add it to `EnvironmentOrchestrationDispatchErrors`. Do not expose the engine's `detail`, because it can contain internal invariant context the remote client does not need.

Add a trace-aware helper in `apps/server/src/auth/http.ts`. In `apps/server/src/orchestration/http.ts`, catch `OrchestrationCommandPreviouslyRejectedError` before the generic dispatch-failure catch and map only that error to the 409 contract. Keep first-time invariant failures and true internal faults as generic safe failures. This is intentional: after an indeterminate HTTP 500, a retry with the same command ID differentiates accepted receipt (200) from recorded rejection (409) without creating another command.

Update `decider.ts` to preserve delivery in the emitted event. Update `ProviderCommandReactor` to pass it to `ProviderService.sendTurn`. Other providers may retain their existing behavior for the default and can ignore `followUp` for this plan; only Pi Agent behavior is required.

**Verify**: `cd /home/coder/project/t3code && vp test packages/contracts/src/orchestration.test.ts apps/server/src/environment/ServerEnvironment.test.ts apps/server/src/provider/Layers/PiAdapter.test.ts apps/server/src/server.test.ts` → exit 0. Add tests proving all of the following:

- Old `thread.turn.start` JSON decodes with delivery `steer`.
- A new command with delivery `followUp` survives command decode, event creation, and provider send request construction.
- The metadata endpoint advertises `conductorSessionApi: 1`.
- A server rejecting an unsupported command remains a typed dispatch error, not an unhandled HTTP failure.
- A command accepted on first receipt returns its original sequence when replayed with the same command ID.
- A command recorded as rejected returns HTTP 409 with `command_previously_rejected`, its opaque command ID, and no internal rejection detail when replayed.

### Step 2: Preserve Pi queue semantics and pass narrow per-run mode flags

Extend T3 Pi Agent handling without adding a CLI bridge or changing its session lifecycle. Preserve existing `settings.launchArgs`, RPC startup arguments, Pi resume cursor handling, and provider-session recovery. T3's existing provider-level `settings.launchArgs` remains the static operator configuration surface.

Add one reserved model-selection option named `piModeFlags` for Conductor's per-run modes. Read it only in `PiAdapter.buildPiArgs`; split it into individual tokens and accept only `/^--mode-[a-z0-9-]+$/` tokens with no values. Reject `--mode`, `--session`, `--session-dir`, executable paths, and every other option before spawning Pi. Append validated per-thread mode flags after existing static `settings.launchArgs`, so an allowed Run Workspace mode can override a static mode while `--mode rpc` remains non-overridable. Do not add a generic arbitrary-argument option.

In `PiAdapter.sendTurn`, choose Pi RPC command as follows:

| T3 delivery | Pi session state | Pi RPC command |
| ----------- | ---------------- | -------------- |
| `steer`     | active/running   | `steer`        |
| `followUp`  | active/running   | `follow_up`    |
| either      | idle/ready       | `prompt`       |

This preserves ADR 0027's invariant: Conductor does not create an idle-gate queue; Pi owns queued follow-up timing. The only PiAdapter changes are active-session command selection and validated mode-flag append; no session/recovery refactor.

**Verify**: `cd /home/coder/project/t3code && vp test packages/contracts/src/orchestration.test.ts apps/server/src/environment/ServerEnvironment.test.ts apps/server/src/provider/Layers/PiAdapter.test.ts apps/server/src/server.test.ts` → exit 0. Add Pi adapter tests with a fake runtime that assert:

- a `followUp` send while active requests `{ type: "follow_up" }`;
- a `steer` send while active requests `{ type: "steer" }`;
- either delivery while idle requests `{ type: "prompt" }`;
- valid `piModeFlags` appear after `--mode rpc` and static `settings.launchArgs`;
- forbidden flag tokens fail before spawning Pi;
- existing session/recovery behavior remains unchanged.

### Step 3: Introduce a backend-neutral Conductor Session Host seam and migrate run state

In Dotai, add `src/conductor/session.ts`. It owns these durable concepts:

- `ConductorDeliveryMode`: `steer | followUp`.
- `SessionHandle`: tagged union for `herdr` and `t3`.
- `SessionLaunchInput`: run ID, attempt, repository identity, issue metadata, branch, Run Workspace path, prompt text, prompt artifact path, and launch flags.
- `SessionInspection`: `live | missing | blocked | errored | stopped`, plus a safe human-readable detail where available.
- `ConductorSessionManager`: `launch`, `recover`, `inspect`, `send`, and `stop`.

The interface must expose durable session identity, not UI coordinates. `HerdrLocation` stays private to the Herdr adapter. T3 handles must persist `origin`, `environmentId`, `projectId`, `threadId`, and `attempt`; never include a bearer token.

Convert `CliHerdrSessionManager` to implement the generic interface. Its current workspace/tab label discovery remains unchanged internally. Convert its status mapping into generic `SessionInspection` values. Move generic delivery type out of `herdr.ts` without changing the Herdr wire behavior: `steer` remains Enter, `followUp` remains Alt+Enter.

Replace `RunRecord.herdr` with required `RunRecord.session`. Add a narrow legacy decoder/migrator for rows containing `herdr`. Legacy rows become `{ kind: "herdr", handles: <old handles> }` before `RunRecordSchema` validation. `SqliteConductorStore.parseRunRow` must use that migrator. The next normal `updateRun` writes canonical tagged state. Do not rewrite all rows during `init()`.

Add a backend-neutral attention marker rather than matching only `HERDR_BLOCKED_REASON`. Preserve the existing Herdr attention behavior and status restoration. T3 inspection maps `thread.hasPendingApprovals` or `thread.hasPendingUserInput` to attention-blocked, and maps an errored session to an error block; it must not invent a Herdr reason or infer blocking from session status alone.

**Verify**: Add Dotai tests proving:

- an old JSON run payload with `herdr` reads as a canonical tagged Herdr session;
- an updated legacy run writes only `session`;
- memory and SQLite stores still enforce one active run per GitHub work item;
- existing Herdr launch, send, stop, rediscovery, blocked/unblocked behavior remains green;
- status JSON includes a tagged session and status table shows a concise host identifier.

Run `cd /home/coder/dotai/agent && npm test -- test/conductor.test.ts`.

### Step 4: Implement the injected-fetch T3 HTTP client and T3 Session Host

Create `src/conductor/t3-http.ts`. Keep it a deep module: callers provide only Conductor/T3 configuration and session inputs; it owns URL construction, request timeout, headers, TypeBox response validation, stable command IDs, project resolution, and safe error conversion.

Do not import T3 source packages into Dotai. Define narrow TypeBox schemas for only these remote responses:

- environment descriptor and `conductorSessionApi` capability;
- orchestration project/thread snapshots needed for resolution and inspection;
- dispatch receipt.
- typed HTTP error envelopes, especially `command_previously_rejected`.

All HTTP JSON is untrusted. Parse through existing `parseJsonValue` and validate with TypeBox. Inject `fetch` into the client constructor so tests do not use network. Use an `AbortSignal` timeout from config. Strip credentials from all error messages and never log an authorization header.

Implement these operations:

| Method           | T3 request                                                                              | Required behavior                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `probe`          | `GET /.well-known/t3/environment`                                                       | Require configured environment ID when present, `repositoryIdentity` for automatic project matching, and `conductorSessionApi >= 1`. |
| `resolveProject` | `GET /api/orchestration/snapshot`                                                       | Prefer explicit `t3.projectId`; otherwise match exactly one non-deleted project by canonical repository identity.                    |
| `createProject`  | `POST /api/orchestration/dispatch`                                                      | Only when `createProjectIfMissing` is true. Use repository root, never worktree path.                                                |
| `launch`         | two `POST /api/orchestration/dispatch` calls: `thread.create`, then `thread.turn.start` | Create T3 thread then first prompt in existing Conductor worktree. Never send any `bootstrap` object.                                |
| `send`           | `POST /api/orchestration/dispatch` with existing `thread.turn.start`                    | Send delivery mode and no bootstrap.                                                                                                 |
| `inspect`        | `GET /api/orchestration/threads/:threadId`                                              | Map thread/session/pending-input state to generic inspection.                                                                        |
| `stop`           | `POST /api/orchestration/dispatch` with `thread.session.stop`                           | Stop provider before Conductor removes worktree.                                                                                     |

Use deterministic identifiers for a single logical dispatch:

- T3 thread ID: `pi-conductor:<runId>:attempt:<attempt>`.
- Initial thread-create command ID: `pi-conductor:<runId>:attempt:<attempt>:thread-create`.
- Initial turn-start command ID: `pi-conductor:<runId>:attempt:<attempt>:turn-start`.
- Auto-created T3 project ID and command ID: deterministic from canonical repository identity under a `pi-conductor:` prefix.
- Feedback delivery command ID: deterministic from run ID, run attempt, normalized feedback key, and rendered-message ordinal. Add a stable helper that encodes/hashes input safely rather than placing arbitrary URL/body text in IDs.

T3's command receipts make a retry with the same command ID safe only after a transport-uncertain outcome or an accepted receipt: an accepted duplicate returns its original accepted sequence. A rejected receipt is permanent for that command ID. Treat an initial network failure or generic HTTP 5xx as indeterminate: retain the same command ID and retry/probe under existing bounded recovery policy, never generate another thread ID. For initial launch, finish/retry `thread.create` before sending the first turn; never send a turn to an unconfirmed thread. Classify only typed HTTP 409 `command_previously_rejected` as permanent, block the run with an actionable error, and require normal Conductor retry to increment the run attempt before sending a new command ID. For an existing thread with stopped/missing provider session, recovery sends a recovery turn to the same T3 thread. If a T3 thread is explicitly deleted but the server still refuses recreation with its deterministic ID, block the run and report a manual-recovery error instead of creating an untracked duplicate.

Build T3 model selection from global T3 configuration plus one `piModeFlags` option. Validate every Conductor `launchFlags` token against `/^--mode-[a-z0-9-]+$/`; then append `{ id: "piModeFlags", value: launchFlags.join(" ") }` only when non-empty. Reject unsupported workflow flags before any T3 HTTP request with an actionable message that names the unsupported flag and directs operator to select Herdr or configure static T3 provider settings. Never strip or silently reinterpret flags. Each start/send payload uses `runtimeMode: "full-access"`, `interactionMode: "default"`, and a deterministic message ID derived with its logical command ID. Do not use `repositories[].project` for any T3 value.

**Verify**: `cd /home/coder/dotai/agent && npm test -- test/conductor.test.ts test/conductor-t3-http.test.ts` → exit 0. Add `test/conductor-t3-http.test.ts` with injected fetch fakes. Cover:

- successful health probe and capability rejection;
- malformed descriptor/snapshot/receipt rejection;
- missing, ambiguous, explicit, and auto-created project resolution;
- exact ordered `thread.create` then `thread.turn.start` payloads, including existing worktree path, deterministic command/message IDs, validated Pi mode option, and no `bootstrap` object;
- unsupported Conductor launch flags fail locally before any T3 HTTP request;
- stable retry of an initial dispatch after a simulated transport failure;
- generic HTTP 5xx retains the exact command ID for bounded recovery rather than being misclassified as permanent;
- previously accepted duplicate receipt reuse and typed HTTP 409 rejected-receipt mapping to a non-retryable blocked error;
- steer and follow-up dispatch payloads use distinct delivery values;
- stopped/errored/pending-input/missing thread inspection mapping;
- stop dispatch payload;
- no fake response or error assertion includes the bearer credential.

### Step 5: Add config v2 and configuration-aware Session Host selection

Add a version 2 Conductor config schema. Keep connection and credential settings global. Keep per-repository host selection and T3 project mapping under each managed repository. Do not allow credential configuration in `.pi/WORKFLOW.md`.

Target shape:

```jsonc
{
  "version": 2,
  "t3": {
    "origin": "https://t3.example.invalid",
    "authToken": { "env": "T3_CONDUCTOR_TOKEN" },
    "expectedEnvironmentId": "optional-environment-id",
    "requestTimeoutMs": 10000,
    "provider": {
      "instanceId": "piAgent",
      "model": "provider/model",
      "options": [],
    },
  },
  "repositories": [
    {
      "owner": "octo",
      "repo": "demo",
      "repoPath": "/repos/demo",
      "project": { "owner": "octo", "number": 1 },
      "sessionBackend": "t3",
      "t3": {
        "projectId": "optional-t3-project-id",
        "repositoryIdentity": "github.com/octo/demo",
        "createProjectIfMissing": false,
      },
    },
  ],
}
```

Use `sessionBackend: "herdr"` as the v1 migration default. Keep `validateGlobalConfig()` synchronous and structural. Extend the existing async `validateServeConfig()` in `src/conductor/command.ts` with a shared `validateT3RepositoryConnection()` probe after workflow/repository resolution: for each T3-selected repository, resolve the token reference, perform an unauthenticated descriptor probe, then authenticated snapshot probe before polling begins. Reuse that helper from async `validateConfigCommand()` so `pi conductor config validate` reports server/capability/auth failures too. On hot reload, current `serve()` already awaits `validateServeConfig(nextConfig)` before replacing `currentConfig` or closing polling; preserve that ordering so failed T3 validation logs the error and keeps the prior running configuration. `launch` must probe again because the server may disappear after `serve` starts. Read secret references per request so a rotated token file can take effect without logging content.

Add `SessionManagerSelector` with both adapters. It must choose based on resolved repository config and persist actual host in `RunRecord.session`. `ConductorOrchestrator.updateConfig()` must update selector/client configuration on hot reload without permitting `stateRoot` changes, matching existing reload behavior.

`config init` upgrades v1 configs to v2 and preserves existing repository fields. It must not contact T3 or auto-create T3 projects. `config validate` reports concise, actionable T3 errors without leaking credential values.

**Verify**: `cd /home/coder/dotai/agent && npm test -- test/conductor.test.ts test/conductor-t3-http.test.ts` → exit 0. Add tests proving:

- v1 config migrates to v2 with `sessionBackend: "herdr"` and preserves all existing repository settings;
- schema output includes T3 config and repository mapping;
- `config init` preserves existing T3 settings;
- T3 selected config rejects missing token reference, invalid URL, invalid timeout, invalid model selection, and missing required T3 capability;
- `validateServeConfig` and `config validate` run descriptor plus authenticated snapshot probes only for T3-selected repositories;
- a failed hot-reload T3 probe preserves the old polling/configuration path;
- Herdr-only config validates without T3 access;
- a changed T3 origin/token reference is observed by a hot-reloaded selector.

### Step 6: Wire generic Session Host behavior through Conductor lifecycle paths

Replace all Conductor-only `deps.herdr` callers with generic Session Host operations. Keep behavior identical for tagged Herdr sessions.

Required paths:

- `dispatchWorkItem`: create durable run with preallocated session identity before external launch; prepare worktree and prompt artifact; launch selected host; persist returned session handle.
- `send`: inspect/recover session, append pending event, deliver through selected host, then record success/failure.
- `routePullRequestFeedback` and merge-conflict routing: pass generic session manager, run attempt, stable feedback key, and rendered-message ordinal into delivery so T3 command IDs survive crashes between dispatch and `routedFeedbackKeys` persistence. Treat a definitive rejected T3 receipt as a blocked run; a normal Conductor retry gets a new run attempt and command ID.
- `retry`: stop current session, reuse branch/worktree according to existing ADR 0025, increment attempt, and create/use deterministic T3 thread identity for new attempt.
- `ensureRunSession` and recovery: Herdr uses existing label rediscovery; T3 uses stored thread ID and thread snapshot. Do not search T3 by title.
- active-run reconciliation: map `thread.hasPendingApprovals`, `thread.hasPendingUserInput`, and T3 session errors to backend-neutral attention blocks; a T3 thread without either pending flag and with `ready`/`running` session restores normal `in_progress` or `in_review` status.
- `stop`, merged cleanup, failed cleanup, and closed-work-item blocking: stop selected session before cleanup; preserve best-effort cleanup behavior.
- status formatting and run logs: show host and thread/pane identity without exposing origin credentials.

Create a new ADR `0060-configurable-session-hosts.md`. It must state that Herdr remains an available Operator Console, but selected runs may instead use T3 as Session Host. Update `CONTEXT.md` so a Run Location is host-specific and durable Session Handle is distinct from a visual location. Update README and OpenWiki command/config/lifecycle descriptions.

**Verify**: `cd /home/coder/dotai/agent && npm test -- test/conductor.test.ts test/conductor-t3-http.test.ts` → exit 0. Extend conductor orchestration tests with fake generic session managers. Required cases:

- T3 dispatch creates exactly one worktree, prompt artifact, T3 project/thread, and Pi process path.
- a transport retry does not create a second T3 thread.
- an accepted duplicate feedback receipt is harmless, while typed HTTP 409 for a rejected feedback receipt blocks the run and retrying the run uses a new attempt-scoped command ID.
- default GitHub feedback reaches `followUp`; explicit rule reaches `steer`.
- T3 `hasPendingApprovals`/`hasPendingUserInput` blocks a run and clearing both flags with a ready/running session unblocks it.
- T3 thread missing after a complete server reset relaunches the same deterministic attempt safely.
- T3 explicit thread deletion blocks with actionable error rather than creating an untracked duplicate.
- stopping/merging cleans worktree only after session stop is attempted.
- existing Herdr tests still pass without behavioral changes.

### Step 7: Perform controlled end-to-end verification

Use a disposable T3 state directory and an isolated Git repository/worktree. Provision a scoped non-production bearer credential through the approved T3 setup path; never paste it into shell history, plan files, committed config, logs, or test fixtures.

Configure one repository with `sessionBackend: "t3"`, an explicit T3 project ID or deterministic empty-server project creation, and a secret reference. Start T3 separately. Start `pi conductor serve` only after config validation succeeds.

Exercise this sequence manually:

1. Dispatch one eligible issue.
2. Confirm exactly one T3 project/root and one T3 thread for the run.
3. Confirm thread worktree path is Conductor's worktree, not a T3-created worktree.
4. Confirm the first T3 provider session launches the local Pi wrapper in RPC mode.
5. Route one `steer` and one `followUp`; confirm Pi receives immediate and queued behavior respectively.
6. Restart T3 while preserving state; confirm Conductor recovers without duplicate thread.
7. Stop the run; confirm session stops before Conductor worktree cleanup.
8. Repeat with a Herdr-selected repository; confirm regression-free legacy behavior.

**Verify**: Run all Dotai and T3 commands listed in "Commands you will need". Record only pass/fail summaries and redacted endpoint identities in the PR description.

## Test plan

### Dotai tests

- Add `test/conductor-t3-http.test.ts` for direct HTTP boundary behavior with injected fetch.
- Keep orchestration regression coverage in `test/conductor.test.ts`; use its `MemoryConductorStore`, `FakeGitHub`, `runRecord`, and worktree-manager patterns.
- Add a SQLite legacy-payload fixture test because production state uses JSON payloads, not typed in-memory records.
- Add config migration and schema-generation tests alongside existing config tests.
- Test transport errors, malformed remote JSON, 401/403, timeout, idempotent retry, project ambiguity, server reset, and no-secret logging.

### T3 tests

- Follow current Effect/Vitest patterns in `packages/contracts/src/orchestration.test.ts` and `apps/server/src/provider/Layers/PiAdapter.test.ts`.
- Add contract decode/default tests for delivery and metadata capability tests for `ServerEnvironment`.
- Add server HTTP dispatch coverage using existing `buildAppUnderTest` helpers in `apps/server/src/server.test.ts`.
- Add Pi fake-runtime assertions for `follow_up`, `steer`, idle prompt, valid/rejected per-run mode flags, and unchanged session recovery.

## Done criteria

- [ ] No `t3 conductor` CLI command exists or is introduced.
- [ ] T3 metadata explicitly advertises direct Conductor API version 1.
- [ ] T3 dispatch maps a previously rejected command receipt to typed HTTP 409 without exposing internal rejection detail.
- [ ] T3 Pi Adapter session/recovery behavior is unchanged except for active-session `follow_up` delivery selection and validated `--mode-*` append.
- [ ] Direct Conductor calls use only HTTP endpoints and bearer auth; no subprocess call invokes `t3`.
- [ ] A T3-selected run creates/reuses a T3 project and starts exactly one deterministic T3 thread in the Conductor worktree.
- [ ] `thread.turn.start` supports both `steer` and queued `followUp` through T3 Pi RPC.
- [ ] Direct HTTP launch uses deterministic `thread.create` followed by `thread.turn.start`; no `bootstrap` object is requested by Conductor.
- [ ] Legacy Herdr run payloads remain readable; new runs persist tagged session handles.
- [ ] Existing Herdr behavior and all existing conductor tests remain green.
- [ ] `npm run typecheck`, `npm test`, `npm run lint`, and `npm run format:check` pass in Dotai.
- [ ] `vp check`, `vp run typecheck`, and `vp test` pass in T3.
- [ ] No credential value appears in tracked files, generated schemas, test fixtures, logs, or plan output.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

- Relevant T3 Pi-provider files remain owned by another unmerged change set, or their current behavior conflicts with this plan.
- `pi --mode rpc --mode-build` cannot remain in RPC mode and apply a validated mode flag. Do not silently drop or approximate workflow modes.
- T3 cannot preserve a stable command receipt for repeated `commandId` values.
- T3 cannot distinguish a previously rejected command receipt from an indeterminate dispatch failure through the advertised direct-Conductor API.
- T3 thread snapshots do not expose enough state to distinguish missing, stopped, blocked/pending-input, and errored sessions.
- Direct HTTP requires a privileged scope beyond `orchestration:read` and `orchestration:operate` for normal launch/send/inspect/stop.
- A change appears to require touching generic subagent Herdr code, CoreUI background-shell code, or a T3 CLI command.
- Any test fixture or error path would require embedding a real bearer, pairing, or bootstrap credential.

## Maintenance notes

- Treat the T3 direct-Conductor capability version as a contract. Increment it only with a migration path and update Dotai compatibility checks/tests in the same change.
- T3 project IDs are server-local. Explicit IDs should be pinned per server; identity lookup is a convenience, not a cross-server durable identity.
- T3 thread IDs are durable run-attempt identities. Do not use display titles for recovery.
- Keep Conductor's worktree and prompt artifact ownership. A future T3 worktree feature must integrate through a deliberate replacement ADR, not by calling both systems.
- T3 WebSocket subscriptions are a future performance improvement only. Add them after HTTP polling/recovery is proven correct.
- If T3 later adds native queue semantics beyond Pi, extend the shared delivery type through capability version 2 rather than adding backend-specific branches to Conductor.
