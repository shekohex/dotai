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

Supported voices are `juniper`, `maple`, `spruce`, `ember`, `vale`, `breeze`, `arbor`, `sol`, and `cove`. Wire and settings values are always lowercase; the macOS app presents display names.

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
    "voice": "sol",
    "instructions": "",
    "transport": "coder",
    "sshTarget": "",
    "directHost": "",
    "pairingTtlMs": 120000,
    "heartbeatMs": 10000,
    "appOpenTimeoutMs": 25000
  }
}
```

Identity fields can be cleared to fall back to the workspace OS account. Command arguments override transport, SSH target, direct host, and voice for one call. The native app's Voice settings writes the selected lowercase value back to the paired workspace. A selection made before pairing applies to the current call; a change made during a call applies to the next call.

The native Assistant settings panel owns optional custom conversational instructions. They are sent in the authenticated pairing request, persisted to `live.instructions`, and included in the current call when supplied before pairing. Changes during a call apply to the next call. Custom instructions may tune tone, brevity, and terminology, but cannot override the core delegation, language, safety, or honesty rules.

`/live` starts an ephemeral server, copies the single-line `pi-live://pair#...` URL through Pi's SSH-aware clipboard support, and replaces the editor with the OMP-derived visualizer. Press Enter to copy again, Space to mute, or Escape to end.

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

Realtime transcripts are UI-only. They never enter the Pi AgentSession directly. The live model first decides whether workspace execution is actually required. Greetings, social conversation, confirmations, clarifying conversation, and questions answerable from the current voice context stay entirely inside the realtime conversation.

Only a server-generated `delegation.created` becomes:

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

New voice requests can create a fresh delegation while work is active. Each one steers the same Pi AgentSession, preserving a single continuous assistant instead of spawning an independent backend.

Every delegation is synthesized in English rather than copied from the transcript. If the user speaks Arabic, Spanish, or another language, Pi Live continues speaking in that language while sending only a concise English execution request to the Pi AgentSession. Literal strings, filenames, identifiers, and quoted data retain their exact spelling when required.

## macOS app

The app source is in `macos/PiLive`.

```bash
cd macos/PiLive
./scripts/build-app.sh
open '.build/Pi Live.app'
```

The app targets macOS 26 and Swift 6.2. It uses native SwiftUI Liquid Glass, a standard macOS Settings scene, macOS Keychain, `/usr/bin/ssh`, and the WebRTC M150 XCFramework from `stasel/WebRTC`. The floating call surface appears centered immediately above the Dock. Once connected, it collapses into a compact translucent call strip with an always-moving aurora orb, an audio-reactive layered Siri waveform, transcript context, mute, settings, and End controls.

WebRTC owns microphone capture, Opus encoding, RTP transport, remote Opus decoding, echo cancellation, automatic gain control, noise suppression, high-pass filtering, media VAD, and speaker playback. Codex Live owns conversational end-of-turn detection. Pi Live deliberately does not run a second microphone capture pipeline or gate audio with a handwritten local VAD, because either can clip speech and undermine WebRTC acoustic echo cancellation. WebRTC statistics are used only for the audio-reactive interface and level telemetry.

The End button, window dismissal, remote `/live` stop, and app Quit path use a graceful close handshake. The Mac first sends `session.stop`; TypeScript closes the OpenAI session and replies with `session.stop`; both sides then close WebRTC and pairing normally. A normal WebSocket close is not surfaced as `Pi Live app disconnected`.

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

The live wire protocol, prompt structure, transcript coalescing, delegation behavior, and terminal visualizer are derived from `can1357/oh-my-pi`. Pi Live keeps the same critical boundary as OMP: only `delegation.created`, never ordinary transcripts, triggers an AgentSession turn.

The canonical live-model prompt is `src/resources/live/live-instructions.md`; TypeScript only loads it, substitutes identity fields, and appends protected user preferences. There is no second prompt copy embedded in TypeScript.

The native aurora orb adapts visual composition techniques from the MIT-licensed `cursorvoice/cursor-voice` project. The Siri-style waveform adapts mathematical and layering techniques from the MIT-licensed `noahchalifour/swiftui-siri-waveform-view` and `mvolpato/SpeechWaveAnimation` projects. See `macos/PiLive/THIRD_PARTY_NOTICES.md`.
