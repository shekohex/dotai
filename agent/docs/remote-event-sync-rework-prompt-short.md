Role: Senior TypeScript systems engineer in this repo. Rework remote event sync so remote Pi reaches practical parity with standalone `npm run pi` and stays smooth on unreliable mobile networks. You may redesign protocol and internals for efficiency and correctness. Do not preserve obsolete backward compatibility unless required by evidence.

Use these as primary context, YOU MUST READ THEM FIRST:

- @docs/remote-event-sync-rework-prompt.md
- @docs/remote-event-sync-architecture.md
- @QA.md

Goal:

- make remote architecture doc true in code
- keep stock upstream `InteractiveMode` as remote UI host
- keep server authoritative for runtime, tools, auth, providers, sessions, and extension runtime behavior
- keep client limited to current viewed-session projection plus minimum resume metadata
- make protocol lightweight, incremental, resumable when cheap, snapshot-fallback when needed
- make reconnect, network switching, lag, and restart normal supported cases
- keep server memory bounded with many sessions and clients

Constraints:

- follow upstream Pi for runtime/session/interactive semantics; use `librarian` skill for upstream Pi and `opencode` lookups when useful
- borrow `opencode` transport/reconnect/reducer patterns without cargo-culting APIs
- do not try hard to preserve current or legacy remote protocol shapes; cleaner, smaller, simpler protocol wins
- every client/server boundary crossing must use shared strict contracts and TypeBox validation
- no weak typing, dynamic typing, ad hoc `unknown` walking, `Object` probing, `Reflect`, or manual schema branching
- use Hono RPC for request/response client-server interaction; SSE is the only expected exception
- avoid replay-heavy designs that require client to process all historical transient events to become usable
- avoid unbounded retention; per-session and per-connection buffering must be capped and replaceable updates coalesced where safe
- preserve or improve extension support; runtime execution stays server-side

Required parity:

- prompt flow, assistant streaming, tool execution start/update/end, bash, steer/follow-up, abort, model/mode/thinking changes, rename, new/switch/fork/clone, tree navigation/summary, compaction, retry, extension UI requests/responses, extension custom events, resource sync, reconnect during run, reconnect after completion, restart recovery for interrupted runtime domains

Validation is mandatory:

- targeted unit/integration coverage for protocol, reducers, reconnect, lag, snapshot fallback, incremental patching
- harness validation for parity where appropriate
- tmux-driven end-to-end validation proving real client-server behavior

Tmux requirements:

- use session name `pi-remote-e2e`
- validate with `npm run pi:server`, `npm run pi:remote`, and `npm run pi`
- run server and remote client in separate named panes/windows
- drive client with `tmux send-keys`
- collect UI and server evidence with `tmux capture-pane`
- compare remote visible behavior against standalone Pi
- treat tmux-visible mismatch as real parity failure even if unit tests pass

Required e2e scenarios:

- normal prompt/tool workflow
- large streaming output
- hot tool output updates
- reconnect mid-stream
- reconnect after server finished while client was behind
- server restart recovery
- session switching and forking
- extension UI flow
- queue and interrupt under active run
- repeated attach/detach or multi-client fanout
- memory-bounded behavior under hot streaming updates

Delivery rules:

- update architecture doc to reflect implemented architecture and evidence, not future-plan language
- after each meaningful feature or bug-fix increment, run relevant tests and commit validated changes
- do not stop at partial refactor, partial docs, or green unit tests alone
- do not stop if protocol is still heavyweight, replay-heavy, or if server memory lacks clear bounds
- if blocked, state exact blocker, missing capability, and evidence
