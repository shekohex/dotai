# Remote Runtime Parity Gaps

This document tracks remaining gaps between local standalone session/runtime behavior and current remote runtime behavior.

Scope here is runtime and session parity, not product decisions.

Last reviewed against upstream `badlogic/pi-mono` on `2026-04-25`.

## Current Status

Remote session replacement semantics now match upstream more closely:

- replacement session is rebound before `withSession(...)`
- replacement context is real runner-backed command context
- remote no longer fabricates replacement-session fallback context

Recently closed gaps:

- [x] runtime `fork()` now switches to real remote forked session and runs `withSession(...)`
  - files: `src/remote/client/runtime.ts`, `src/remote/runtime-api/client.ts`, `src/remote/routes/handlers.ts`, `src/remote/session/registry-management.ts`
  - upstream parity target: `packages/coding-agent/src/core/agent-session-runtime.ts`

- [x] `getUserMessagesForForking()` now returns remote fork source messages instead of always returning an empty list
  - files: `src/remote/client/session/capabilities-api.ts`, `src/remote/session/registry-management.ts`
  - test: `test/remote.test.ts`

- [x] remote client resource loader now mirrors server skills, prompts, and themes, and refreshes them on reload
  - files: `src/remote/client/session-resource-loader.ts`, `src/remote/session/runtime-resources-sync.ts`
  - test: `test/remote.test.ts`

- [x] queue, compaction, retry, and passive extension events now reach client-side local extensions
  - files: `src/remote/client/session-events.ts`, `src/remote/client/session/local-extension-runner.ts`
  - test: `test/remote.test.ts`

- [x] `navigateTree()` now executes over remote protocol and refreshes local session state
  - files: `src/remote/client/session/capabilities-api.ts`, `src/remote/session/registry-runtime-ops.ts`, `src/remote/runtime-api/client.ts`
  - test: `test/remote.test.ts`

- [x] remote session API can now start and abort compaction
  - files: `src/remote/client/session/capabilities-api.ts`, `src/remote/client/session/setup-base.ts`, `src/remote/session/registry-runtime-ops.ts`
  - test: `test/remote.test.ts`

- [x] remote session API now exposes bash execute and abort surface
  - files: `src/remote/client/session/capabilities-api.ts`, `src/remote/session/registry-runtime-ops.ts`
  - test: `test/remote.test.ts`

- [x] remote abort paths now surface transport failures instead of silently swallowing them
  - file: `src/remote/client/session/capabilities-api.ts`
  - test: `test/remote.test.ts`

- [x] fork-message refresh now preserves last known cache on transient failures
  - file: `src/remote/client/session/setup-base.ts`
  - test: `test/remote.test.ts`

- [x] authoritative remote tool-definition metadata now transports from server to client
  - files: `src/remote/session/tool-definition-metadata.ts`, `src/remote/session/registry-runtime-ops.ts`, `src/remote/client/session/remote-tool-definitions.ts`
  - test: `test/remote.test.ts`

- [x] remote `compact()` now applies returned snapshot in place instead of replaying reload lifecycle
  - files: `src/remote/client/session/runtime-internals.ts`, `src/remote/client/session/capabilities-api.ts`
  - test: `test/remote.test.ts`

- [x] remote `recordBashResult()` now records server-side bash messages and returns authoritative bash-state snapshot
  - files: `src/remote/schemas-core.ts`, `src/remote/routes.ts`, `src/remote/routes/handlers.ts`, `src/remote/runtime-api/client.ts`, `src/remote/session/registry-runtime-ops.ts`, `src/remote/client/session/capabilities-api.ts`
  - test: `test/remote.test.ts`

- [x] remote bash execution now emits durable start/chunk/end events for incremental client streaming
  - files: `src/remote/schemas-stream.ts`, `src/remote/session/registry-runtime-ops.ts`, `src/remote/client/session/polling-ops.ts`, `src/remote/client/session-envelope-ops.ts`, `src/remote/client/session/capabilities-api.ts`
  - test: `test/remote.test.ts`

