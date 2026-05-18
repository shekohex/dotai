# Android Terminal OSC Research And Implementation Prompt

## Current Android Path

Remote PTY bytes flow through:

`CoderTerminalSession` → `CoderTerminalSocket.onBytes` → `CoderTerminalView.feedRemoteOutput` → `CoderNative.nativeFeed` → `CoderTerminal::feed` → `ghostty_terminal_vt_write`.

Local terminal input flows through `CoderTerminalView.writeInput`. When a remote session is attached it writes bytes to the WebSocket. Without a remote session it uses `CoderNative.nativeWrite`, then Ghostty key/PTY plumbing.

Native terminal state lives in `app/src/main/cpp/coder_terminal.cpp`. JNI surface is `app/src/main/cpp/coder_jni.cpp` and `app/src/main/java/com/coder/pi/CoderNative.kt`. Android UI and gestures live in `app/src/main/java/com/coder/pi/CoderTerminalView.kt` plus Compose sheet UI in `CoderApp.kt`.

Android links `app/libs/<abi>/libghostty-vt.a` through `app/src/main/cpp/CMakeLists.txt`. This is the VT parser/render-state library, not the full Ghostty app/runtime surface.

## Ghostty OSC Surface Available Here

Local headers show Ghostty VT can parse these OSC command classes in `app/libs/include/ghostty/vt/osc.h`:

- `CHANGE_WINDOW_TITLE`: OSC 0 / 2 style title changes.
- `CHANGE_WINDOW_ICON`: xterm icon title class.
- `SEMANTIC_PROMPT`: OSC 133 prompt markers.
- `CLIPBOARD_CONTENTS`: OSC 52 clipboard operations.
- `REPORT_PWD`: OSC 7 current working directory.
- `MOUSE_SHAPE`: cursor shape metadata.
- `COLOR_OPERATION`: OSC 4 / 10 / 11 / 12 color operations.
- `KITTY_COLOR_PROTOCOL`: Kitty color protocol.
- `SHOW_DESKTOP_NOTIFICATION`: notification command class.
- `HYPERLINK_START` / `HYPERLINK_END`: OSC 8 hyperlinks.
- `KITTY_TEXT_SIZING`: Kitty text sizing.
- `CONEMU_*`: ConEmu compatibility commands.

Terminal callback/data APIs available in `app/libs/include/ghostty/vt/terminal.h`:

- `GHOSTTY_TERMINAL_OPT_TITLE_CHANGED` callback, title read via `GHOSTTY_TERMINAL_DATA_TITLE`.
- `GHOSTTY_TERMINAL_OPT_BELL` callback for BEL.
- `GHOSTTY_TERMINAL_OPT_COLOR_SCHEME` callback for color scheme queries.
- `GHOSTTY_TERMINAL_DATA_PWD` read for OSC 7 current working directory.
- `GHOSTTY_TERMINAL_DATA_COLOR_*` and render-state colors for effective OSC color overrides.
- `GHOSTTY_TERMINAL_OPT_TITLE` / `GHOSTTY_TERMINAL_OPT_PWD` setters if Android needs to seed state.

Cell/screen APIs available for richer metadata:

- `GHOSTTY_CELL_DATA_HAS_HYPERLINK` in `app/libs/include/ghostty/vt/screen.h`.
- `GHOSTTY_CELL_DATA_SEMANTIC_CONTENT` for OSC 133 prompt semantics.
- `ghostty_grid_ref_hyperlink_uri` in `app/libs/include/ghostty/vt/grid_ref.h` can read per-cell hyperlink URI when a `GhosttyGridRef` is available.

Full runtime clipboard callbacks appear in `app/libs/include/ghostty.h`, but Android currently links `libghostty-vt.a` and uses `ghostty/vt.h`. Treat those runtime callbacks as not currently wired unless build/linkage changes intentionally.

## Ghostty Upstream Reference

Upstream `ghostty-org/ghostty` confirms OSC support is split into three layers:

- Parser layer: `src/terminal/osc.zig` defines `Command` variants for title, icon title, OSC 133 semantic prompt, OSC 52 clipboard, OSC 7 PWD, mouse shape, color operations, Kitty color, desktop notifications, OSC 8 hyperlinks, ConEmu commands, Kitty text sizing, Kitty clipboard, and context signals.
- Terminal state layer: `src/terminal/Terminal.zig` stores terminal-owned title and PWD as NUL-terminated byte arrays, clears/replaces them on updates, and exposes borrowed getters.
- App/runtime layer: `src/apprt/surface.zig`, `src/apprt/action.zig`, `src/apprt/embedded.zig`, and GTK code turn parser/terminal events into app actions such as `set_title`, `pwd`, `ring_bell`, clipboard read/write, desktop notification, progress report, and mouse shape.

Important upstream details to mirror on Android:

- OSC 0/2 parser only extracts title bytes; app/runtime owns UI behavior. Android should do the same through `GHOSTTY_TERMINAL_OPT_TITLE_CHANGED` and `GHOSTTY_TERMINAL_DATA_TITLE` instead of reparsing bytes.
- OSC 7 parser accepts raw value and explicitly does not validate it as a file URL. Android must validate/sanitize before UI use.
- OSC 8 stores hyperlink data outside the cell itself. Cells carry a hyperlink flag, then code looks up URI through hyperlink map/set. Android's `ghostty_grid_ref_hyperlink_uri` binding matches this model.
- OSC 52 parser accepts read/query (`?`), write, and clear shapes. Upstream embedded runtime routes reads through callbacks before completing requests. Android should use a native/Kotlin bridge rather than reparsing OSC bytes.
- Desktop notification/progress/mouse-shape are app actions upstream. Android should implement them through VT C API hooks where available, or through a deliberate Android bridge if hooks are missing.

Upstream files checked:

- `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/terminal/osc.zig`
- `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/terminal/osc/parsers/change_window_title.zig`
- `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/terminal/osc/parsers/report_pwd.zig`
- `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/terminal/osc/parsers/clipboard_operation.zig`
- `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/terminal/osc/parsers/hyperlink.zig`
- `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/terminal/Terminal.zig`
- `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/terminal/c/grid_ref.zig`
- `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/apprt/surface.zig`
- `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/apprt/embedded.zig`

## Android Debug Terminal View

Android already has a debug-only real terminal playground:

- Entry: deep link `pi://debug/render` in debug builds, handled by `MainActivity.handleDeepLink`.
- UI: `DebugRenderPlayground` in `CoderApp.kt`.
- Feed source: `debugRenderPlaygroundBytes(fontName)` writes bytes into a real `CoderTerminalView` using `feedRemoteOutput`.

Use this for OSC development because it exercises the actual Android path: `CoderTerminalView + libghostty-vt + native GLES renderer`. Extend `debugRenderPlaygroundBytes` temporarily or behind a debug selector with OSC smoke sequences for title, PWD, hyperlink, bell, clipboard, notification, and color operations.

## Current Android Coverage

`CoderTerminal::start` currently registers:

- `GHOSTTY_TERMINAL_OPT_WRITE_PTY`
- `GHOSTTY_TERMINAL_OPT_SIZE`
- `GHOSTTY_TERMINAL_OPT_DEVICE_ATTRIBUTES`
- `GHOSTTY_TERMINAL_OPT_XTVERSION`

Not registered or exposed today:

- title changes
- bell
- color scheme query response
- clipboard callbacks
- current working directory metadata
- desktop notifications
- hyperlink tap metadata/actions
- OSC 133 semantic prompt metadata
- mouse shape
- Kitty text sizing
- ConEmu UI/process compatibility commands

OSC color operations are already partially useful because `CoderTerminal::snapshot` reads effective render colors through `ghostty_render_state_colors_get` and per-cell style/color APIs. Theme defaults are set through `CoderTerminal::setTheme`; OSC overrides should remain terminal-session-local and must not mutate app preferences.

## Support Matrix

