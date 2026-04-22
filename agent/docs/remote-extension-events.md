# Remote Extension Event Forwarding

## Goal

Remote runtime has split brain by design:

- server owns authoritative session state, tool execution, model selection, prompt shaping, provider requests, and persistence
- client owns TUI rendering and local UI-derived extension state

Because of that split, remote adapter must not treat every `ExtensionEvent` same.

## Rule

Forward only passive, post-commit events.

Do not forward mutating or blocking hooks as replay events.

## Forwarded Events

These are safe to mirror from server to client local extensions because server already made decision and committed state:

- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `queue_update`
- `compaction_start`
- `compaction_end`
- `auto_retry_start`
- `auto_retry_end`
- `model_select`
- `session_compact`
- `session_tree`

Why:

- they drive UI refresh, derived local state, or passive status rendering
- replaying them on client does not affect authoritative execution
- if client misses them, local extension state can drift from server state

Concrete examples:

- `modes` uses `model_select` to recompute active mode and publish `modes:changed`
- `coreui` uses `model_select` and `session_tree` to refresh render state
- `openusage` uses `model_select` to refresh provider usage display

## Not Forwarded

These stay server-only:

- `resources_discover`
- `session_before_switch`
- `session_before_fork`
- `session_before_compact`
- `session_before_tree`
- `context`
- `before_provider_request`
- `before_agent_start`
- `user_bash`
- `input`
- `tool_call`
- `tool_result`

Why:

- they can block, cancel, mutate, or replace authoritative behavior
- replaying them on client is too late
- client-side replay would risk divergence or duplicate side effects
- supporting them correctly would require request/response RPC, not fire-and-forget stream replay

Examples:

- `tool_call` can block a tool invocation
- `tool_result` can rewrite result payload
- `input` can fully handle prompt submission or transform prompt text
- `context` can rewrite model context before provider call
- `before_provider_request` can rewrite provider payload

## Session Start

`session_start` is special.

Client local extensions still need a startup bootstrap event even when attaching to already-running remote session. That bootstrap is local concern, not strict replay of server lifecycle.

Current remote adapter emits a local synthetic `session_start` during client bind. That is enough for bootstrap, but its reason is not authoritative for remote transitions like `new`, `resume`, `fork`, or `reload`.

This document treats `session_start` parity as separate concern from passive event mirroring.

## Ordering

Passive mirrored events can arrive before later authoritative state patches.

`model_select` is important here: client must update local model view before replaying mirrored `model_select`, otherwise extensions like `modes` read stale `ctx.model` and fail to recompute `custom` mode after `/model`.

## Summary

- server hooks decide behavior
- client events refresh presentation
- mirror committed facts, not decision hooks
