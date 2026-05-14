# Subagent SDK Streaming Plan

## Goal

Expose child Pi session activity and assistant updates through the Subagent SDK using Pi-style events, backed by the child session JSONL file that Pi already writes.

## Constraints

- Use persisted child session files as the source of truth.
- Do not scrape tmux pane output.
- Do not add a second stream JSONL side channel for persisted subagents.
- Reuse Pi session entry types and Pi agent event semantics where possible.
- Let downstream SDK users map events to their own protocol, such as Plannotator Server-Sent Events.

## Current State

- Subagent children are independent Pi processes launched in tmux.
- Persisted children are launched with a known session ID and session file path before startup.
- Child Pi writes session entries through `SessionManager`.
- Parent SDK currently reads child session files for final outcome and activity snapshots.
- Parent SDK currently exposes lifecycle events through `sdk.onEvent(...)`.
- Upstream in-process `AgentSession.subscribe(...)` emits Pi `AgentEvent` values such as `message_start`, `message_update`, `message_end`, tool events, and `agent_end`.
- Cross-process subagents cannot directly subscribe to the child `AgentSession`; parent must observe the child session file.

## Proposed API

Add Pi-style event subscription for child session streams:

```ts
const unsubscribe = handle.on("message_update", (ctx, event) => {
  // event uses Pi AgentEvent-compatible shape
});
```

Also support SDK-level subscription for orchestration code that does not hold a handle yet:

```ts
const unsubscribe = sdk.onChildEvent(sessionId, "message_update", (ctx, event) => {
  // map event to custom UI/SSE protocol
});
```

Event names should follow Pi event names rather than Subagent-specific names where the payload maps cleanly:

- `agent_start`
- `turn_start`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `turn_end`
- `agent_end`

Subagent-only lifecycle events stay on existing `sdk.onEvent(...)`.

## Session File Watcher

Create a child session stream watcher owned by the Subagent runtime.

Responsibilities:

- Watch the child session file path for append changes.
- Track byte offset and seen entry IDs.
- Read only appended bytes after each change.
- Parse complete JSONL records.
- Convert new session entries into Pi-style event payloads.
- Emit events through handle-level and SDK-level subscribers.
- Close watcher when child reaches terminal state or SDK is disposed.

Implementation notes:

- Use `fs.watch` through Pi's existing `watchWithErrorHandler` pattern.
- Debounce/coalesce rapid change notifications before reading.
- Keep a small incomplete-line buffer for partial JSONL writes.
- Reopen `SessionManager` only for cases that need branch/tree interpretation, not for every append chunk.
- Use entry IDs for dedupe because session files are append-only and entries are immutable.

## Entry Mapping

Session entries can map to events at different fidelity levels.

Initial useful mapping:

- `message` with `role: "user"` → `message_start`, `message_end`
- `message` with `role: "assistant"` → `message_start`, `message_end`
- custom subagent activity entries → tool/status events where possible
- terminal assistant message or child completion outcome → `agent_end`

Streaming text deltas require persisted in-progress assistant updates. If Pi's session file only receives final assistant messages, the SDK can still stream completed messages and tool/status events, but not token deltas.

For token-level or chunk-level `message_update`, child Pi must persist update entries while streaming. Best path is to add a Pi-native session entry for assistant update events, or have `AgentSession` persist existing `AgentEvent` update payloads in a compact custom entry during child runs.

## Plannotator Ask AI Use

Plannotator should subscribe to child Pi events and map them to its AI SSE protocol:

```ts
handle.on("message_update", (_ctx, event) => {
  sendSse({ type: "text_delta", delta: extractDelta(event) });
});

handle.on("message_end", (_ctx, event) => {
  sendSse({ type: "text", text: extractText(event.message) });
});

handle.on("agent_end", () => {
  sendSse("[DONE]");
});
```

Ask AI sessions should use persisted children so follow-up messages can auto-resume after pane exit.

## Open Questions

- Whether upstream Pi should persist `message_update` entries by default, or whether subagent child bootstrap should opt into recording them.
- Exact type export path for Pi `AgentEvent` in this repo's public API.
- Whether `handle.on(...)` should expose all child events or only a safe subset by default.
- How to represent permission/tool events in downstream browser UIs without leaking unsupported controls.

## Suggested Implementation Order

1. Add typed child event emitter to `SubagentHandle` and `SubagentSDK`.
2. Add session file watcher with byte-offset JSONL parsing.
3. Map completed session entries to Pi-style events.
4. Add tests with synthetic child session files.
5. Add child bootstrap persistence for `message_update` if session files do not currently contain enough streaming detail.
6. Wire Plannotator Ask AI SSE to the new event API.