| Feature | Ghostty VT support | Android work | Complexity | Recommendation |
| --- | --- | --- | --- | --- |
| OSC 0 / 2 title | callback + data getter | Native store/getter, Kotlin observable, sheet label | low | Implement first |
| BEL | callback | Native flag/counter, optional haptic/audio setting | low | Implement with rate limiting |
| OSC 7 PWD | data getter | Native getter, UI metadata | low | Implement display metadata |
| OSC 8 hyperlinks | cell metadata + grid ref API | Snapshot metadata, hit testing, open action | medium | Implement after title/PWD |
| OSC 4/10/11/12 colors | parser/render colors | Verify no preference mutation, add tests | low | Treat as supported, add regression tests |
| Color scheme query | callback | Return current app light/dark mode | low | Implement if shell tools need it |
| OSC 133 semantic prompt | cell semantic data | Expose prompt ranges for selection/navigation later | low | Capture metadata, no UI required first |
| OSC 52 clipboard | parser class, runtime callback not wired in VT path | Needs native/Kotlin bridge and UI-thread clipboard access | medium | Implement once bridge is clear |
| Desktop notification | parser class, no Android hook identified | Need callback/API or Android bridge | medium | Implement after hook/bridge research |
| Mouse shape | parser class | Need state getter/callback and Android cursor relevance | low value on touch | Defer |
| Kitty text sizing | parser class | Need renderer font sizing model integration | layout complexity | Defer unless specific app needs it |
| ConEmu commands | parser class | Windows terminal compatibility mostly irrelevant | broad behavior surface | Implement only useful subset |

## Implementation Notes

Title:

- Add `titleChangedEffect` in `CoderTerminal` and register `GHOSTTY_TERMINAL_OPT_TITLE_CHANGED`.
- In callback, query `GHOSTTY_TERMINAL_DATA_TITLE`, copy into `std::string`, sanitize UTF-8/control characters, cap length, store under `mutex_`.
- Expose `nativeTitle(handle): String` or a compact `nativeMetadata(handle)` JNI getter.
- Poll after `feedRemoteOutput`/draw or expose callback through view invalidation; keep UI thread boundaries explicit.
- Show as secondary label in terminal sheet/header.

Bell:

- Register `GHOSTTY_TERMINAL_OPT_BELL`.
- Store monotonic bell counter or timestamp in native state.
- Expose through JNI and let Kotlin decide haptic/audio based on setting and foreground state.
- Rate-limit effects.

PWD:

- Query `GHOSTTY_TERMINAL_DATA_PWD` after feed/draw or through metadata getter.
- Validate URI/path, strip controls, cap length.
- Display raw value or a compact host/path summary depending on available UI space.

Hyperlinks:

- Extend `CoderCell` only if needed for renderer/UI metadata. Avoid pushing full URI into GPU path.
- Prefer a separate native query: viewport row/col → screen position → URI, so normal rendering stays lean.
- Use `GHOSTTY_CELL_DATA_HAS_HYPERLINK` to mark affordance if available in render cells.
- Use `ghostty_grid_ref_hyperlink_uri` only where code has a valid `GhosttyGridRef`; if render row cells do not expose refs, inspect headers before inventing plumbing.
- Android open flow should support at least `http` and `https`. Add other schemes intentionally through Android intents.

OSC 52:

- Implement after deciding the bridge shape because Android currently links VT C APIs, not full Ghostty runtime callbacks.
- Support read/query (`?`), write, and clear operations when callback plumbing exists.
- Keep max payload sizes bounded and use Android clipboard APIs on UI thread.

Notifications:

- Prefer Ghostty VT/app-action hooks. If unavailable, a small Android bridge/parser can be considered for notification-only experiments.
- Respect Android notification permission/state checks and add rate limits.

## Validation Commands

Use targeted checks first:

```bash
./gradlew testDebugUnitTest
./gradlew assembleDebug
```

Useful smoke bytes:

```bash
printf '\033]2;safe-title\007'
printf '\033]7;file://host/home/coder/project\007'
printf '\033]8;;https://example.com\007link\033]8;;\007\n'
printf '\007'
printf '\033]10;#ff0000\007'
```

Expected checks:

- Title appears sanitized and length-capped.
- PWD metadata appears sanitized or summarized and is not logged.
- Hyperlink tap shows full destination before opening.
- OSC color changes affect current terminal render state only.
- Clipboard read/write/clear behavior works in debug smoke when enabled.

## Android Implementation Status

Implemented in Android:

