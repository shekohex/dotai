# Remote mode

`pi --mode remote` exposes a pi agent session over a TCP socket using the same JSON line protocol as `pi --mode rpc`, so other applications can drive pi over an SSH port-forward instead of stdio. There is no subprocess and no Python bridge — the session runs **in-process** via the pi SDK, the same approach the subagent-SDK lite runtime uses.

This mode replaced an earlier `pi_rpc_bridge.py` subprocess wrapper that was fragile (died on tunnel blips, dropped events via a hardcoded whitelist, couldn't detect idle, guessed at session state). Remote mode fixes all four at the root: pi speaks the socket itself, `session.subscribe` streams every event unfiltered, `get_state` returns authoritative state, and a single in-process session can't orphan a subprocess.

`REMOTE.md` (repo root) is the authoritative protocol reference. This page summarizes the implementation.

## Implementation

| File                     | Role                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`             | `isRemoteMode(args)` intercepts before `main()`; `runRemoteMode()` then exits the process when done.                                      |
| `src/remote/mode.ts`     | TCP server: arg parsing, JSONL framing, auth handshake, ping/pong heartbeat, per-connection lifecycle, idle watcher, shutdown.            |
| `src/remote/commands.ts` | `createCommandHandler` — dispatches command types to direct `AgentSession` API calls.                                                     |
| `src/remote/session.ts`  | `createRemoteSession` — builds an in-process `AgentSession` with the full set of bundled extensions, a noop UI context, and mode `"rpc"`. |

## Lifecycle

1. Launch: `pi --mode remote --host 127.0.0.1 --port 0 --token <secret> --cwd /path [--remote-idle-timeout 300]`.
2. First stdout line (JSONL) is the handshake: `{"type":"ready","host":"127.0.0.1","port":<ephemeral>,"pid":<pid>}`. Read it, tunnel to `port`, connect, authenticate.
3. Every connection must send the token as its first line within 10s; on match it's authenticated and subscribed to the session event stream.
4. **Multi-controller fan-out:** multiple controllers may connect concurrently; each independently subscribes. A controller dropping does **not** kill the in-flight turn.
5. **Heartbeat:** the server pings every 10s when a client is idle; the client must `pong` within 5s or the connection is reaped.
6. **Idle timeout** (default 5 min): if the session is not streaming and has no pending messages, it disposes and the process exits.
7. `shutdown` command cleanly exits the process.

## Command surface

Commands map roughly to direct `AgentSession` calls: `prompt`, `steer` (real-time interjection), `follow_up` (queued after the current turn), `abort`, `get_state`, `get_messages`, `set_thinking_level`, and more (see `REMOTE.md`).

Notable constraints:

- `set_model` returns an error — the model is fixed at launch via `--model`.
- `prompt` responses are async: a prompt is accepted after preflight, then events stream afterwards.
- `session.subscribe` streams events unfiltered to all controllers.

## Security note

The token travels in cleartext over the TCP socket. The design assumes the connection is secured by an SSH port-forward (or equivalent) for encryption and authentication. There is no TLS in-process.