- [x] live bash execution state is now shared across all attached remote clients
  - files: `src/remote/client/contracts.ts`, `src/remote/client/session/setup-base.ts`, `src/remote/client/session/runtime-internals.ts`
  - test: `test/remote.test.ts`

- [x] pending bash flush now uses explicit durable `bash_flush` protocol events before next prompt
  - files: `src/remote/schemas-stream.ts`, `src/remote/session/commands-basic.ts`, `src/remote/session/runtime-command.ts`, `src/remote/session/event-ops.ts`, `src/remote/session/event-stream-ops.ts`, `src/remote/client/session-envelope-ops.ts`, `src/remote/client/session/polling-ops.ts`
  - test: `test/remote.test.ts`

- [x] `hasExtensionHandlers()` now reflects client-local extension runner state
  - file: `src/remote/client/session/capabilities-api.ts`

This is still not full parity.

## Remaining Gaps

### Session Runtime APIs

- [ ] `importFromJsonl()` is still stub-cancelled in remote runtime
  - file: `src/remote/client/runtime.ts`
  - current behavior: always returns `{ cancelled: true }`
  - parity target: match `packages/coding-agent/src/core/agent-session-runtime.ts#importFromJsonl()` including copy/import, cwd resolution, and replacement-session flow

### Compaction

- [x] `compact()` now applies server snapshot without replaying client reload lifecycle
  - files: `src/remote/client/session/runtime-internals.ts`, `src/remote/client/session/capabilities-api.ts`
  - parity target: local `compact()` mutates active session in place; remote now mirrors that instead of forcing reload lifecycle

### Bash Execution

- [x] `executeBash()` now streams incremental chunks from server over durable session events
  - files: `src/remote/client/session/capabilities-api.ts`, `src/remote/session/registry-runtime-ops.ts`, `src/remote/schemas-stream.ts`
  - parity target: match local streaming bash behavior

- [x] unsupported remote bash `timeout` transport was removed
  - files: `src/remote/schemas-core.ts`, `src/remote/session/registry-runtime-ops.ts`
  - note: contract no longer advertises unsupported timeout enforcement

- [x] `recordBashResult()` now records remote bash results with local ordering semantics
  - files: `src/remote/client/session/capabilities-api.ts`, `src/remote/session/registry-runtime-ops.ts`
  - parity target: support externally executed bash result recording with same ordering guarantees as local runtime

- [x] `isBashRunning` now updates from authoritative remote state patches and bash lifecycle stream events
  - files: `src/remote/client/session/polling-ops.ts`, `src/remote/client/session/runtime-internals.ts`, `src/remote/session/registry-runtime-ops.ts`

- [x] `hasPendingBashMessages` now syncs from authoritative remote state and clears on durable `bash_flush`
  - files: `src/remote/client/session/runtime-internals.ts`, `src/remote/session/runtime-sync.ts`, `src/remote/schemas-stream.ts`

- [ ] custom `operations` transport for remote bash is unsupported
  - file: `src/remote/client/session/capabilities-api.ts`

### Export And Import Surface

- [ ] `exportToHtml()` is unsupported
  - file: `src/remote/client/session/capabilities-api.ts`
  - parity target: match `packages/coding-agent/src/core/agent-session.ts#exportToHtml()`

- [ ] `exportToJsonl()` is unsupported
  - file: `src/remote/client/session/capabilities-api.ts`
  - parity target: match `packages/coding-agent/src/core/agent-session.ts#exportToJsonl()`

- [ ] runtime-level `importFromJsonl()` is still tracked above under Session Runtime APIs

### Tool And Extension Introspection

- [ ] transported remote tool definitions preserve metadata but not executable/rendering behavior for remote-only tools
  - files: `src/remote/client/session/remote-tool-definitions.ts`, `src/remote/client/session/capabilities-api.ts`
  - current behavior: metadata reconstructed client-side; remote-only tool renderers/execute behavior are not recreated
  - parity target: enough transport for remote-only tools to behave like local definitions where needed

- [ ] remote tool definition parameter schemas are transported as unknown data and lightly reconstructed
  - file: `src/remote/client/session/remote-tool-definitions.ts`
  - parity target: preserve authoritative TypeBox schemas with stronger guarantees