- OSC 0/2 title: native `GHOSTTY_TERMINAL_OPT_TITLE_CHANGED` callback stores a sanitized 256-byte in-memory title and exposes it through JNI.
- BEL: native `GHOSTTY_TERMINAL_OPT_BELL` callback increments an in-memory counter exposed through JNI. Android view gives subtle haptic feedback, rate-limited to once per second.
- OSC 7 PWD: Android handles OSC 7 through a narrow bounded bridge because linked Ghostty VT stream ignores `.report_pwd`; it sets `GHOSTTY_TERMINAL_OPT_PWD`, sanitizes to 512 bytes, exposes through JNI, and displays title/PWD metadata overlay in terminal UI.
- OSC colors: no app preference writes are involved. Colors remain in Ghostty terminal/render state; debug playground emits OSC 10/reset smoke bytes.
- OSC 8 hyperlinks: Android queries `ghostty_grid_ref_hyperlink_uri` at tapped viewport row/col, bounds URI payloads to 2048 bytes, validates `http://` and `https://` links, prompts with the full destination, and supports a user-managed host/wildcard allowlist under Settings → Links.
- Link allowlist deep links: `pi://settings/links` opens the allowlist page and `pi://settings/links/add` opens the add-host dialog.
- OSC 52 clipboard: Android bridges bounded OSC 52 events from the VT stream, handles clipboard write/clear/query on the UI side, and sends query responses back through the existing terminal input path.
- Desktop notifications: Android bridges OSC 9 and rxvt `777;notify` payloads from the VT stream, posts native Android notifications through the `Terminal OSC` channel when permission is granted, and falls back to a rate-limited foreground toast when notifications are disabled or permission is missing.
- OSC 9 progress: Android bridges `OSC 9;4;state;progress` into an ongoing native notification with determinate or indeterminate progress, and clears it on state `0`.
- Notification routing: real workspace terminals prefix notification titles with the workspace name and use `pi://terminal?id=<terminal-session-key>` deep links so tapping a notification resumes the matching terminal/workspace when it is still active.
- Color scheme query: Android responds to Ghostty VT color-scheme requests from the active terminal theme background.
- Debug smoke: `pi://debug/render` emits title, PWD, BEL, OSC 8 hyperlink, OSC 52 clipboard, OSC 9 notification/progress, and OSC color sequences through real `CoderTerminalView.feedRemoteOutput`.

Widely Seen OSC Families:

- OSC 0 / 1 / 2: window and icon title.
- OSC 4 / 10 / 11 / 12: palette, foreground, background, cursor colors.
- OSC 7: current working directory.
- OSC 8: hyperlinks.
- OSC 9: terminal/app notifications and progress conventions.
- OSC 52: clipboard read/write.
- OSC 133: shell integration prompt markers.
- OSC 633: VS Code shell integration.
- OSC 777: iTerm/rxvt notification conventions.
- Kitty OSCs: color protocol, text sizing, clipboard variants.

Deferred App Actions:

- OSC 133 shell integration: Ghostty already marks semantic prompt/content cells, but Android does not yet expose prompt navigation UI.
- Kitty graphics/text sizing: parsed by Ghostty VT, but Android renderer image placement/text sizing integration is a separate renderer feature.
- ConEmu commands beyond progress/title-like notification fallback: mostly desktop/Windows shell compatibility and not useful on Android without explicit product behavior.

## GPT-5.5 Implementation Prompt

