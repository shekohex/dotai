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

Final realtime transcripts are persisted with Pi's `appendEntry()` API and rendered as `[live · you]` and `[live · Pi]` cards in the chat. These are durable `CustomEntry` records: they never enter LLM context, are never converted into provider user messages, and cannot trigger an AgentSession turn. Streaming transcript fragments remain only in the terminal visualizer and native call strip.

The live model first decides whether workspace execution is actually required. Greetings, social conversation, confirmations, clarifying conversation, and questions answerable from the current voice context stay entirely inside the realtime conversation.

Only a server-generated `delegation.created` becomes a coding turn. The live model authors the
`item.content` in that event; TypeScript does not derive it from `turn.done` or automatically copy
the latest transcript. The live model is therefore capable of synthesizing a standalone task, but
it can still choose to copy the transcript if it fails to follow its instructions. Pi Live records
whether each delegation was verbatim or synthesized so that behavior is visible and diagnosable.

An accepted delegation becomes:

```ts
pi.sendMessage(
  {
    customType: "live-delegation",
    content: agentRequest,
    display: true,
    details: {
      delegationId,
      sourceTurn,
      transcriptRelation,
      languageAssessment,
      originalRequest,
      normalizedBy,
    },
  },
  { triggerTurn: true, deliverAs: "steer" },
);
```

The delegation is a Pi custom message rather than a typed user message. It intentionally
participates in LLM context and triggers the coding turn, but it now has a dedicated message
renderer instead of looking like a user prompt. The chat shows an accent-colored
`Pi Live → workspace` execution card and labels it as either a synthesized workspace task or a
verbatim voice request. If helper normalization was required, the English execution task is primary
and the original live-model delegation is shown underneath in muted color. Expanded mode includes
the source turn, helper model, and delegation ID.

The TypeScript boundary no longer trusts prompt compliance alone. It uses lightweight language
detection plus non-Latin prose analysis before `sendMessage()`. English delegations bypass helper
normalization and are delivered immediately. A non-English delegation is sent to an isolated fast
normalizer model—not the active AgentSession—which translates and synthesizes one concise English
execution task. The preferred fallback order is `codex-openai/gpt-5.4-mini`,
`opencode-go/deepseek-v4-flash`, then `deepseek/deepseek-v4-flash`, followed by the remaining shared
fallback models. Requests use minimal reasoning, a small output budget, no retries, and a short
timeout. The original non-English request remains UI-only metadata and never enters AgentSession.
Only if every normalizer fails is the delegation persisted as a failed UI-only entry and withheld
from the coding model. Short ASCII command-like tasks bypass normalization because trigram language
detection is unreliable for strings such as `Run git status`.

Assistant text explicitly marked with OpenAI's `commentary` phase is appended to the active live delegation through the sideband commentary channel. Providers without phase metadata retain the OMP-compatible tool-use-text fallback. This gives the voice model current progress for accurate progress questions without reading raw tool chatter aloud. The final-answer phase is separated from commentary and sent after `agent_settled` as speakable context.

New voice requests can create a fresh delegation while work is active. Each one steers the same Pi AgentSession, preserving a single continuous assistant instead of spawning an independent backend.

Every delegation is synthesized in English rather than copied from the transcript. If the user speaks Arabic, Spanish, or another language, Pi Live continues speaking in that language while sending only a concise English execution request to the Pi AgentSession. Literal strings, filenames, identifiers, and quoted data retain their exact spelling when required.

## macOS app

The app source is in `macos/PiLive`.

```bash
cd macos/PiLive
./scripts/build-app.sh
open '.build/Pi Live.app'
```

The app targets macOS 26 and Swift 6.2. It uses native SwiftUI Liquid Glass, Observation's `@Observable`/`@Bindable` state model, a sidebar-based grouped Settings scene, macOS Keychain, `/usr/bin/ssh`, and the WebRTC M150 XCFramework from `stasel/WebRTC`. The floating call surface appears centered immediately above the Dock. Once connected, the pairing window smoothly collapses into a standalone Siri-style orb with no persistent strip, waveform, transcript, or button chrome. Pressing Space while this call window is focused toggles mute; key repeats, modified Space presses, text editors, and other applications are not intercepted.

WebRTC owns microphone capture, Opus encoding, RTP transport, remote Opus decoding, echo cancellation, automatic gain control, noise suppression, high-pass filtering, media VAD, and speaker playback. Codex Live owns conversational end-of-turn detection. Pi Live deliberately does not run a second microphone capture pipeline or gate audio with a handwritten local VAD, because either can clip speech and undermine WebRTC acoustic echo cancellation. WebRTC statistics are used only for the audio-reactive interface and level telemetry. WebRTC M150's public Objective-C API exposes no audio-level callback on `RTCAudioTrack`, `RTCAudioSource`, or `RTCRtpReceiver`, so bounded stats sampling remains necessary for presentation metering. It is not conversational VAD and never gates media.

