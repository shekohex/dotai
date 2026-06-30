# Remote mode (`pi --mode remote`)

Remote mode exposes a pi agent session over a TCP socket using the same JSON line protocol as `pi --mode rpc`. It lets other applications control a pi process running on any machine over an SSH port-forward — no subprocess, no stdio coupling.

The session runs **in-process** via the pi SDK (`createAgentSession`), the same approach the subagent-SDK LiteRuntime uses, with control inverted: an external TCP controller drives the session instead of a parent agent.

## Quick start

```bash
pi --mode remote --host 127.0.0.1 --port 0 --token my-secret --cwd /path/to/project --remote-idle-timeout 300
```

First line on stdout (JSONL):

```json
{ "type": "ready", "host": "127.0.0.1", "port": 38419, "pid": 12345 }
```

Read that line, tunnel to `port`, connect, authenticate, then send commands.

## Why this exists

The earlier approach ran a Python bridge (`pi_rpc_bridge.py`) as a subprocess wrapping `pi --mode rpc`. It was fragile:

- **Died on tunnel blips** — controller disconnect killed the turn.
- **Dropped events** — a hardcoded event-type whitelist missed events the controller needed for idle detection.
- **Couldn't detect idle** — reconstructed state from the last system message instead of asking the session.
- **State hacks** — Python sat outside pi and guessed at session state.

Remote mode fixes all four at the root: pi speaks the socket itself, `session.subscribe` streams every event unfiltered, `get_state` returns authoritative session state, and a single in-process session can't orphan a subprocess.

## CLI flags

| Flag                          | Default         | Description                                                               |
| ----------------------------- | --------------- | ------------------------------------------------------------------------- |
| `--mode remote`               | —               | Required. Selects remote mode (intercepted before `main()`).              |
| `--host <addr>`               | `127.0.0.1`     | Bind host.                                                                |
| `--port <port>`               | `0`             | Bind port. `0` picks an ephemeral OS port, reported via the `ready` line. |
| `--token <secret>`            | —               | Required. Shared secret sent on the first line of every connection.       |
| `--cwd <dir>`                 | `process.cwd()` | Working directory for the agent session.                                  |
| `--remote-idle-timeout <sec>` | `300`           | Process idle shutdown timeout. `0` disables (runs forever).               |

Any other pi flags (`--provider`, `--model`, `--thinking`, etc.) pass through to the session as normal.

## Discovery

Remote mode emits exactly one JSONL line on stdout once the server is listening:

```json
{ "type": "ready", "host": "127.0.0.1", "port": 38419, "pid": 12345 }
```

Extension startup output (e.g. OSC escape sequences from terminal extensions) may precede this line. Read stdout line-by-line, parse each line as JSON, and pick the line where `type === "ready"`. Everything else on stdout is diagnostics.

## Connection lifecycle

### Multiple controllers

Multiple controllers may connect simultaneously. Events fan-out to all connected controllers (each `session.subscribe` independently). This avoids reconnect-during-long-running-sessions hitting a connection mutex — just connect again and you reattach to the live session.

During shutdown, new connections are rejected:

```json
{ "id": null, "ok": false, "error": "shutting down" }
```

### Authentication

The first line from the client must be an auth request:

```json
{ "id": "auth", "method": "auth", "params": { "token": "my-secret" } }
```

Response:

```json
{ "id": "auth", "ok": true }
```

On wrong/missing token:

```json
{ "id": null, "ok": false, "error": "unauthorized" }
```

The connection is closed. Auth must arrive within 10 seconds or the connection is dropped with `{"id":null,"ok":false,"error":"auth timeout"}`.

### Heartbeat (ping/pong)

To detect dead connections (half-open SSH tunnels, crashed clients, network partitions) that TCP keepalive alone misses, the server runs an app-layer heartbeat on each connection:

1. Every **10 seconds**, if the client has been idle (no message received), the server sends a `ping`:

   ```json
   { "type": "ping" }
   ```

2. The client must respond with a `pong` (or send any other message) within **5 seconds**:

   ```json
   { "type": "pong" }
   ```

