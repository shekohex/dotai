# Remote Session Authority Checklist

## Goal

Make remote mode fully server-authoritative for sessions while preserving standalone Pi UX.

In remote mode:

- server owns session files, session indexing, runtime lifecycle, resume/switch/fork/archive/delete behavior, authoritative `cwd`, settings, resources, and command ordering
- client owns only TUI rendering, local input surfaces, local notifications, local stream cursors, and mirrored in-memory state needed for UI compatibility
- standalone mode keeps current local behavior unchanged

## Locked Decisions

- Keep standalone mode behavior unchanged.
- Add remote mode on top of existing UX rather than replacing standalone mode.
- Use server-owned `sessionId` as public identifier in remote mode.
- Do not expose absolute server session file paths to clients.
- Reuse existing Pi JSONL session file format first.
- Server persists sessions on its own filesystem.
- Server boot must scan session storage and build an in-memory session index.
- Server must separate durable session catalog from loaded in-memory runtimes.
- Not every durable session needs a loaded runtime.
- Client session state in remote mode is a mirror only, never authority.
- Remote `--no-session` means ephemeral server-side in-memory session.
- Remote `--session-dir` is not client-controlled and should be rejected or ignored in remote mode.
- Remote `--export` is deferred until a server-backed export API exists.
- Remote `--session`, `--resume`, `--continue`, `--fork`, and related UX flags must map to server requests.
- Remote mode needs explicit server workspace selection semantics for new-session and continue flows.
- Server `cwd` is authoritative and must not silently fall back to client `process.cwd()` semantics.
- Server watcher is secondary reconciliation, not primary mutation path.
- Primary server mutations must update catalog/index synchronously in-process.
- File watching is required to detect out-of-band file adds, removals, and edits under server session storage.
- Loaded runtime hot-reload on external file changes is only safe when runtime is idle.
- External file changes during active runs must mark session dirty/conflicted rather than auto-merging mid-turn.
- Archive and delete are first-class server lifecycle operations, not client-local file operations.
- Load the `librarian` skill and scoped files for this plan for `badlogic/pi-mono`.

## Target Architecture

- `SessionCatalog`: all durable server sessions, including unloaded sessions
- `LoadedRuntimeRegistry`: active in-memory runtimes only
- `SessionCatalog` stores summary metadata and `sessionId -> sessionPath` mapping
- `LoadedRuntimeRegistry` lazily loads `AgentSessionRuntime` from catalog entries when attach or command requires it
- Durable event streams remain transport/replay mechanism, not durable session catalog

## Remote CLI Semantics

- `--session <id|query>` attaches to specific server session
- `--resume` fetches server session list and opens picker from server results
- `--continue` continues latest session for selected server workspace
- `--fork <sessionId>` forks session on server
- `--no-session` creates ephemeral server session
- `--remote-session` remains temporary alias for remote `--session`
- `--session-dir` is invalid in remote mode
- `--export` is invalid in remote mode until server export exists

## Workspace Semantics

- Remote mode must define server workspace identity explicitly
- New session and continue flows must target a server workspace, not client local cwd implicitly
- Workspace selection can be represented by server workspace id, explicit server cwd, or another server-owned workspace key
- Session summaries must include authoritative server `cwd`

## Catalog Semantics

- Catalog loads at server boot from server session storage
- Catalog must include persistent sessions even when no runtime is loaded
- Catalog entries must track `sessionId`, `sessionPath`, `cwd`, `name`, `createdAt`, `modifiedAt`, parent linkage, persistence mode, and lifecycle status
- Catalog must support list, lookup, search, archive, restore, delete, and summary refresh
- Catalog is authoritative source for remote session picker and resume flows

## Runtime Semantics

- Runtime load is lazy by `sessionId`
- Runtime creation must use server session `cwd` before building cwd-bound services
- Idle runtime eviction is required so durable sessions can outnumber loaded runtimes
- Runtime unload must not remove durable session catalog entry
- Ephemeral sessions may be unloaded and destroyed by detach or TTL policy

## Watcher Semantics

- Watch server session root recursively
- Debounce file-system events before reconciliation
- Reconcile added, removed, renamed, and modified session files into catalog
- Emit app-level session summary events when catalog changes
- Reload idle loaded runtimes when corresponding session file changes externally
- Mark loaded running runtimes dirty/conflicted when session file changes externally during an active run

## Archive And Delete Semantics

