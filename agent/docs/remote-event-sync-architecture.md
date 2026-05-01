# Remote Event Sync Architecture

## Overview

This document captures design discussion from this session about server memory pressure in remote mode, how upstream Pi RPC mode works, how `anomalyco/opencode` handles live updates and reconnection, and how to evolve current remote stream architecture toward bounded memory, fast reconnect, and eventual consistency.

Session reference:

- Session ID: `019ddb09-45e2-75f3-b40d-9bb7da96618d`
- Session file: `/home/coder/.pi/agent/sessions/--home-coder-dotai-agent--/2026-04-29T20-58-31-267Z_019ddb09-45e2-75f3-b40d-9bb7da96618d.jsonl`

Primary problem:

- Server crashes under high-velocity event load.
- Current remote transport retains too much transient data in memory.
- Requirement is now narrower and clearer: when a client disconnects or server restarts, recover fast to current durable state.
- Generic replay/history for all transient events is not required.

Relevant current local files:

- `src/remote/streams.ts`
- `src/remote/session/event-stream-ops.ts`
- `src/remote/session/extension-event-stream.ts`
- `src/remote/routes/stream-sse.ts`
- `src/remote/routes/stream-read.ts`
- `src/remote/client/session/local-extension-event-queue.ts`
- `src/remote/session/registry-base.ts`

Relevant upstream Pi files:

- `/home/coder/.cache/checkouts/github.com/badlogic/pi-mono/packages/coding-agent/docs/rpc.md`
- `/home/coder/.cache/checkouts/github.com/badlogic/pi-mono/packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `/home/coder/.cache/checkouts/github.com/badlogic/pi-mono/packages/coding-agent/src/modes/rpc/jsonl.ts`
- `/home/coder/.cache/checkouts/github.com/badlogic/pi-mono/packages/agent/src/agent.ts`

Relevant `opencode` files:

- `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/opencode/src/server/routes/instance/event.ts`
- `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/opencode/src/sync/index.ts`
- `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/opencode/src/sync/README.md`
- `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/opencode/src/server/routes/instance/httpapi/groups/sync.ts`
- `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/opencode/src/server/routes/instance/httpapi/handlers/sync.ts`
- `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/app/src/context/global-sync.tsx`
- `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/app/src/context/global-sync/event-reducer.ts`

## Goal

Build remote event system that restores a disconnected client to correct current state quickly, without retaining or replaying every transient progress event.

Success criteria:

- server memory stays bounded under high-velocity streaming updates
- reconnect after transient network failure is fast and correct
- recovery after server crash/restart restores correct durable state
- client converges to current authoritative state using minimum useful data
- connected clients still get responsive live progress updates
- architecture does not require generic replay of transient streaming history
- server architecture should move closer to `opencode`: live bus + bootstrap APIs + committed history endpoints

Constraints:

- keep live transport simple, closer to upstream Pi RPC behavior where possible
- reuse existing session JSONL-backed committed history where it already solves the need
- do not introduce a new durable replay subsystem unless snapshot + committed history prove insufficient
- optimize for current-state recovery, not historical event preservation
- single server process with local disk is deployment target
- full SSE is target transport; long-poll and stream-offset replay are legacy

Stop rules:

- if current authoritative snapshot plus committed session history can restore reconnect correctness, stop there
- do not add replay-specific machinery only to preserve obsolete transient events
- only keep extra in-memory buffering where it materially improves live fanout stability or reconnect latency

Desired client behavior:

1. Client opens per-session SSE sync endpoint.
2. Server attaches live subscription before sending initial data.
3. Server emits `server.connected`.
4. Server emits `snapshot` event with authoritative state and session version.
5. Server emits live `patch` events for connected clients.
6. If disconnected because of transient network issue, client reconnects to same SSE sync endpoint.
7. If server restarts, it rebuilds durable state from session JSONL, marks interrupted runtime domains explicitly, then emits fresh snapshot.
8. Client does not need full replay of missed transient progress events.
9. Client converges to current server state with minimum useful data.

## Historical Audit

This section captures pre-refactor architecture that motivated work below.

## Current Local Architecture

### In-memory durable stream store

Before snapshot/patch sync refactor, remote mode kept all events in memory per stream:

- `InMemoryDurableStreamStore` stored retained `events: StreamEventEnvelope[]` per stream in pre-refactor code.
- `append()` assigned offsets from retained array length and pushed every event forever in pre-refactor code.
- `read()`, `readAndSubscribe()`, and `waitForEvents()` all depended on same retained in-memory backlog in pre-refactor code.

Implications:

- memory grows without bound
- high-rate transient events accumulate forever
- reconnect path previously depended on replaying retained stream entries
- pre-refactor `upToDate` was always `true`, so there was no strong distinction between fresh catch-up and stale retained history

### Runtime events become retained stream entries

Pre-refactor remote session registry subscribed to runtime session events and converted them into retained stream events:

- runtime subscription was installed in `initializeRuntimeRecord()`
- each `AgentSessionEvent` became `agent_session_event`
- session-derived state changes also emitted `session_state_patch`

Implications:

- one upstream runtime event can produce more than one retained server event
- state patch churn adds extra memory pressure on top of base runtime event volume

### Extension bus mirroring also becomes retained stream entries

Remote mode mirrors extension runner and custom event bus events into session stream:

- mirrored extension runner events append `extension_event`. `src/remote/session/extension-event-stream.ts:31-43`
- resource loader event bus is patched so every custom bus emit appends `extension_custom_event`. `src/remote/session/extension-event-stream.ts:87-102`

Implications:

- extensions can amplify memory usage significantly
- telemetry-like custom events become indistinguishable from useful reconnect state

### Live transport uses same retained stream

SSE delivery is layered directly on top of retained stream:

- initial backlog comes from `readAndSubscribe()`. `src/remote/routes/stream-sse.ts:148-166`
- each live event is sent with control frames containing next offset and cursor. `src/remote/routes/stream-sse.ts:152-163`
- long-poll and JSON reads use same underlying store. `src/remote/routes/stream-read.ts:134-177`

Implications:

- same structure serves both live updates and reconnect recovery
- transport concerns and recovery concerns are currently coupled

### Local client already coalesces some extension-forwarded events

Client-side local extension forwarding already coalesces some hot events:

- replaceable key for assistant `message_update`. `src/remote/client/session/local-extension-event-queue.ts:81-84`
- replaceable key for `tool_execution_update`. `src/remote/client/session/local-extension-event-queue.ts:86-88`

Important limit:

- this helps local client-side extension dispatch only
- server has already retained raw events before this coalescing happens

## Root Problem

Current architecture retains far more than reconnect actually needs.

That is not true.

Some events are necessary to rebuild current state. Others are only transient progress indicators useful while a client is connected.

Examples of likely hot offenders in current system:

- `agent_session_event` carrying upstream `message_update`
- `agent_session_event` carrying upstream `tool_execution_update`
- `session_state_patch` emitted repeatedly while active run mutates
- `extension_custom_event` from chatty extensions

This becomes especially expensive because upstream progress payloads often contain accumulated state, not only tiny deltas.

## Upstream Pi RPC Mode

### What upstream RPC mode is

Upstream Pi RPC mode is live JSONL over stdio:

- commands come in on stdin
- responses and events go out on stdout
- framing is strict JSONL
- events are emitted as they happen
- transport layer itself does not maintain an in-memory replay log

References:

- protocol overview in docs. `/home/coder/.cache/checkouts/github.com/badlogic/pi-mono/packages/coding-agent/docs/rpc.md:19-36`
- `runRpcMode()` setup. `/home/coder/.cache/checkouts/github.com/badlogic/pi-mono/packages/coding-agent/src/modes/rpc/rpc-mode.ts:48-70`
- event output path. `/home/coder/.cache/checkouts/github.com/badlogic/pi-mono/packages/coding-agent/src/modes/rpc/rpc-mode.ts:321-339`
- JSONL serializer/reader. `/home/coder/.cache/checkouts/github.com/badlogic/pi-mono/packages/coding-agent/src/modes/rpc/jsonl.ts:4-57`

### Upstream event model

RPC mode streams high-frequency updates directly:

- `message_update` for assistant deltas. `/home/coder/.cache/checkouts/github.com/badlogic/pi-mono/packages/coding-agent/docs/rpc.md:809-849`
- `tool_execution_update` for streaming tool output. `/home/coder/.cache/checkouts/github.com/badlogic/pi-mono/packages/coding-agent/docs/rpc.md:851-895`

Important detail:

- upstream docs explicitly say `tool_execution_update.partialResult` contains accumulated output so far, not only delta. `/home/coder/.cache/checkouts/github.com/badlogic/pi-mono/packages/coding-agent/docs/rpc.md:894-895`

### Upstream transport characteristics

RPC mode is not reconnect-history oriented:

- no stream offset protocol
- no replay cursor
- no built-in retained event log in transport layer
- memory pressure mostly comes from current runtime state and normal IO buffering, not from infinite replay retention

### Why upstream RPC matters here

Upstream RPC mode proves:

- live progress updates are acceptable at high rate when treated as transient transport
- reconnect recovery should not automatically apply to every transport event

This matches discussion: current crash is not evidence that live updates are always bad. It is evidence that retaining all live updates forever in memory is bad.

## Opencode Architecture

`opencode` is useful because it splits live updates from recovery better than current local remote design.

### Live event stream

Opencode has live SSE bus endpoint:

- route sends `server.connected`, heartbeat, then forwards bus events live. `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/opencode/src/server/routes/instance/event.ts:39-85`
- no replay history served from this SSE route

This is close to upstream Pi RPC spirit:

- live stream for “what is happening now”
- not same thing as authoritative reconnect recovery

### What matters from opencode for us

Opencode has a separate sync event system, but after session clarification we do not need to copy all of that.

Useful lessons from opencode:

- live SSE bus should stay live-only. `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/opencode/src/server/routes/instance/event.ts:39-85`
- reconnect should prefer authoritative refetch/bootstrap. `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/app/src/context/global-sync/event-reducer.ts:21-29`, `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/app/src/context/global-sync.tsx:323-338`
- client should apply small deltas to local state instead of receiving repeated whole-state payloads. `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/opencode/src/cli/cmd/tui/context/sync.tsx:253-343`

Server-side direction to mirror more closely:

- use internal live event bus for fanout
- keep SSE route as bus subscriber, not replay reader
- use snapshot/bootstrap endpoints for reconnect recovery
- use committed history endpoints for transcript/history reads
- keep client reconciliation logic on client side

Potentially unnecessary for our narrower goal:

- full dedicated sync replay log
- per-aggregate replay API for all missed events
- general-purpose event sourcing for remote reconnect

### Client update application

Opencode client does not rebuild state from every whole snapshot event. It applies structured updates:

- `message.updated` upserts message info. `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/opencode/src/cli/cmd/tui/context/sync.tsx:253-290`
- `message.part.updated` upserts part state. `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/opencode/src/cli/cmd/tui/context/sync.tsx:306-325`
- `message.part.delta` appends delta to an existing part field. `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/opencode/src/cli/cmd/tui/context/sync.tsx:327-343`

This is exactly aligned with session discussion:

- send minimal diff while streaming
- let client apply diff to current state
- avoid sending repeated entire message state for every token if not necessary

### Reconnect/bootstrap behavior

Opencode refreshes on reconnect:

- on `server.connected` or `global.disposed`, global refresh is triggered. `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/app/src/context/global-sync/event-reducer.ts:21-29`
- global sync context also queues resync for active directories when server reconnects. `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/app/src/context/global-sync.tsx:323-338`
- session bootstrap fetches current session, recent messages, todo, diff. `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/opencode/src/cli/cmd/tui/context/sync.tsx:515-537`

This is important:

- reconnect path does not insist on replaying every missed live transient update
- it prefers authoritative refetch/bootstrap where appropriate

### Memory trimming on client side

Opencode also caps some client memory usage:

- TUI store trims messages to 100 and removes oldest part cache. `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/opencode/src/cli/cmd/tui/context/sync.tsx:271-289`

This does not solve server memory by itself, but confirms bounded caches are normal and useful.

## What We Agreed On

### Updated decision

Session direction changed and is now narrower:

- generic replay of transient event history is not required
- primary requirement is fast recovery when client disconnects temporarily and reconnects
- authoritative snapshot plus committed session history are more important than replaying every missed progress event
- current durable stream abstraction is likely not needed as long-term architecture center

Working recommendation:

- use session snapshot as primary reconnect primitive
- use live channel for currently connected clients
- use existing session JSONL-backed history for committed transcript/history access
- treat missed transient progress updates as disposable unless they still affect current authoritative state
- move server shape toward `opencode` bus-first model instead of evolving current stream-store-first model

### Final Locked Decisions

- transport is per-session SSE only
- one sync stream emits `server.connected`, then `snapshot`, then live `patch` events
- server subscribes client before emitting snapshot to avoid snapshot/live race
- snapshot payload is `{ type: "snapshot", version, snapshot }`
- client reconciliation is merge by durable identity, but server snapshot wins on conflict
- snapshot `version` and patch `version` are durable session versions only
- live-only patches may reuse current durable version until next committed durable transition
- persisted version resumes from last durable version after crash/restart; lost in-memory live-only patches do not create new versions
- session snapshot includes most recent 100 durable entries
- older durable history comes from paginated session entries JSONL endpoint
- long-poll, stream offsets, and replay cursors are removed from target design
- crash/restart follows upstream Pi semantics for partials: active assistant/tool partials are not restored from durable storage
- crash/restart recovery restores durable history plus explicit interrupted state for runtime domains
- queue, retry, compaction, and bash state persist as typed durable transition entries
- runtime domains rebuilt from durable reducers mark any previously running domain as `interrupted` on boot
- interrupted state is represented in snapshot fields, not synthetic transcript entries
- extensions declare sync class in event contract: `sync: "ephemeral" | "replaceable" | "durable"`
- extension durable state persists through session JSONL entries and is rebuilt by extension reducers on boot

### Key principle

If event B fully supersedes event A for convergence, A should be replaceable or droppable.

Examples:

- many `message_update` events become irrelevant after `message_end`
- many `tool_execution_update` events become irrelevant after `tool_execution_end`
- many state patch updates become irrelevant after later patch or fresh snapshot

### Event classes we discussed

#### Authoritative current state

Needed to restore client after reconnect.

Examples:

- committed transcript state
- current active partial assistant state while server process is still alive
- current active partial tool state while server process is still alive
- queue state
- retry and compaction state
- bash runtime state
- pending UI state if needed

Important limit after final decisions:

- after crash/restart we follow upstream Pi semantics and do not restore in-flight assistant/tool partials from durable storage
- after crash/restart authoritative snapshot restores durable state and marks previously running domains as `interrupted`

#### Replaceable progress updates

Useful while live, but older instances are superseded by newer ones.

Examples:

- `message_update`
- `tool_execution_update`
- repeated `session_state_patch`
- some `extension_custom_event` channel updates

#### Persisted committed history

Useful from session JSONL and existing persisted session state.

Examples:

- committed message entries
- compaction entries
- queue transition entries
- retry transition entries
- bash transition entries
- custom persisted entries
- branch/session history already stored by session manager

#### Extension sync classes

Declared by extension event contract.

Classes:

- `ephemeral`: live SSE only
- `replaceable`: live SSE only, newer event supersedes older state for same semantic slot
- `durable`: persisted via session JSONL entries and rebuilt by server-side reducer on boot

## Proposed Target Model

### Target layers

#### 1. Authoritative session state

Per-session canonical state object built from durable session entries plus live runtime overlays when runtime exists.

Should include:

- committed transcript
- current active assistant partial state only while process stays alive
- current active tool partial state only while process stays alive
- queue state
- retry state
- compaction state
- bash state
- pending UI requests
- extension UI state if client needs it
- interrupted runtime state after crash/restart

This becomes source of truth for snapshots.

#### 2. Live event bus and transport

Live SSE channel for connected clients only.

Properties:

- small progress updates
- no requirement to serve as long-term replay store
- may use tiny bounded coalescing queue internally for transport smoothing
- should not retain every transient update for reconnect
- no offset or cursor replay semantics
- first stream events are `server.connected` then `snapshot`

Preferred implementation:

- runtime/session changes publish to internal bus
- SSE subscribes to bus
- server attaches subscription before emitting initial snapshot
- transport emits connection lifecycle and heartbeat separately
- retained stream arrays are not primary fanout mechanism

#### 3. Bootstrap and committed history endpoints

Use existing session JSONL and session manager state for committed history.

Properties:

- dedicated HTTP APIs
- paginated via `entriesLimit` and `entriesOffset`
- good for committed durable history recovery
- not used for live catch-up replay

Preferred implementation:

- SSE sync endpoint emits authoritative `snapshot` event inline
- session history endpoint returns paginated durable entries when needed
- reconnect starts with fresh inline snapshot rather than stream offset catch-up

## Ring Buffer Notes

After decision update, ring buffer is optional implementation detail, not required architecture.

Possible uses:

- small bounded transport queue per connection
- in-process coalescing of hot live updates
- smoothing bursty producer/consumer mismatch

Not required uses:

- long-term reconnect history
- generic replay store
- authoritative state source

## Snapshot + Reconnect Model

Recommended reconnect flow:

1. Client opens per-session SSE sync endpoint.
2. Server attaches live subscriber before emitting any sync data.
3. Server emits `server.connected`.
4. Server emits `snapshot` event carrying authoritative snapshot and current durable version.
5. Client merges durable structures by identity, but snapshot wins on conflict.
6. Server emits live `patch` events after snapshot.
7. If client disconnects, it reconnects to same SSE sync endpoint and receives fresh snapshot again.
8. If server crashed and restarted, it first rebuilds state from session JSONL reducers, marks previously running domains as `interrupted`, then emits fresh snapshot.
9. No replay of missed transient `message_update` or `tool_execution_update` events is required.

This is intentionally closer to `opencode` than to current stream-offset replay behavior.

Important conclusion from session:

- reconnecting client usually does not need every historical `message_update`
- if `message_end` already exists, replaying previous streaming token deltas is wasted work
- after crash/restart, upstream Pi semantics are acceptable: partial assistant/tool state may be lost even if live client had seen it before crash

## Minimum Diff Protocol Direction

Session discussion preferred sending minimum diffs to client and letting client apply them.

Recommended distinction:

### Progress patches

- small live deltas
- mutate only active streaming UI state
- replaceable
- not authoritative long-term
- not guaranteed to survive crash/restart

Examples:

- assistant text delta
- tool stdout delta or latest accumulated partial
- progress percentage or live counters

### State patches

- authoritative
- enough to reconstruct state after reconnect
- derived from authoritative runtime state and committed session history
- durable version only advances when durable state changes are recorded
- live progress patches keep transport order but do not allocate separate monotonic versions

Examples:

- message committed to transcript
- tool result committed
- queue changed
- retry started/ended
- compaction started/ended
- bash started/ended

This separation is critical.

## Why Current `message_update` Shape Is Problematic

Current local remote system mirrors upstream runtime events as opaque `agent_session_event` payloads. `src/remote/session/event-stream-ops.ts:80-94`

That means:

- server cannot cheaply reason about dominance between updates
- current retention layer stores full upstream event payloads
- `tool_execution_update` may repeatedly store accumulated output snapshots

Long-term improvement likely requires more explicit local event taxonomy instead of opaque pass-through for all progress events.

## What To Borrow From Upstream Pi

From upstream Pi RPC mode we should borrow:

- treat hot progress updates as transient transport events by default
- avoid assuming every streamed update deserves durable retention
- keep live transport simple

Relevant references:

- `/home/coder/.cache/checkouts/github.com/badlogic/pi-mono/packages/coding-agent/docs/rpc.md:19-36`
- `/home/coder/.cache/checkouts/github.com/badlogic/pi-mono/packages/coding-agent/docs/rpc.md:748-895`
- `/home/coder/.cache/checkouts/github.com/badlogic/pi-mono/packages/coding-agent/src/modes/rpc/rpc-mode.ts:48-55`
- `/home/coder/.cache/checkouts/github.com/badlogic/pi-mono/packages/coding-agent/src/modes/rpc/rpc-mode.ts:321-339`
- `/home/coder/.cache/checkouts/github.com/badlogic/pi-mono/packages/coding-agent/src/modes/rpc/jsonl.ts:4-57`

## What To Borrow From Opencode

From `opencode` we should borrow:

- separate live SSE from recovery model
- use delta events for hot message updates
- refetch/bootstrap authoritative state on reconnect when that is simpler and safer than replaying everything
- keep client reducer logic able to apply small updates to current state

Relevant references:

- `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/opencode/src/server/routes/instance/event.ts:39-85`
- `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/opencode/src/cli/cmd/tui/context/sync.tsx:253-343`
- `/home/coder/.cache/checkouts/github.com/anomalyco/opencode/packages/opencode/src/cli/cmd/tui/context/sync.tsx:515-537`

## Options

### Option A: Optimize current system in place

Keep current stream API short-term, but stop relying on it conceptually for full recovery.

Changes:

- cap or coalesce retained transient events aggressively
- make session snapshot primary reconnect primitive
- use existing paginated session JSONL-backed entries for committed history
- reduce dependence on stream replay for reconnect correctness

Pros:

- smallest code churn
- fast path to memory fix
- reuses existing session snapshot and JSONL history

Cons:

- current stream abstraction still awkward
- opaque `agent_session_event` remains a limitation

### Option B: New snapshot + patch protocol

Introduce explicit authoritative snapshots and typed patches.

Changes:

- current snapshot endpoint becomes core recovery primitive
- progress patches are separate from authoritative state patches
- reconnect always prefers fresh snapshot over raw event replay for transient disconnects

Pros:

- cleanest convergence story
- best bandwidth profile
- easiest semantics long-term

Cons:

- bigger client and protocol rewrite

### Option C: Opencode-like server architecture

Likely best fit for current requirement.

Changes:

- replace stream-store-first fanout with bus-first fanout
- authoritative snapshot for reconnect/bootstrap
- existing session JSONL for committed history pagination
- live channel for transient progress deltas
- optional tiny bounded in-memory coalescing queue only for live transport
- client reconciles snapshot state plus new live deltas

Pros:

- matches actual requirement closely
- no need for separate generic durable replay system
- aligns with upstream Pi and `opencode` reconnect behavior
- simpler conceptual split between transport and recovery

Cons:

- reconnect path becomes snapshot-centric, not incremental replay-centric
- migration from current stream routes may be larger

## Recommended Direction

Recommended path from session discussion:

1. Stop treating current durable stream as long-term architectural center.
2. Replace stream routes with per-session SSE sync endpoint that emits `server.connected`, `snapshot`, then live `patch` events.
3. Make inline snapshot authoritative for reconnect.
4. Use existing session JSONL-backed entries for committed history pagination.
5. Move live fanout to bus-first architecture closer to `opencode`.
6. Treat live progress updates as transient transport data.
7. Persist only durable state transitions and committed messages.
8. Remove older assumption that full transient replay history is required.

Outcome-first summary:

- reconnect should restore current truth, not historical motion
- progress events should optimize live UX, not durable recovery
- committed history should come from session manager persistence already present
- additional infrastructure should only exist where it changes reconnect correctness or memory safety
- preferred server end state is bus + snapshot/bootstrap + history APIs, not retained stream store + offset replay

## Checklist

### Design checklist

- [x] define event taxonomy: durable, replaceable, ephemeral
- [x] define extension sync classes in event contract
- [x] define authoritative session snapshot shape at protocol level
- [x] define live progress patch shapes at protocol level
- [x] define reconnect bootstrap flow
- [x] define client reconciliation rule: merge by identity, snapshot wins on conflict
- [x] define TypeBox schemas for snapshot and patch envelopes
- [x] define exact interrupted status enums for each runtime domain

### Storage checklist

- [x] remove unbounded `events[]` retention from remote stream store path
- [x] implement typed durable transition entries for queue/retry/compaction/bash
- [x] persist session version with durable state transitions
- [x] ensure `tool_execution_update` does not persist every accumulated partial snapshot forever
- [x] add reducer-based rebuild from session JSONL on boot

### Server checklist

- [x] separate live transport concerns from reconnect recovery concerns
- [x] add per-session SSE sync endpoint
- [x] emit `server.connected`, then `snapshot`, then live `patch` events on same stream
- [x] ensure snapshot/live handoff is race-free by subscribing before snapshot emission
- [x] add internal live event bus layer
- [x] make SSE subscribe to live bus via explicit publish seam; retained store now allocates offsets/retention only while session/app append sites publish separately
- [x] expose committed history through paginated session entries endpoint only
- [x] remove long-poll and stream-offset replay endpoints from target design
- [x] rebuild interrupted runtime state from durable reducers after restart

### Client checklist

- [x] apply progress deltas to active local state
- [x] merge durable state by identity and let snapshot win on conflict
- [x] replace transient local state from fresh snapshot on reconnect
- [x] clear transient partial state when final durable event arrives
- [x] support multi-client eventual consistency by honoring durable order
- [x] tolerate reconnect where some transient updates were never observed
- [x] handle unknown `agent_session_event` residue intentionally by excluding opaque fallback payloads from typed sync patch protocol until client semantics exist

### Residual bookkeeping

- session and app stream offsets still exist only as monotonic live event identifiers and presence freshness markers
- they no longer provide replay, resume, or cursor recovery semantics
- durable session version remains authoritative for sync ordering and snapshot convergence
- seeded session stream head on load remains required so post-reload live events keep monotonic offsets for active subscribers
- [x] treat `server.connected` as reconnect/resync signal

### Testing checklist

- [x] reproduce high-volume memory case
- [x] verify bounded memory under sustained 100k `message_update`
- [x] verify bounded memory under sustained 100k `tool_execution_update`
- [x] verify reconnect during same-process streaming restores correct active partial state within 2s
- [x] verify crash mid-assistant stream restores committed transcript plus interrupted state within 5s
- [x] verify crash mid-tool stream restores committed tool state plus interrupted state within 5s
- [x] verify reconnect after completion skips obsolete transient updates
- [x] verify two clients converge to same final durable state after snapshot-based reconnect
- [x] verify extension ephemeral/replaceable/durable contracts behave correctly across reconnect and restart
- [x] verify durable-only snapshot/patch version semantics for live-only patches
- [x] verify remote tool transport preserves object-shaped `parameters` and `sourceInfo` end to end

## QA

### Q: Do we still need durable streams?

Probably not as long-term architecture.

Session conclusion after clarification:

- current durable stream abstraction is heavier than actual requirement
- reconnect correctness can come from authoritative snapshot plus committed session history
- small bounded live buffering may still be useful, but not as generic replay store
- if following `opencode` closely, live SSE should sit on top of bus/events, not retained stream storage

### Q: Can `message_update` and `tool_execution_update` be collapsed in memory?

Yes.

That was core conclusion of session.

They are prime replaceable events.

- newest update supersedes older ones for same active message/tool call
- once final durable event arrives, prior transient chain is often unnecessary for convergence

### Q: Can client reconnect mid-run and still recover?

Yes.

Recommended answer now:

- for transient disconnect while same process stays alive, snapshot can include current active partial assistant/tool state
- after crash/restart, snapshot restores durable state and explicit interrupted runtime state instead of in-flight partials
- client resumes live subscription after replacing/reconciling local state

Client does not need every missed intermediate token delta if current partial or final committed state is available.

### Q: Do we need separate persistent sync log?

Not necessarily.

Current session clarification says existing session JSONL is primary durable source for committed history and typed runtime transition entries.

Separate persistent sync log becomes optional, not assumed.

### Q: Can multiple clients still converge without every transient event?

Yes.

Eventual consistency requires:

- authoritative state definition
- ordered durable facts
- deterministic client application rules
- snapshot fallback when replay insufficient

It does not require preserving every transient token emission forever.

### Q: Why not only use snapshots and drop events entirely?

Possible, but less efficient for active synchronization and multi-client incremental updates.

Live events still valuable for:

- low-latency UI updates
- lower bandwidth while client stays connected

Best shape is snapshot + live updates + existing committed history, not snapshot-only or replay-heavy stream retention.

### Q: What survives crash/restart?

Committed durable state survives.

- committed transcript and custom durable entries survive through session JSONL
- queue/retry/compaction/bash state survives through typed durable transition entries
- interrupted status is reconstructed on boot for domains that were running before crash
- in-flight assistant and tool partials do not survive, matching accepted upstream Pi semantics

### Q: Why not only use ring buffer?

Ring buffer alone gives memory bound, but not reconnect correctness.

Need also authoritative snapshot.

## Migration Path

### Phase 1: New durable taxonomy

Goal: define what survives restart.

1. Add typed durable transition entries for queue/retry/compaction/bash.
2. Add extension sync classes and durable reducers.
3. Persist session version with durable state changes.

Expected result:

- durable recovery source is explicit and reducer-driven

### Phase 2: New per-session SSE sync endpoint

Goal: make sync atomic and replay-free.

1. Add per-session SSE endpoint.
2. Subscribe client before sending sync data.
3. Emit `server.connected`, then `snapshot`, then live `patch` events.

Expected result:

- reconnect correctness without offset replay

### Phase 3: Bus-first fanout

Goal: decouple live transport from retained storage.

1. Add internal live event bus abstraction.
2. Publish runtime/session progress events to bus.
3. Remove retained stream arrays from connected-client fanout.

Expected result:

- bounded live fanout path
- less coupling between transport and recovery

### Phase 4: Boot rebuild and interrupted state

Goal: survive crash/restart using durable state only.

1. Rebuild canonical session state from session JSONL reducers on boot.
2. Mark any previously running domain as `interrupted`.
3. Emit fresh authoritative snapshot after restart.

Expected result:

- restart recovery matches accepted upstream semantics

### Phase 5: Remove legacy remote stream model

Goal: delete obsolete replay-centric architecture.

1. Remove long-poll and offset replay endpoints.
2. Remove dependence on `InMemoryDurableStreamStore` for recovery.
3. Keep only paginated durable entries endpoint for history.
4. Keep residual stream offsets only where they support live event identity or presence observability.

Expected result:

- cleaner architecture
- no backward-compat replay machinery

## Summary

Session conclusions:

- current crash is most likely caused by unbounded in-memory retention of high-velocity transient events
- upstream Pi RPC mode treats progress events as live transport, not durable replay history
- `opencode` shows strong pattern: refetch/bootstrap on reconnect, keep live stream live-only, and apply minimal deltas on client
- `message_update`, `tool_execution_update`, repeated `session_state_patch`, and many extension custom updates should be collapsible or droppable for reconnect purposes
- after clarification, generic durable replay of transient transport events is not required
- current durable stream abstraction is likely unnecessary as long-term design center
- server architecture should move closer to `opencode`: bus-first live fanout, snapshot-first reconnect, committed-history endpoints

Recommended end state:

- authoritative session snapshot model
- internal live event bus for fanout
- existing paginated session JSONL-backed committed history
- progress deltas for live UX
- optional tiny bounded/coalesced live transport buffering only if needed
- active-run snapshot for reconnect

Final recommendation:

- optimize for current-state restoration
- keep prompts, transport, and architecture outcome-first
- avoid over-specifying replay machinery that does not improve reconnect correctness
- follow upstream Pi semantics for transient partial loss on crash/restart

That architecture best satisfies goals from this session:

- bounded memory
- minimal diff
- reconnect safety
- eventual consistency across clients
