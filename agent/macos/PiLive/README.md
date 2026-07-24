# Pi Live for macOS

Native media bridge for the `/live` Pi extension.

## Responsibilities

- Captures the default Mac microphone through WebRTC/CoreAudio.
- Sends Opus audio directly to OpenAI over WebRTC.
- Plays remote audio through the default Mac output device.
- Maintains the required `oai-events` data channel.
- Pairs with local, Coder, direct, or SSH-hosted Pi sessions.
- Stores only the Coder session token in Keychain.
- Never stores or receives ChatGPT OAuth credentials.

## Build

Requires macOS 14+, Xcode command-line tools, and network access to resolve the WebRTC Swift package.

```bash
./scripts/build-app.sh
open '.build/Pi Live.app'
```

The first launch requests microphone permission. The ad-hoc signature is sufficient for local PoC testing, but permission may reset after rebuilding. Stable iteration should use an Apple Development signature and fixed bundle identifier.

## SSH

Enter an OpenSSH target such as `pi.coder`. The app runs:

```bash
ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -N \
  -L <ephemeral-local-port>:127.0.0.1:<pairing-port> pi.coder
```

No audio passes through the tunnel. Only JSON-RPC pairing/control messages use it.