- [ ] server-side extension-handler availability is still not exposed remotely
  - file: `src/remote/client/session/capabilities-api.ts`
  - current behavior: `hasExtensionHandlers()` reflects client-local runner only
  - parity target: distinguish client-local and server-runtime extension handlers

### Remote Server UI Gaps

These are still degraded relative to local interactive mode.

- [ ] `ctx.ui.addAutocompleteProvider()` unsupported
  - file: `src/remote/session/ui-context.ts`
  - current behavior: explicit throw
  - parity target: protocol for stacked autocomplete providers, or documented permanent non-goal

- [ ] `ctx.ui.setHeader(factory)` unsupported for function factories
  - file: `src/remote/session/ui-context.ts`
  - current behavior: explicit throw when factory passed
  - parity target: render bridge for header component data or factory protocol

- [ ] `ctx.ui.setFooter(factory)` unsupported for function factories
  - file: `src/remote/session/ui-context.ts`

- [ ] `ctx.ui.setEditorComponent(factory)` unsupported
  - file: `src/remote/session/ui-context.ts`

- [ ] `ctx.ui.onTerminalInput()` unsupported on remote server runtime
  - file: `src/remote/session/ui-status-handlers.ts`

- [ ] `ctx.ui.getToolsExpanded()` unsupported on remote server runtime
  - file: `src/remote/session/ui-status-handlers.ts`

- [ ] `ctx.ui.getEditorText()` returns empty string fallback
  - file: `src/remote/session/ui-context.ts`

- [ ] `ctx.ui.setTheme()` unsupported
  - file: `src/remote/session/ui-context.ts`
  - note: theme resources and settings now sync remotely, but the server-side extension UI context still does not expose theme selection APIs

- [ ] `ctx.ui.getAllThemes()` returns empty list
  - file: `src/remote/session/ui-context.ts`

- [ ] `ctx.ui.getTheme()` returns `undefined`
  - file: `src/remote/session/ui-context.ts`

### Protocol / Capability Follow-Up

Some gaps are likely protocol gaps, not only implementation gaps.

Areas needing protocol decisions:

- [ ] richer remote tool-definition transport for renderers/behavior, not only metadata
- [ ] autocomplete provider stacking
- [ ] header/footer component transport
- [ ] custom editor transport
- [ ] editor text readback transport
- [ ] terminal input subscription transport
- [ ] tools-expanded readback
- [ ] theme listing and theme selection
- [ ] import-session commands over remote protocol
- [ ] streaming bash transport and external bash-result recording transport

## Recommended Order

1. [ ] `importFromJsonl()` protocol + implementation parity
2. [ ] tighten compaction and bash semantics to full local parity
3. [ ] export parity
4. [ ] tool-definition and extension-handler introspection parity
5. [ ] remote server UI protocol/readback parity
6. [ ] UI protocol decisions for autocomplete/header/footer/editor/terminal/theme readback

## Testing Follow-Up

When implementing each gap, prefer parity tests that compare remote behavior against local semantics.

Minimum expected future coverage:

- [x] remote `fork(..., { withSession })` executes on replacement context
- [x] remote fork-message enumeration parity
- [x] remote client tool-definition lookup for client overrides
- [x] remote reload refreshes mirrored skills/prompts/themes
- [x] remote queue/compaction/retry/passive extension event forwarding
- [x] remote `navigateTree(...)` changes branch state and updates session snapshot
- [ ] remote `importFromJsonl(...)` matches local cwd/import/replacement behavior
- [x] remote session can start/abort compaction
- [x] remote session can execute/abort bash
- [x] remote `getToolDefinition()` returns transported authoritative remote tool metadata
- [x] remote `compact()` emits same lifecycle and replacement semantics as local
- [x] remote bash execution now has durable lifecycle streaming parity for client chunk handling
- [x] remote pending bash messages now flush into transcript before next prompt for all attached clients
- [x] remote `recordBashResult()` preserves immediate vs deferred bash-message ordering
- [ ] remote `getToolDefinition()` preserves remote-only renderer/behavior parity, not only metadata
- [ ] remote export/import round-trip tests
- [ ] explicit capability-gated tests for every unsupported UI primitive until implemented