The orb's layered ribbons, halo, pulse, and subtle shape wobble provide speech feedback. Local speech adds a green activity ring and stronger wobble. When muted, an orange microphone badge appears and local input stops driving the animation; remote output metering remains active, so the orb continues moving with Pi's speech even though the microphone track is disabled.

The main call surface is a single SwiftUI `Window` configured through a lifecycle-aware window accessor as a chromeless floating AppKit window, so native traffic-light controls never appear; Settings remains a normal macOS window. It retains an invisible full-size title bar because a truly borderless `NSWindow` cannot become key by default and therefore cannot reliably receive Space or Escape. The native rectangular window shadow is disabled so the connected state reads as a true floating orb. SwiftUI owns the intentional orb and glass glow. Window discovery no longer depends on title matching, `NotificationCenter`, or delayed launch positioning.

The orb is itself the call control: one click toggles mute, a double-click ends the call without first firing the single-click action, and a right-click exposes explicit Mute, Settings, and End Call commands. Escape is guarded against accidental hangup: the first press shows a temporary `Press Esc again to end` warning, and a second press within 2.5 seconds ends the call.

After a clean local or remote hangup, the call window orders itself out instead of returning to the
pairing screen. Pi Live remains available as a menu-bar app. Settings includes a user-configurable
global shortcut powered by `sindresorhus/KeyboardShortcuts`; invoking it from any application imports
a valid `pi-live://pair#...` URL from the clipboard and shows Pi Live above the Dock.

The native pairing protocol uses Codable JSON-RPC envelopes and typed parameter/result payloads rather than `[String: Any]` dictionaries. `LivePairingClient` emits one typed `AsyncStream<LiveClientEvent>` consumed by the Observation model. SSH local port selection uses `NWListener`, and readiness is proven by a WebSocket health check instead of a fixed startup sleep.

File diagnostics are opt-in and disabled by default. Settings → General → Diagnostics synchronizes the `live.diagnosticsEnabled` value to the Pi workspace during pairing and can change it during an active call. When enabled, redacted events are appended to `~/.pi/agent/logs/live.jsonl`; disabling logging stops future writes but intentionally does not delete an existing file. Error messages mention the diagnostics path only while logging is enabled.

VoiceInk 2.0 was inspected locally at revision `69ed170c1d7f582e76f3f63a2ac2c30ddb3a2d75`. Its Settings UI reinforced the use of a category sidebar, grouped native forms, menu pickers, `LabeledContent`, concise explanatory footers, and hidden scroll backgrounds; Pi Live implements those patterns independently without copying GPL source. VoiceInk's VAD is a bundled Silero v5.1.2 model invoked through whisper.cpp against PCM during local transcription. That design is appropriate for offline speech segmentation, but it cannot be dropped into Pi Live's media path without obtaining PCM through a second/custom capture pipeline. WebRTC M150 exposes no public Objective-C PCM tap on `RTCAudioTrack`, `RTCAudioSource`, or `RTCRtpReceiver`, so Pi Live keeps WebRTC's built-in media VAD and Codex turn detection and uses level telemetry only for orb presentation.

The End button, window dismissal, remote `/live` stop, and app Quit path use a graceful close handshake. The Mac first sends `session.stop`; TypeScript closes the OpenAI session and replies with `session.stop`; both sides then close WebRTC and pairing normally. Intentional ICE `.closed` callbacks are ignored after the peer has been detached, duplicate stop completion is suppressed, and cleanup-only sideband errors are diagnostic warnings rather than user-facing call failures.

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

The live wire protocol, prompt structure, transcript coalescing, delegation behavior, and terminal visualizer are derived from `can1357/oh-my-pi`. Pi Live keeps the same critical boundary as OMP: only `delegation.created`, never ordinary transcripts, triggers an AgentSession turn. OMP `v17.1.2` was refreshed and inspected at commit `a38cd95d7d8c457a22f1b81c059b5491d78f79a3`: its live controller passes `delegation.created.item.content` directly to a visible, agent-attributed `live-delegation` custom message, and its core custom-message component gives live delegations a special accent border. Pi Live follows that newly visible delegation design through its extension renderer while retaining the stronger English-only boundary. The transcript persistence boundary was verified directly against `earendil-works/pi-mono` v0.82.0: `sendMessage()` participates in LLM context, while `appendEntry()` plus `registerEntryRenderer()` is durable TUI-only state.

The canonical live-model prompt is `src/resources/live/live-instructions.md`; TypeScript only loads it, substitutes identity fields, and appends protected user preferences. There is no second prompt copy embedded in TypeScript.

The native orb follows the macOS Siri sphere composition: a dark upper field with layered cyan, blue, white, magenta, and voice-tinted ribbons that move, pulse, and wobble with live audio. Its circular halo adapts the MIT-licensed layered SwiftUI glow from `jacobamobin/AppleIntelligenceGlowEffect`, tuned for macOS, the selected voice palette, live audio energy, reduced motion, and Low Power Mode. See `macos/PiLive/THIRD_PARTY_NOTICES.md`.
