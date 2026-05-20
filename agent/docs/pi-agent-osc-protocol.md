# Pi Agent OSC Protocol V1

Pi agent emits versioned OSC frames for terminal hosts that want native agent state without scraping terminal text.

## Wire Format

```text
ESC ] 6767 ; pi ; 1 ; <event-name> ; <base64url-json> ST
```

Compact form:

```text
\u001b]6767;pi;1;<event-name>;<base64url-json>\u001b\\
```

Android also accepts BEL terminated frames:

```text
\u001b]6767;pi;1;<event-name>;<base64url-json>\u0007
```

Fields:

| Field       | Value                                                           |
| ----------- | --------------------------------------------------------------- |
| OSC command | `6767`                                                          |
| Namespace   | `pi`                                                            |
| Version     | `1`                                                             |
| Event name  | V1 event routing key                                            |
| Payload     | UTF-8 JSON envelope encoded with base64url, no padding required |

Default terminator is `ST` (`ESC \`). Android accepts `BEL` for compatibility.

## Valid Fixture

Envelope JSON:

```json
{
  "id": "evt-1",
  "ts": 1779200000000,
  "source": "agent",
  "sessionId": "session-1",
  "cwd": "/workspace",
  "seq": 1,
  "data": { "protocol": 1 }
}
```

Encoded frame:

```text
\u001b]6767;pi;1;hello;eyJpZCI6ImV2dC0xIiwidHMiOjE3NzkyMDAwMDAwMDAsInNvdXJjZSI6ImFnZW50Iiwic2Vzc2lvbklkIjoic2Vzc2lvbi0xIiwiY3dkIjoiL3dvcmtzcGFjZSIsInNlcSI6MSwiZGF0YSI6eyJwcm90b2NvbCI6MX19\u001b\\
```

BEL variant:

```text
\u001b]6767;pi;1;hello;eyJpZCI6ImV2dC0xIiwidHMiOjE3NzkyMDAwMDAwMDAsInNvdXJjZSI6ImFnZW50Iiwic2Vzc2lvbklkIjoic2Vzc2lvbi0xIiwiY3dkIjoiL3dvcmtzcGFjZSIsInNlcSI6MSwiZGF0YSI6eyJwcm90b2NvbCI6MX19\u0007
```

## Envelope

Every V1 payload is a JSON object:

```json
{
  "id": "uuid-or-short-id",
  "ts": 1779200000000,
  "source": "agent",
  "sessionId": "session-id",
  "cwd": "/workspace",
  "seq": 42,
  "data": {}
}
```

Required fields:

| Field    | Type   | Rule                                         |
| -------- | ------ | -------------------------------------------- |
| `id`     | string | Stable event id, bounded display-safe string |
| `ts`     | number | Unix epoch milliseconds                      |
| `source` | string | Must be `agent`                              |
| `data`   | object | Event-specific compact payload               |

Optional fields:

| Field       | Type   | Rule                                          |
| ----------- | ------ | --------------------------------------------- |
| `sessionId` | string | Agent session id when available               |
| `cwd`       | string | Current working directory when available      |
| `seq`       | number | Monotonic per-session sequence when available |

Do not include full prompts, assistant messages, raw tool output, clipboard contents, provider payloads, secrets, or unbounded strings.

## V1 Events

Allowed event names:

| Event              | Purpose                                   | Payload                                                             |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------------- |
| `hello`            | Protocol handshake and extension metadata | `protocol`, `extension`, `version`                                  |
| `agent.session`    | Session lifecycle metadata                | `state`, `reason`                                                   |
| `agent.run`        | Agent run start/end state                 | `state`                                                             |
| `agent.turn`       | Turn start/end state                      | `state`, `turnIndex`                                                |
| `agent.progress`   | Bounded progress state                    | `state`                                                             |
| `agent.tool`       | Tool execution start/end summary          | `toolCallId`, `toolName`, `state`, `isError?`, `label?`, `summary?` |
| `agent.alert`      | Terminal-worthy alert                     | `kind`, `title`, `body`, `severity`, `statusCode?`                  |
| `agent.compaction` | Context compaction lifecycle              | `state`                                                             |

Unknown event names are invalid for V1. Android discards them and never renders raw OSC data.

## Bounds

Full OSC frame length must stay below Android parser cap `8192` bytes. Agent encoders should reject or drop frames at or above that cap before writing to terminal output.

Event names must be short allowlisted ASCII routing keys. Payloads must be base64url text only. Semicolons and control characters inside JSON cannot affect OSC field parsing because JSON is encoded before framing.

## Android Behavior

Android recognizes only `6767;pi;1;` frames for Pi OSC V1. Valid frames are decoded and validated in Kotlin before affecting UI state.

Malformed frames are discarded:

- Wrong command, namespace, or version.
- Unknown event name.
- Invalid base64url.
- Invalid UTF-8 JSON.
- Missing required envelope fields.
- `source` not equal to `agent`.
- Oversized raw or decoded payload.

Discarded frames must never render raw data to terminal UI. Debug builds may log a bounded sanitized reason.

Existing OSC behavior remains unchanged: OSC 9 notification/progress, OSC 52 clipboard, and OSC 777 notification keep their current behavior.

## Tmux Passthrough

When Pi runs inside tmux, emit Pi OSC through the existing terminal helper path where possible:

```text
ESC P tmux ; ESC <pi-osc-frame-with-ESC-doubled> ST
```

The agent should reuse `createTmuxPassthroughSequence`, tmux pane/client TTY selection, and SSH handling from the terminal notification/tmux UI helpers instead of hand-rolling tmux behavior.

Pi OSC is emitted unconditionally by the controlled bundled extension when loaded. Terminals that do not understand `OSC 6767` should ignore it as normal unknown OSC metadata.
