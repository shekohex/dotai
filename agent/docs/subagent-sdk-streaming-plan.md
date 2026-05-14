<!-- markdownlint-disable MD013 -->

# Subagent SDK Streaming Plan

## Goal

Expose child Pi session activity and assistant updates through the Subagent SDK using Pi-style events forwarded live through child-to-parent IPC.

## Constraints

- Use live child Pi events forwarded over IPC as the streaming source of truth.
- Do not scrape tmux pane output.
- Do not add JSONL tailing, file watchers, polling, or side-channel transcript files for streaming.
- Reuse Pi agent event semantics and payloads directly.
- Do not invent browser permission/control semantics for downstream UIs; forward events and let consumers decide what to render.
- Let downstream SDK users map events to their own protocol, such as Plannotator Server-Sent Events.

## Current State

- Subagent children are independent Pi processes launched in tmux.
- Persisted children are launched with a known session ID and session file path before startup.
- Child Pi writes session entries through `SessionManager`.
- Parent SDK currently reads child session files for final outcome and activity snapshots.
- Parent SDK currently exposes lifecycle events through `sdk.onEvent(...)`.
- Upstream Pi live event streams emit `AgentEvent` values such as `message_start`, `message_update`, `message_end`, tool events, and `agent_end`.
- Cross-process subagents need a child bootstrap IPC bridge to forward those live events to the parent process.
- Upstream Pi RPC mode and `--mode json` both forward live event objects as newline-delimited JSON, which shows the event payloads can be transported as-is instead of reconstructed from persisted state.

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

## Preferred IPC Streaming Design

Create a parent-owned IPC endpoint per SDK instance, pass its address to each child through bootstrap environment, and install a child-side extension module such as `ipc.ts`.

Put transport details behind a shared IPC module so subagent runtime code does not care whether the platform uses Unix domain sockets or Windows named pipes.

Shared IPC module responsibilities:

- Export platform-neutral parent server and child client constructors.
- Use Unix domain sockets on Unix-like systems and named pipes on Windows internally.
- Own endpoint naming, temp directory placement, cleanup, and permissions.
- Provide newline-delimited JSON framing helpers matching upstream RPC/json mode style.
- Validate frame envelopes with TypeBox at process boundaries.
- Surface connection, disconnect, frame, and error events through typed callbacks.
- Keep transport retry and reconnection behavior out of `SubagentSDK` business logic.

Parent responsibilities:

- Start one IPC server from the shared IPC module when `SubagentSDK` is created.
- Generate a private endpoint path/name under a temp directory with restrictive permissions.
- Pass endpoint address and child session ID in the child launch environment.
- Accept child connections, authenticate the expected session ID/token, and route events to that session's `SubagentHandle`.
- Keep IPC server and session routes alive until the SDK is disposed.
- Keep persisted child session IPC route state after terminal state or cancellation because the same child session can be resumed later.
- Replace or reconnect a session connection when a persisted child resumes.
- Remove all IPC routes and close all connections only when the SDK is disposed.

Child responsibilities:

- During bootstrap, connect to the parent IPC endpoint when IPC env is present.
- Subscribe to all Pi events exposed through extension APIs.
- Forward every event without filtering:

```ts
pi.on("message_update", (_ctx, event) => {
  ipc.emit("message_update", JSON.stringify(event));
});
```

- Use newline-delimited framed JSON messages over the socket/pipe.
- Include `sessionId`, event `type`, and original event payload in each frame.
- Treat IPC failures as non-fatal for the child session.

Advantages:

- No polling.
- No file watching.
- No JSONL tailing.
- Preserves exact upstream event order and payload shape.
- Streams `message_update` and `tool_execution_update` directly from live Pi events.
- Works for persisted and ephemeral children.
- Keeps the parent-side route stable across persisted child resume cycles.

Research tasks before implementation:

- Confirm exact child bootstrap hook point where `ipc.ts` can register `pi.on(...)` handlers before the child starts work.
- Confirm extension `pi.on(...)` exposes every event needed by SDK consumers.
- Define shared IPC framing schema with TypeBox and validate inbound parent frames at boundary.
- Validate socket lifecycle under tmux panes, auto-resume, child restart, and SDK disposal.
- Add Windows named-pipe path tests or platform-gated tests.

## Event Forwarding

Forward child Pi events from IPC to SDK consumers as-is.

No entry mapping layer is needed. No JSONL reconstruction is needed. The parent only validates the IPC frame envelope, extracts the event payload, and emits that payload unchanged to `handle.on(...)` and `sdk.onChildEvent(...)` subscribers.

The event envelope should contain routing metadata outside the original event payload:

```ts
type ChildEventFrame = {
  kind: "child_event";
  sessionId: string;
  token: string;
  event: AgentEvent;
};
```

The SDK must not mutate `event`, rename event fields, synthesize missing deltas, or hide tool/permission events.

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

- Exact type export path for Pi `AgentEvent` in this repo's public API.
- Exact child bootstrap hook point for installing the IPC bridge.
- Exact extension event coverage from `pi.on(...)` compared to upstream RPC/json mode output.

## Suggested Implementation Order

1. Add shared IPC transport module with Unix socket and Windows named-pipe implementations behind one API.
2. Add TypeBox schemas for IPC frame envelopes and newline-delimited framing helpers based on upstream RPC/json mode patterns.
3. Add SDK-owned IPC server lifecycle: create on SDK init, keep session routes across persisted child resumes, dispose only with SDK.
4. Add typed child event emitter to `SubagentHandle` and `SubagentSDK` that exposes all child Pi events.
5. Add child `ipc.ts` bootstrap bridge that registers `pi.on(...)` handlers and forwards live event payloads unchanged.
6. Wire child launch/resume env with endpoint address, session ID, and auth token.
7. Add IPC tests for framing, auth rejection, session routing, reconnect/resume, disposal cleanup, and platform endpoint selection.
8. Wire Plannotator Ask AI SSE to the new event API without adding unsupported browser controls.