3. If no response arrives within the 5-second deadline, the server assumes the client is gone and **closes that connection only**. The session and other controllers are unaffected.

**Any message from the client resets the heartbeat timer** — if you're actively sending commands or streaming, no pings are sent. Pings only fire when the client goes quiet.

Clients SHOULD:

- Respond to every `ping` with `pong` immediately.
- Treat a missed `pong` response as a signal that the server may have reaped them; reconnect.

Clients MAY ignore `ping` messages if they send traffic frequently enough to reset the timer naturally.

### Reconnect-safe

If the controller's socket drops mid-turn (tunnel blip, crash, reap):

- The **turn keeps running** to completion.
- The **session and port stay alive**.
- On reconnect, the new controller reattaches to the same live session.

Reconnect by authenticating again, then rebuilding state:

```json
{"id":"s1","type":"get_state"}
{"id":"m1","type":"get_messages"}
```

No event replay buffer. The session is the source of truth — `get_messages` returns the full message history, `get_state` returns current flags.

### Idle shutdown

When the session is idle (`isStreaming === false` AND `pendingMessageCount === 0`) for longer than `--remote-idle-timeout`, the process disposes the session and exits cleanly (code 0). This is a leak guard for long-lived sandbox processes.

Default: 300 seconds (5 minutes). `--remote-idle-timeout 0` disables it entirely (process runs forever until killed or sent `shutdown`).

### Clean shutdown

Send the `shutdown` command to stop the process gracefully:

```json
{ "id": "quit", "type": "shutdown" }
```

Response, then exit (code 0):

```json
{ "id": "quit", "type": "response", "command": "shutdown", "success": true }
```

Process signals also work: `SIGTERM`/`SIGINT` (143/130), `SIGHUP` (129 on non-Windows).

## Protocol

Same JSON line protocol as `pi --mode rpc`. Every message is one JSON object terminated by `\n`. Framing is LF-only (payloads may contain other Unicode separators; split on `\n` only).

### Commands (client → server)

Each command is a JSON object with a `type` field and an optional `id` for correlation.

#### Prompting

| Command       | Fields                                     | Notes                                                                       |
| ------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| `prompt`      | `message`, `images?`, `streamingBehavior?` | Async. Response emitted after preflight succeeds; events stream afterwards. |
| `steer`       | `message`, `images?`                       | Interrupt the current turn.                                                 |
| `follow_up`   | `message`, `images?`                       | Queue after the current turn.                                               |
| `abort`       | —                                          | Abort the current turn.                                                     |
| `new_session` | `parentSession?`                           | Always returns `{cancelled:true}` in remote mode.                           |

#### State

| Command                   | Returns                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `get_state`               | `RpcSessionState` — authoritative session state (see below).         |
| `get_messages`            | `{ messages: AgentMessage[] }` — full message history.               |
| `get_session_stats`       | `SessionStats` — token usage, cost.                                  |
| `get_last_assistant_text` | `{ text: string \| null }`.                                          |
| `get_commands`            | `{ commands: [] }` — extension commands not surfaced in remote mode. |

#### Model & thinking

| Command                | Notes                                                     |
| ---------------------- | --------------------------------------------------------- |
| `get_available_models` | `{ models: Model[] }`.                                    |
| `cycle_model`          | Returns `null` (no scoped models cycling in remote mode). |
| `set_thinking_level`   | `level`: `off\|minimal\|low\|medium\|high\|xhigh`.        |
| `cycle_thinking_level` | `{ level } \| null`.                                      |

#### Steering / follow-up queue modes

| Command              | Fields                          |
| -------------------- | ------------------------------- |
| `set_steering_mode`  | `mode`: `all \| one-at-a-time`. |
| `set_follow_up_mode` | `mode`: `all \| one-at-a-time`. |

#### Compaction

| Command               | Notes                                              |
| --------------------- | -------------------------------------------------- |
| `compact`             | `customInstructions?`. Returns `CompactionResult`. |
| `set_auto_compaction` | `enabled: boolean`.                                |

#### Retry