- Archive must work for loaded and unloaded sessions
- Delete must work for loaded and unloaded sessions
- Archive should remove session from default active list while preserving restore path
- Delete should hard-remove durable session data and invalidate future attach attempts
- Archive and delete must emit app-level session events so all clients refresh lists promptly

## Ephemeral Session Semantics

- Ephemeral remote sessions are server-memory-only
- Ephemeral sessions are not persisted to server disk
- Ephemeral sessions are not part of durable boot index after restart
- Ephemeral sessions should be hidden from normal persisted session list or clearly labeled
- Ephemeral session cleanup policy must be explicit: destroy on last detach, TTL expiry, or daemon shutdown

## Client Responsibilities In Remote Mode

- render server-authoritative transcript and state
- send commands and mutations to server
- maintain local mirrored in-memory session state only for TUI compatibility
- maintain connection-local active session selection
- never read or write remote session files directly
- never derive authoritative remote session list from local disk

## Server Responsibilities In Remote Mode

- own session persistence and indexing
- own runtime lifecycle
- own session switching, resume, fork, import, archive, restore, and delete flows
- own authoritative `cwd`, settings, resources, prompts, and tools
- own session list/search results
- own app/session event streams

## Incremental Implementation Checklist

### Phase 1: Catalog Foundation

- [x] Add server `SessionCatalog` abstraction
- [x] Define catalog record schema and in-memory index
- [x] Scan server session storage on boot and build index
- [x] Map `sessionId -> sessionPath` internally on server
- [x] Add APIs for session listing and summary lookup from catalog
- [x] Return authoritative server `cwd` and lifecycle metadata in summaries

### Phase 2: Lazy Runtime Loading

- [x] Add `LoadedRuntimeRegistry`
- [x] Load runtime lazily from catalog on attach or command
- [x] Keep unloaded sessions listable and searchable
- [x] Rebuild cwd-bound services from server session `cwd`
- [x] Add runtime eviction for inactive sessions

### Phase 3: Remote CLI Parity

- [x] Extend remote CLI parser to accept same session UX flags as standalone mode
- [x] Map remote `--session` to server session attach by `sessionId` or search result
- [x] Map remote `--resume` to server-backed picker
- [x] Map remote `--continue` to server latest-session lookup for workspace
- [x] Map remote `--fork` to server fork endpoint
- [x] Map remote `--no-session` to server ephemeral session creation
- [x] Reject remote `--session-dir`
- [x] Reject or defer remote `--export`

### Phase 4: Workspace Targeting

- [x] Define remote workspace identifier in API and CLI
- [x] Require workspace target for remote new-session and continue flows
- [x] Ensure server summaries and snapshots expose authoritative workspace cwd

### Phase 5: Archive And Delete

- [x] Add archive endpoint and catalog state
- [x] Add restore endpoint and catalog state
- [x] Add delete endpoint and catalog state
- [x] Support archive/delete for loaded sessions
- [x] Support archive/delete for unloaded sessions
- [x] Emit app-stream events for archive/restore/delete changes

### Phase 6: Watcher And Reconciliation

- [x] Add recursive watcher on server session storage
- [x] Debounce and reconcile add/remove/change events into catalog
- [x] Update summaries for externally modified files
- [x] Reload idle runtimes after external file changes
- [x] Mark running runtimes dirty/conflicted on external modifications
- [x] Emit app-stream refresh events for watcher-driven changes

### Phase 7: Ephemeral Remote Sessions

- [x] Add explicit persistence mode to server session creation
- [x] Support server ephemeral sessions backed by in-memory `SessionManager`
- [x] Define list visibility rules for ephemeral sessions
- [x] Define cleanup policy for ephemeral sessions

### Phase 8: Hardening

- [x] Add boot-time recovery tests for persistent session catalog
- [x] Add watcher reconciliation tests for add/remove/change flows
- [x] Add CLI parity tests for remote session flags
- [x] Add archive/delete multi-client update tests
- [x] Add runtime eviction and reload tests
- [x] Add dirty/conflicted external-change tests

## Explicit Non-Goals For First Iteration

- SQLite or separate metadata database before file-backed catalog proves insufficient
- client ownership of remote session files
- exposing absolute server paths in public APIs
- auto-merging external file edits into an active running session mid-turn

## Exit Criteria

- client can list, search, resume, switch, fork, archive, restore, and delete server sessions without local file access
- client can start remote persistent and remote ephemeral sessions using familiar CLI flags
- server can restart, rebuild catalog from disk, and continue serving session lists and attaches
- idle sessions remain durable and listable even when no runtime is loaded
- standalone mode remains behaviorally unchanged
