# Android Terminal OSC Exploration

## Current Path

Remote Coder PTY bytes arrive through `CoderTerminalView.feedRemoteOutput`, then JNI `nativeFeed`, then `CoderTerminal::feed`, then `ghostty_terminal_vt_write`.

Local keyboard/chat/paste input uses `CoderTerminalView.writeInput`, which sends bytes to the active remote WebSocket when a remote session is attached. The native local PTY path remains only renderer/input infrastructure.

## Current OSC Handling

Ghostty VT is the terminal parser and renderer state owner. Its headers show OSC command support for:

- OSC 0/2 window title
- OSC 7 current working directory
- OSC 8 hyperlinks
- OSC 52 clipboard contents
- OSC 4/10/11/12 color operations
- OSC 133 semantic prompt
- Kitty color/text sizing commands
- ConEmu-specific commands

The Android embedder currently registers these Ghostty effects in `CoderTerminal::start`:

- `GHOSTTY_TERMINAL_OPT_WRITE_PTY`
- `GHOSTTY_TERMINAL_OPT_SIZE`
- `GHOSTTY_TERMINAL_OPT_DEVICE_ATTRIBUTES`
- `GHOSTTY_TERMINAL_OPT_XTVERSION`

No Android callback is registered for title changes, bell, clipboard reads/writes, current working directory, desktop notifications, or hyperlink UI actions. Color OSC effects are represented in Ghostty render colors and flow into `CoderTerminal::snapshot` through `ghostty_render_state_colors_get`.

## Hook Points

Title support should hook at native layer first:

- Register `GHOSTTY_TERMINAL_OPT_TITLE_CHANGED` in `CoderTerminal::start`.
- Store sanitized title in `CoderTerminal` state.
- Expose JNI getter or callback to `CoderTerminalView`.
- Render title in terminal sheet header only after stripping control characters and length-capping.

Hyperlink support should hook in renderer snapshot path:

- Use Ghostty grid/ref hyperlink APIs when converting cells to Android-rendered rows.
- Add per-cell or per-range hyperlink metadata alongside `CoderCell`.
- Add tap/long-press hit testing in `CoderTerminalView`.
- Confirm before opening external URLs.

OSC 52 clipboard support should not be enabled by default:

- Register Ghostty runtime clipboard callbacks only behind an explicit setting.
- Require confirmation for reads.
- Require confirmation or strict allowlist for writes.
- Never log clipboard contents.

OSC 7 current working directory can be read from Ghostty terminal data and shown as sanitized session metadata. Do not log raw paths if they may contain secret material.

## Security And Privacy

- OSC 52 can exfiltrate clipboard contents or overwrite clipboard without visible typed input.
- OSC 8 hyperlinks can disguise destinations inside terminal text.
- Title/PWD sequences can contain hostnames, paths, branch names, issue IDs, or other private project context.
- Color operations are low-risk but must not override user theme permanently.
- All OSC-derived strings need UTF-8 validation, control-character stripping, length caps, and log exclusion by default.

## Feasible Plan

1. Add title callback only, store sanitized in memory, no persistence.
2. Add Android smoke using remote `printf '\033]2;safe-title\007'` and verify sheet title or secondary label updates.
3. Add hyperlink metadata read path without opening URLs.
4. Add tap affordance and confirmation dialog for OSC 8 links.
5. Add OSC 52 behind disabled-by-default setting with confirmation and no logging.

## Recommendation

Do not implement OSC clipboard yet. Title support is the safest next implementation if needed. Hyperlinks are feasible after metadata plumbing. Clipboard support needs explicit product/security approval.
