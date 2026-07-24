# macOS continuation prompt

Continue the Pi Live implementation on macOS from branch `feat/live-macos-bridge`.

Repository: `dotai/agent`

The Linux implementation is complete enough for integration testing:

- `/live` extension registered in `src/extensions/live`.
- OMP-derived Codex live protocol, prompt behavior, transcript coalescing, delegation bridge, and terminal visualizer.
- Session-scoped one-time pairing server with local, Coder, SSH, and direct descriptors.
- Coder wildcard WSS uses `Coder-Session-Token`, stored by the Swift app in Keychain.
- ChatGPT OAuth remains in the workspace. CLIProxyAPI Codex auth fallback matches `openusage`.
- The Swift 6.2/macOS 26 app is under `macos/PiLive` and owns WebRTC plus microphone/speaker media.
- No Rust runtime or audio-over-SSH implementation exists.
- Global identity, voice, adapter, and timeout defaults are under `settings.json#live` via `src/extensions/live/settings.ts`.

Start by reading:

- `docs/live-macos-bridge.md`
- `src/extensions/live/index.ts`
- `src/extensions/live/controller.ts`
- `src/extensions/live/transport.ts`
- `src/extensions/live/pairing/server.ts`
- `src/extensions/live/settings.ts`
- `macos/PiLive/Sources/PiLive/LiveWebRTCPeer.swift`
- `macos/PiLive/Sources/PiLive/LivePairingClient.swift`

Then do this on the Mac:

1. Run `cd macos/PiLive && swift package resolve`.
2. Fix any stasel/WebRTC API or Swift 6 actor-isolation compile errors.
3. Run `./scripts/build-app.sh` and launch `.build/Pi Live.app`.
4. Start the TypeScript Pi process locally first and run `/live local`.
5. Validate pairing, microphone permission, SDP offer/answer, `oai-events` opening, audio in both directions, mute, transcript, and stop.
6. Start Pi in a Linux Coder workspace and validate `/live coder` with a Keychain Coder token.
7. Validate `/live ssh target=<workspace>.coder` using the user's existing `coder config-ssh` host.
8. Prove or disprove split-host signaling: Mac creates the SDP offer, Linux authenticates the Codex signaling request, Mac accepts the answer, and Mac exchanges media directly with OpenAI.
9. If split-host signaling is rejected by OpenAI, implement the documented fallback using only an in-memory short-lived access token. Never transfer the refresh token.
10. Add macOS tests where practical, run the full TypeScript test/build suite again, and commit the final fixes.

Current native behavior also includes a Liquid Glass call surface above the Dock, a standard Settings scene with colored voice selection, lowercase voice synchronization to workspace `settings.json`, WebRTC M150 audio processing/level telemetry, and graceful bidirectional hangup.

The connected surface collapses into a compact bottom-center glass strip with a continuously animated orb and layered Siri-style waveform. Assistant settings include custom conversational instructions; pairing persists them to `live.instructions`, while changes during a call apply to the next call. `src/resources/live/live-instructions.md` is the single canonical prompt. It forbids transcript-by-transcript delegation, requires synthesized English AgentSession requests, and keeps spoken replies in the user's source language.

Final voice transcripts now use Pi `CustomEntry` persistence (`appendEntry` plus `registerEntryRenderer`), so `[live · you]` and `[live · Pi]` cards render in chat without entering model context or triggering turns. The synthesized `delegation.created` request is a separate hidden `CustomMessageEntry` that does trigger the Pi turn. OpenAI commentary-phase text is forwarded over the sideband commentary channel, final-answer text is kept separate, the main window is borderless with no traffic lights, and intentional WebRTC closure is not reported as a failure.

Preserve the architecture: Swift owns local media/UI/WebRTC; TypeScript owns ChatGPT auth/signaling/sideband/delegation/Pi session. Do not move audio into SSH, Coder, Herdr, or terminal transport.
