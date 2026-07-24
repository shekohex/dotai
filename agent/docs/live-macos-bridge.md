# Pi Live macOS bridge

Pi Live ports OMP's `/live` conversation and delegation flow to this Pi wrapper while moving the WebRTC media peer to a native macOS app.

## Architecture

```text
Mac: Pi Live.app
  CoreAudio/WebRTC microphone + speaker
  oai-events WebRTC data channel
  JSON-RPC pairing client
            │
            │ WSS directly, through Coder, or through an SSH local forward
            ▼
Workspace: src/extensions/live
  session-scoped pairing server
  ChatGPT OAuth or CLIProxyAPI auth
  authenticated Codex SDP signaling
  authenticated OpenAI sideband WebSocket
  Pi delegation and terminal visualizer
            │
            ├── SDP signaling + sideband ── OpenAI
            └── Pi custom message ───────── active AgentSession

Mac WebRTC media ────────────────────────── OpenAI
```

Audio never travels through the terminal, Pi JSON-RPC, SSH stdio, Coder PTY, or Herdr.

## Start

```text
/live
/live local
/live coder
/live ssh target=pi.coder
/live direct host=10.0.0.20
```

Optional voice:

```text
/live auto voice=sol
```

## Settings

Global defaults live under `settings.json#live` and are seeded from `src/default-settings.ts`:

```json
{
  "live": {
    "enabled": true,
    "identity": {
      "firstName": "Shady",
      "lastName": "Khalifa",
      "username": "shekohex"
    },
    "voice": "spruce",
    "transport": "coder",
    "sshTarget": "",
    "directHost": "",
    "pairingTtlMs": 120000,
    "heartbeatMs": 10000,
    "appOpenTimeoutMs": 25000
  }
}
```

Identity fields can be cleared to fall back to the workspace OS account. Command arguments override transport, SSH target, direct host, and voice for one call.

`/live` starts an ephemeral server, prints a `pi-live://pair#...` URL, and replaces the editor with the OMP-derived visualizer. Press Enter to copy the pairing URL with OSC 52, Space to mute, or Escape to end.

## Adapters

| Adapter  | Behavior                                                                                                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`  | Connects to `ws://127.0.0.1:<port>/live`.                                                                                                                                                     |
| `coder`  | Connects to the Coder wildcard `wss://<port>--<agent>--<workspace>--<owner>.../live` URL. The app sends `Coder-Session-Token` from Keychain.                                                  |
| `ssh`    | The app launches `/usr/bin/ssh -N -L <local>:127.0.0.1:<remote> <target>` and connects to the local forwarded port. Standard `~/.ssh/config`, including `coder config-ssh` hosts, is honored. |
| `direct` | Connects directly to a private/LAN host supplied with `host=`.                                                                                                                                |
| `auto`   | Publishes every valid descriptor. The app tries Coder, SSH, local, then direct.                                                                                                               |

The Coder token is sent as a header, not as `?coder_session_token=...`, so it does not enter pairing URLs or normal proxy logs.

## Authentication

The Swift app never receives ChatGPT credentials.

The TypeScript extension resolves Codex auth in this order:

1. `openai-codex` provider OAuth from Pi's model registry, including refresh.
2. The selected CLIProxyAPI Codex account used by `openusage`.
3. The first available CLIProxyAPI Codex account.

It extracts `chatgpt-account-id`, performs the authenticated SDP request, and opens the authenticated sideband WebSocket in the workspace.

## Pairing security

- 32-byte random secret.
- Secret and endpoint payload are in the URI fragment.
- Two-minute expiry.
- One successful client only.
- Constant-time secret comparison.
- Pairing server closes with the live session.
- No ChatGPT token, SDP, or transcript is included in the pairing URL.
- Coder tokens are stored in macOS Keychain.

## Delegation

`delegation.created` becomes:

```ts
pi.sendMessage(
  {
    customType: "live-delegation",
    content: request,
    display: true,
    details: { delegationId },
  },
  { triggerTurn: true, deliverAs: "steer" },
);
```

Assistant tool-use messages are appended to the live delegation as silent commentary. The final assistant response is sent after `agent_settled` as speakable context.

The PoC permits one active coding delegation. The live model is instructed not to open a second independent delegation while work is active.

## macOS app

The app source is in `macos/PiLive`.

```bash
cd macos/PiLive
./scripts/build-app.sh
open '.build/Pi Live.app'
```

The app uses SwiftUI, macOS Keychain, `/usr/bin/ssh`, and the WebRTC XCFramework from `stasel/WebRTC`. WebRTC owns microphone capture, Opus encoding, RTP transport, remote Opus decoding, echo cancellation, and speaker playback.

## First macOS validation

The first validation must prove the split-host assumption:

1. Start Pi in a Linux Coder workspace.
2. Run `/live coder` or `/live ssh target=<workspace>.coder`.
3. Pair the Mac app.
4. Confirm authenticated signaling succeeds from Linux using an SDP offer created on Mac.
5. Confirm the `oai-events` data channel opens.
6. Confirm Mac microphone audio reaches OpenAI and output plays through Mac speakers.
7. Ask for a repository task and verify `delegation.created` triggers the active Pi session.
8. Verify the final Pi result is spoken by the live model.

If OpenAI rejects split-host signaling, the fallback is a short-lived access-token handoff to the Mac app. Never transfer or store the refresh token.

## Provenance

The live wire protocol, prompt structure, transcript coalescing, delegation behavior, and terminal visualizer are derived from `can1357/oh-my-pi` at revision `69307261c332a78dc41d5a3e14f5af8edc8a3f51`.