| Command          | Notes               |
| ---------------- | ------------------- |
| `set_auto_retry` | `enabled: boolean`. |
| `abort_retry`    | —                   |

#### Bash

| Command      | Notes                                                   |
| ------------ | ------------------------------------------------------- |
| `bash`       | `command`, `excludeFromContext?`. Returns `BashResult`. |
| `abort_bash` | —                                                       |

#### Session

| Command            | Notes           |
| ------------------ | --------------- |
| `set_session_name` | `name: string`. |

#### Remote-mode extension

| Command    | Notes                                          |
| ---------- | ---------------------------------------------- |
| `shutdown` | Remote-mode only. Clean process exit (code 0). |

#### Not supported in remote mode

These upstream rpc commands require a runtime host remote mode doesn't expose:

- `set_model` — returns `{success:false, error:"model changes not supported in remote mode"}`.
- `clone`, `export_html`, `fork`, `get_fork_messages`, `switch_session` — return `{success:false, error:"command not supported in remote mode"}`.

Set the model via `--model`/`--provider` flags at launch instead.

### Responses (server → client)

```json
{"id":"s1","type":"response","command":"get_state","success":true,"data":{...}}
```

On error:

```json
{ "id": "s1", "type": "response", "command": "get_state", "success": false, "error": "..." }
```

The `prompt` command is special: it's async. The success response is emitted only after preflight accepts the prompt:

```json
{ "id": "p1", "type": "response", "command": "prompt", "success": true }
```

If the prompt is rejected (e.g. another prompt already queued and `one-at-a-time` mode):

```json
{ "id": "p1", "type": "response", "command": "prompt", "success": false, "error": "..." }
```

### Events (server → client)

After a successful `prompt`/`steer`/`follow_up`, agent events stream as they occur. Every `AgentSessionEvent` is emitted unfiltered via `session.subscribe` to **all** connected controllers. Key types:

| Event                               | When                                                                |
| ----------------------------------- | ------------------------------------------------------------------- |
| `agent_start`                       | Turn begins.                                                        |
| `turn_start`                        | A turn within the agent loop starts.                                |
| `message_start`                     | A message (user/assistant/tool) begins.                             |
| `message_update`                    | Streaming delta. `assistantMessageEvent.delta` carries text chunks. |
| `message_end`                       | A message completes.                                                |
| `tool_execution_start`              | A tool call begins (`toolName` field).                              |
| `tool_execution_end`                | A tool call completes.                                              |
| `turn_end`                          | A turn completes. **Primary idle signal.**                          |
| `agent_end`                         | The agent loop finishes.                                            |
| `compaction_start`/`compaction_end` | Context compaction.                                                 |
| `auto_retry_start`/`auto_retry_end` | Auto-retry on transient errors.                                     |
| `queue_update`                      | Steering/follow-up queue changed.                                   |
| `session_info_changed`              | Session metadata changed.                                           |
| `thinking_level_changed`            | Thinking level changed.                                             |

In addition to agent events, the server sends heartbeat probes:

| Message | When                                                                       |
| ------- | -------------------------------------------------------------------------- |
| `ping`  | Client idle > 10s. Client must respond with `pong` within 5s or be reaped. |

#### Idle detection

Two reliable ways to detect idle:

1. **Event-based (preferred):** listen for `turn_end` and/or `agent_end`.
2. **Poll-based:** send `get_state` and check `isStreaming === false && pendingMessageCount === 0`.

Note: immediately after `turn_end`, `isStreaming` may read `true` for a brief moment before flipping. `pendingMessageCount === 0` is the stable signal; the event-based approach has no such race.

### `RpcSessionState`

Returned by `get_state`:

```typescript
{
  model: Model | undefined;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile: string | undefined;
  sessionId: string;
  sessionName: string | undefined;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}
```

## TCP tuning

Every accepted socket is configured for low-latency, robust connectivity over SSH tunnels:

- `setNoDelay(true)` — disables Nagle's algorithm so small JSON lines flush immediately.
- `setKeepAlive(true, 15000)` — keepalive probes every 15s detect dead/half-open tunnels so `close` fires promptly.
- `setTimeout(0)` — no inactivity read timeout; idle semantics are owned by the idle watcher.
- `SO_REUSEADDR` — Node default.