```text
Role: You are a senior Android/native terminal engineer working in this repo. Implement Android support for Ghostty VT OSC features without changing unrelated behavior.

# Personality
Be direct, concise, and pragmatic. Make progress with reasonable assumptions. Ask only if missing information would change security behavior or product scope.

# Goal
Implement supported Android OSC integration end to end, starting with features that Ghostty VT already exposes: OSC 0/2 title, BEL, OSC 7 PWD metadata, OSC color regression coverage, OSC 8 hyperlinks if required Ghostty cell/grid APIs are reachable, then OSC 52 clipboard and notifications once the bridge shape is clear.

# Context
Remote bytes flow through CoderTerminalSession → CoderTerminalView.feedRemoteOutput → CoderNative.nativeFeed → CoderTerminal::feed → ghostty_terminal_vt_write.
Native terminal code is app/src/main/cpp/coder_terminal.cpp and app/src/main/cpp/coder_terminal.h.
JNI is app/src/main/cpp/coder_jni.cpp and app/src/main/java/com/coder/pi/CoderNative.kt.
Android view/UI code is app/src/main/java/com/coder/pi/CoderTerminalView.kt and app/src/main/java/com/coder/pi/CoderApp.kt.
Ghostty headers are under app/libs/include/ghostty/vt*. Android links app/libs/<abi>/libghostty-vt.a, not the full Ghostty runtime.
Existing native callbacks registered in CoderTerminal::start: WRITE_PTY, SIZE, DEVICE_ATTRIBUTES, XTVERSION.
Upstream reference implementation is cached at /Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty. Use it for behavior guidance: src/terminal/osc.zig, src/terminal/Terminal.zig, src/terminal/c/grid_ref.zig, src/apprt/surface.zig, and src/apprt/embedded.zig.
Debug validation can use the existing debug terminal view: open pi://debug/render in debug builds. It renders a real CoderTerminalView and feeds bytes through debugRenderPlaygroundBytes in CoderApp.kt.

# Required skills and source research
Before implementation, load and follow the android-cli skill and librarian skill.
Use librarian to resolve and refresh ghostty-org/ghostty under ~/.cache/checkouts, then consult upstream Ghostty terminal and libghostty implementation before deciding Android hooks.
Read the relevant upstream files, not just headers: src/terminal/osc.zig, src/terminal/Terminal.zig, src/terminal/c/terminal.zig, src/terminal/c/grid_ref.zig, src/terminal/c/cell.zig, src/terminal/c/row.zig, src/terminal/c/main.zig, src/apprt/surface.zig, src/apprt/action.zig, src/apprt/embedded.zig, and OSC parser files under src/terminal/osc/parsers.
Use android-cli for Android-specific checks and device/debug work when available: android info, android describe, android docs search/fetch for Android clipboard/notification/intent behavior, android run for installing APKs, android layout/screen capture for UI validation.
If android CLI is unavailable, say so and fall back to Gradle/adb commands.

# Required implementation
- Register GHOSTTY_TERMINAL_OPT_TITLE_CHANGED. Query GHOSTTY_TERMINAL_DATA_TITLE, copy it immediately, sanitize UTF-8/control characters, cap length, keep in memory only, expose to Kotlin through JNI.
- Register GHOSTTY_TERMINAL_OPT_BELL. Store a counter or timestamp, expose it to Kotlin, and trigger only rate-limited/subtle Android feedback if existing UX has a clear place for it. If not, expose state only.
- Expose OSC 7 PWD metadata by querying GHOSTTY_TERMINAL_DATA_PWD. Sanitize and cap it. Display raw value or summary depending on UI space.
- Verify OSC color operations remain session-local: render-state colors may change, app theme preferences must not change.
- Investigate OSC 8 support through existing Ghostty VT APIs. If a valid per-cell URI path is available, add a minimal native query for URI at viewport row/col and Android open action for http/https links. If not reachable without large renderer refactor, document exact blocker and leave clean TODO-free code.
- Add debug-only OSC smoke coverage to the debug terminal playground or document exact `pi://debug/render` steps. Prefer a small debug selector/fixture over permanent unrelated sample noise.
- Implement OSC 52 clipboard if the Ghostty VT/runtime bridge is available or can be added cleanly. If bridge work is larger than the first OSC pass, document exact next step.

# Constraints
- Touch only files needed for OSC support and tests.
- Match existing Kotlin/C++ style.
- Do not add comments.
- All OSC-derived strings need UTF-8 validation or safe replacement, control-character stripping, and length caps.
- Keep payload sizes bounded.
- Avoid mutating unrelated user preferences from OSC metadata.
- Do not mutate user theme settings from OSC color operations.

# Success criteria
- Unit tests or focused native/JNI tests cover sanitization and metadata behavior where feasible.
- Manual smoke commands for title, PWD, hyperlink, bell, and color are documented or automated.
- `./gradlew testDebugUnitTest` passes.
- `./gradlew assembleDebug` passes.
- Final answer lists changed files, implemented OSC features, deferred features with reasons, and validation results.

# Retrieval budget
Start by reading the files named in Context plus Ghostty headers for terminal, screen/grid refs, and render row cells. Then inspect the upstream Ghostty/libghostty files listed in Required skills and source research. Search again only if a required API or existing UI hook is missing. Do not browse unrelated app code for polish.

# Stop rules
Stop and ask before changing native library linkage or adding a broad parallel OSC parser. If Ghostty VT lacks an API for one feature, document the smallest bridge needed and continue with features that are already reachable.
```
