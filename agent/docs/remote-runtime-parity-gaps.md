# Remote Runtime Parity Gaps

This document tracks remaining gaps between local standalone session/runtime behavior and current remote runtime behavior.

Scope here is runtime and session parity, not product decisions.

## Current Status

Remote session replacement semantics now match upstream more closely:

- replacement session is rebound before `withSession(...)`
- replacement context is real runner-backed command context
- remote no longer fabricates replacement-session fallback context

This is not full parity yet.

## Remaining Gaps

### Session Runtime APIs

- [ ] `fork()` is still stub-cancelled in remote runtime
  - file: `src/remote/client/runtime.ts`
  - current behavior: always returns `{ cancelled: true }`
  - parity target: implement same replacement-session flow as local runtime, including `withSession(...)`

- [ ] `importFromJsonl()` is still stub-cancelled in remote runtime
  - file: `src/remote/client/runtime.ts`
  - current behavior: always returns `{ cancelled: true }`
  - parity target: import session data and bind replacement session like local runtime

### Session Navigation And Branching

- [ ] `navigateTree()` is still stub-cancelled on remote session
  - file: `src/remote/client/session/capabilities-api.ts`
  - current behavior: always returns `{ cancelled: true }`
  - parity target: support branch navigation and tree operations over remote protocol

- [ ] `getUserMessagesForForking()` returns empty list
  - file: `src/remote/client/session/capabilities-api.ts`
  - current behavior: no fork source enumeration available remotely
  - parity target: expose same forking source data as local session

### Compaction

- [ ] `compact()` is unsupported on remote session
  - file: `src/remote/client/session/capabilities-api.ts`
  - current behavior: rejects with unsupported error
  - parity target: allow compaction start, completion, abort, and replacement-session behavior consistent with local runtime

- [ ] `abortCompaction()` is no-op
  - file: `src/remote/client/session/capabilities-api.ts`
  - parity target: cancel active remote compaction when supported

### Bash Execution

- [ ] `executeBash()` is unsupported on remote session
  - file: `src/remote/client/session/capabilities-api.ts`
  - current behavior: rejects with unsupported error
  - parity target: either true remote bash parity or explicit documented boundary if remote intentionally forbids local execution

- [ ] `recordBashResult()` is no-op
  - file: `src/remote/client/session/capabilities-api.ts`

- [ ] `abortBash()` is no-op
  - file: `src/remote/client/session/capabilities-api.ts`

- [ ] `isBashRunning` always `false`
  - file: `src/remote/client/session/capabilities-api.ts`

- [ ] `hasPendingBashMessages` always `false`
  - file: `src/remote/client/session/capabilities-api.ts`

### Export And Import Surface

- [ ] `exportToHtml()` is unsupported
  - file: `src/remote/client/session/capabilities-api.ts`

- [ ] `exportToJsonl()` is unsupported
  - file: `src/remote/client/session/capabilities-api.ts`

- [ ] runtime-level `importFromJsonl()` is stubbed
  - file: `src/remote/client/runtime.ts`

### Tool And Extension Introspection

- [ ] `getToolDefinition()` returns `undefined`
  - file: `src/remote/client/session/capabilities-api.ts`
  - parity target: return authoritative tool definition data for active remote tool registry

- [ ] `hasExtensionHandlers()` always returns `false`
  - file: `src/remote/client/session/capabilities-api.ts`
  - parity target: reflect actual locally loaded client-extension runner state

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

- [ ] `ctx.ui.getAllThemes()` returns empty list
  - file: `src/remote/session/ui-context.ts`

- [ ] `ctx.ui.getTheme()` returns `undefined`
  - file: `src/remote/session/ui-context.ts`

### Protocol / Capability Follow-Up

Some gaps are likely protocol gaps, not only implementation gaps.

Areas needing protocol decisions:

- [ ] autocomplete provider stacking
- [ ] header/footer component transport
- [ ] custom editor transport
- [ ] terminal input subscription transport
- [ ] tools-expanded readback
- [ ] theme listing and theme selection
- [ ] tree navigation and fork/import session commands if server does not yet expose them directly

## Recommended Order

1. [ ] `fork()` parity
2. [ ] `navigateTree()` parity
3. [ ] `compact()` parity
4. [ ] tool-definition and extension-handler introspection parity
5. [ ] import/export parity
6. [ ] UI protocol decisions for autocomplete/header/footer/editor/terminal/theme

## Testing Follow-Up

When implementing each gap, prefer parity tests that compare remote behavior against local semantics.

Minimum expected future coverage:

- [ ] remote `fork(..., { withSession })` executes on replacement context
- [ ] remote `navigateTree(...)` changes branch state and updates session snapshot
- [ ] remote `compact()` emits same lifecycle and replacement semantics as local
- [ ] remote `getToolDefinition()` returns structured tool metadata
- [ ] remote export/import round-trip tests
- [ ] explicit capability-gated tests for every unsupported UI primitive until implemented