Output writes are fire-and-forget. A backed-up socket never stalls the agent turn. A dead socket surfaces as `close`/`error`, handled by the connection teardown.

## Client example

Minimal Node.js client with heartbeat support:

```javascript
import net from "node:net";

function connectRemote(host, port, token) {
  const sock = net.createConnection({ host, port });
  const pending = new Map();
  const listeners = new Set();
  let buf = "";
  let authed = false;
  let nextId = 1;

  const send = (obj) => sock.write(JSON.stringify(obj) + "\n");
  const command = (type, extra = {}) =>
    new Promise((resolve, reject) => {
      const id = `c${nextId++}`;
      pending.set(id, { resolve, reject });
      send({ id, type, ...extra });
    });

  sock.on("data", (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      // Heartbeat: respond to pings immediately.
      if (msg.type === "ping") {
        send({ type: "pong" });
        continue;
      }

      if (!authed) {
        if (msg.ok === true) {
          authed = true;
          continue;
        }
        if (msg.ok === false) {
          sock.destroy();
          throw new Error("auth failed");
        }
        continue;
      }

      if (msg.type === "response" && pending.has(msg.id)) {
        pending.get(msg.id).resolve(msg);
        pending.delete(msg.id);
      } else {
        // Event — forward to listeners
        for (const l of listeners) l(msg);
      }
    }
  });

  return new Promise((resolve, reject) => {
    sock.on("connect", () => send({ id: "auth", method: "auth", params: { token } }));
    sock.on("error", reject);
    setTimeout(
      () =>
        authed
          ? resolve({
              command,
              onEvent: (fn) => listeners.add(fn),
              close: () => sock.end(),
            })
          : reject(new Error("auth timeout")),
      5000,
    );
  });
}

// Usage
const remote = await connectRemote("127.0.0.1", 38419, "my-secret");

remote.onEvent((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent?.delta) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
  if (event.type === "turn_end") console.log("\n[turn complete]");
});

await remote.command("prompt", { message: "What files are in this project?" });
```

## Deployment over SSH

On the remote sandbox:

```bash
pi --mode remote --host 127.0.0.1 --port 0 --token "$REMOTE_TOKEN" --cwd "$PROJECT"
```

The `ready` line prints the bound port. Forward it:

```bash
ssh -L ${LOCAL_PORT}:${BOUND_PORT} sandbox-host
```

On the local machine, connect to `127.0.0.1:${LOCAL_PORT}`. The SSH tunnel encrypts the token; no TLS needed.

For automated launchers: parse the `ready` line from stdout, extract `port`, establish the tunnel, then connect.

## Architecture

```
cli.ts  ──isRemoteMode()──▶  runRemoteMode()
                                 │
                                 ├─ createRemoteSession()        [session.ts]
                                 │    ├─ DefaultResourceLoader   (full bundled extensions)
                                 │    ├─ createAgentSession()    (in-process SDK)
                                 │    └─ session.bindExtensions  (noop UI context, mode "rpc")
                                 │
                                 ├─ createCommandHandler()       [commands.ts]
                                 │    └─ direct session API      (prompt/steer/abort/get_state/...)
                                 │
                                 ├─ net.createServer             [mode.ts]
                                 │    ├─ token auth handshake
                                 │    ├─ multi-controller fan-out (events → all conns)
                                 │    ├─ per-conn heartbeat (ping @10s, pong deadline 5s)
                                 │    └─ per-conn: session.subscribe → socket
                                 │
                                 └─ idle watcher                 (5min default → shutdown)
```

Files:

- `src/cli.ts` — intercepts `--mode remote` before `main()`.
- `src/remote/mode.ts` — TCP server, CLI args, JSONL framing, connection/auth/idle handling.
- `src/remote/session.ts` — in-process session construction (LiteRuntime pattern).
- `src/remote/commands.ts` — RPC command dispatcher over the direct session API.

No patch-package. No upstream edits. Pure wrapper code using the exported pi SDK.
