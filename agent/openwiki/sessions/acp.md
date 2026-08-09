# ACP agent mode

`pi acp` exposes this wrapper's real bundled Pi agent over official Agent Client Protocol NDJSON on stdin/stdout. Human-readable diagnostics use stderr; stdout contains protocol frames only.

## Zed configuration

Configure a custom agent with:

```json
{
  "command": "pi",
  "args": ["acp"]
}
```

Pi expects provider credentials in normal local Pi configuration. ACP authentication methods are intentionally absent.

Experimental ACP v2 requires explicit opt-in and a client build that negotiates protocol version 2:

```json
{
  "command": "pi",
  "args": ["acp", "--experimental-acp-v2"]
}
```

Without `--experimental-acp-v2`, official router downgrades version-2 initialization to stable v1.

## Capability matrix

| Surface                              | Stable v1                                               | Experimental v2                                           |
| ------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------- |
| Session new/list/resume/close/delete | Yes                                                     | Yes                                                       |
| Session load/fork                    | Load and fork                                           | Fork; resume-from-start replaces load                     |
| Persisted replay                     | Yes                                                     | Yes                                                       |
| Prompt lifecycle                     | Request remains open until settled                      | Immediate acknowledgment, then running/idle updates       |
| Text and thought streaming           | Yes                                                     | Yes, stable per-turn message IDs                          |
| Tool lifecycle and images            | Yes                                                     | Yes                                                       |
| Bash terminal presentation           | Client terminal when advertised, otherwise local        | Local execution with agent-owned display-terminal updates |
| Direct file collaboration            | Client read/write/edit when advertised, otherwise local | Local tools only; v2 removed client filesystem methods    |
| Commands, templates, skills          | Live command catalog and normal Pi dispatch             | Live standard command updates and normal Pi dispatch      |
| Model, mode, thinking                | Config options                                          | Config options                                            |
| Extension interaction                | Form elicitation when advertised                        | Form elicitation with requires-action lifecycle           |
| Client MCP                           | Stdio                                                   | Stdio                                                     |
| Images                               | Prompt and result images                                | Prompt and result images                                  |
| Audio                                | Omitted                                                 | Omitted                                                   |
| Additional directories               | Omitted                                                 | Omitted                                                   |

Capabilities are omitted when semantics are incomplete. HTTP MCP, deprecated SSE MCP, ACP-transport MCP, audio, and additional workspace directories are not advertised.

## Commands and extensions

Each ACP session loads fresh instances of the complete bundled extension catalog. Available commands combine extension commands, prompt templates, skills, and headless adapters for Pi built-ins. `/reload` refreshes resources and republishes command discovery.

Commands requiring select, confirm, input, or editor UI use ACP form elicitation. If client lacks elicitation support, command fails explicitly instead of waiting for terminal UI.

## Files and shell

Stable v1 uses client filesystem operations for direct `read`, `write`, and `edit` when client advertises them. This preserves unsaved editor content for those operations. `find`, `grep`, listing, patch/FFF, and other custom mutators remain local and do not claim complete editor-buffer synchronization.

Path-oriented client-backed operations enforce session cwd. Additional directories remain unadvertised because not every local path tool shares that policy yet.

Shell execution is intentionally unsandboxed. v1 uses client terminal execution when advertised and local shell otherwise. v2 always uses local shell because client terminal execution was removed from protocol.

## MCP

Session requests may provide stdio MCP servers. Each managed session owns separate MCP clients and cleanup. Bundled tools win name collisions; colliding MCP tools receive deterministic `<server>__<tool>` names. Server startup failure affects only target session.

HTTP, SSE, and ACP MCP transports are rejected and not advertised.

## Architecture

Official SDK router owns framing, initialization, downgrade, and v2 batch handling. Thin v1/v2 adapters call one protocol-neutral `AcpAgentCore`. Core owns exact session lookup, prompt serialization, cancellation, replay, commands, config, content conversion, and cleanup. `src/headless/session.ts` constructs complete bundled Pi sessions for ACP and remote mode.

Mutable extension state is session-owned or keyed by session context. Modes, review, context pruning, workflow editor state, deferred tools, tmux sharing, GSD autocomplete, and subagent dashboard state have concurrent-session regression coverage.

## Troubleshooting

- Protocol parse errors: ensure wrappers/extensions never print banners or ANSI output to stdout. Run `pi acp` directly and inspect stderr separately.
- Missing model credentials: configure provider credentials through normal Pi setup; ACP login/logout is not advertised.
- Interactive command failure: client must advertise form elicitation.
- MCP startup failure: use absolute executable path and stdio transport. HTTP/SSE are unsupported.
- File rejection: direct client-backed paths must remain inside session cwd. Additional directories are not enabled.
- Missing unsaved-buffer changes: only direct v1 read/write/edit use client filesystem APIs; other tools read local disk.

## SDK maintenance

`@agentclientprotocol/sdk` is pinned exactly to `1.3.0`. Upgrades require rereading current v2 draft, rerunning v1/v2 conformance and subprocess suites, and repeating Zed v1 smoke against built artifact. Do not document successful Zed validation until manually recorded.
