# Coder Terminal — Actionable Issue Checklist

Status: reviewed against current code on 2026-05-20.

Each item is an issue report. During execution, update each touched item with `State`, `Resolution`, `Validation`, `UI proof`, `Review`, and `Commit` before moving to another item.

Android device, UIAutomator, layout, deployment, emulator, and screenshot work must use the `android-cli` skill. Capture screenshot proof with `android screen capture` when available.

Screenshot proof must include before and after images for each visual or UI-affecting fix when a device/emulator is available. UIAutomator tests may save screenshots on the device; pull them with `adb pull`, store them under `docs/reference/` or a documented temp path, then read and compare them before accepting proof. For non-visual fixes, capture a before/after terminal smoke pair when practical; otherwise record the exact reason before proof is unavailable.

Required final states: `Fixed`, `Blocked`, `Non-actionable`.

Required proof schema:

```text
- [x] `SLUG`
  State: Fixed | Blocked | Non-actionable
  Type: ...
  Summary: ...
  Impact: ...
  Evidence: ...
  Goal: ...
  Deliverables: ...
  Validation plan: ...
  Resolution: ...
  Validation: ...
  UI proof: ...
  Review: ...
  Commit: ...
```

## Checklist

- [x] `BUG-NATIVE-NEGATIVE-PITCH-BITMAP-READ`
  State: Fixed
  Type: Bug report, memory safety
  Summary: FreeType bitmaps with negative pitch can be read with wrong row offsets.
  Impact: Wrong rows can corrupt glyph uploads, produce broken glyphs, or read out of bounds on bottom-up bitmap buffers.
  Evidence: `app/src/main/cpp/coder_font.cpp:135`, `:156`, `:880` use `std::abs(bitmap.pitch)` for row addressing.
  Goal: Make bitmap row access correct for both positive and negative pitch in all glyph conversion/blending paths.
  Deliverables: Signed pitch helper or equivalent row pointer logic; updated `blendMask`, `blendMaskFill`, and `bitmapBuffer`; focused test or fixture if practical.
  Validation plan: Native build; targeted bitmap conversion test if feasible; UIAutomator terminal smoke screenshot.
  Resolution: Added signed `bitmapRow` helper and routed `blendMask`, `blendMaskFill`, and `bitmapBuffer` through it so negative pitch reads rows in top-to-bottom glyph order.
  Validation: `./gradlew :app:externalNativeBuildDebug` passed; `./gradlew testDebugUnitTest` passed; `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface` passed on `emulator-5554`.
  UI proof: After screenshot `docs/reference/bug-native-negative-pitch-bitmap-read-smoke.png` captured with `android screen capture` after UI smoke; before screenshot unavailable because requirement was added after `261ca39` was already committed.
  Review: No findings.
  Commit: `261ca39`.

- [x] `BUG-RENDER-GLYPH-SNAP-WIDTH-DISTORTION`
  State: Fixed
  Type: Bug report, rendering correctness
  Summary: Glyph quads snap both left and right edges, which can stretch/shrink glyphs by column position.
  Impact: Same glyph can render with inconsistent pixel width, causing shimmer, distorted ligatures, and uneven monospace text.
  Evidence: `glyphXBounds` snaps both bounds in `app/src/main/cpp/coder_renderer.cpp:250`.
  Goal: Preserve exact glyph bitmap width while still aligning origin to pixel grid.
  Deliverables: Origin-only snapping; right edge computed from exact glyph width; screenshot or test covering repeated glyphs/ligatures.
  Validation plan: Native build; UIAutomator screenshot proving terminal text still renders; optional pixel-width check if practical.
  Resolution: Changed glyph quad bounds to snap only the left/origin edge and compute the right edge from the exact glyph bitmap width for both normal and wide-cell glyph paths.
  Validation: `./gradlew :app:externalNativeBuildDebug` passed; `./gradlew testDebugUnitTest` passed; `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface` passed on `emulator-5554`; `./gradlew :app:installDebug` succeeded for before/after proof installs.
  UI proof: Before `docs/reference/bug-render-glyph-snap-width-distortion-before.png`; after `docs/reference/bug-render-glyph-snap-width-distortion-after.png`; both captured with `android screen capture` from `pi://debug/render` terminal surface and manually inspected.
  Review: No findings.
  Commit: `HEAD` (`fix(render): preserve glyph bitmap width`).

- [x] `BUG-NATIVE-MOUSE-TRACKING-DATA-RACE`
  State: Fixed
  Type: Bug report, threading correctness
  Summary: `CoderTerminal::mouseTracking()` reads terminal state without `mutex_`.
  Impact: UI input can race render/feed/native terminal state, risking undefined behavior during mouse-tracking apps.
  Evidence: `app/src/main/cpp/coder_terminal.cpp:264`; JNI caller at `app/src/main/cpp/coder_jni.cpp:176` can run from UI input while render/feed runs elsewhere.
  Goal: Match locking discipline used by other `CoderTerminal` accessors.
  Deliverables: Lock added; no wider lock-order changes; stress or compile validation.
  Validation plan: Native build; unit/build checks; UIAutomator terminal smoke screenshot.
  Resolution: Added `mutex_` locking to `mouseTracking()` and made the mutex mutable so the const accessor can follow the same locking discipline as other terminal state reads.
  Validation: First `./gradlew :app:externalNativeBuildDebug` failed because `mouseTracking() const` could not lock non-mutable `mutex_`; after marking `mutex_` mutable, `./gradlew :app:externalNativeBuildDebug` passed, `./gradlew testDebugUnitTest` passed, and `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface` passed on `emulator-5554`.
  UI proof: Before smoke `docs/reference/bug-native-mouse-tracking-data-race-before.png`; after smoke `docs/reference/bug-native-mouse-tracking-data-race-after.png`; both captured with `android screen capture` from `pi://debug/render` and manually inspected.
  Review: No findings.
  Commit: HEAD (this commit).

- [x] `BUG-NATIVE-STARTUP-LEAKS-ON-PARTIAL-FAILURE`
  State: Fixed
  Type: Bug report, resource lifecycle
  Summary: `CoderTerminal::start()` can leak Ghostty handles if a later allocation fails before RAII assignment.
  Impact: Rare initialization failures can leak native resources and make future terminal starts less reliable.
  Evidence: Raw handles allocated with early returns in `app/src/main/cpp/coder_terminal.cpp:58-77`.
  Goal: Make startup exception/early-return safe.
  Deliverables: Local RAII wrappers or immediate member ownership; unchanged successful startup behavior; allocation-failure path considered.
  Validation plan: Native build; targeted unit/fake failure test if practical; UIAutomator smoke screenshot.
  Resolution: Replaced raw startup handles with local RAII handle wrappers that take ownership immediately after each successful allocation and move into member handles only after all allocations succeed.
  Validation: `./gradlew :app:externalNativeBuildDebug` passed; `./gradlew testDebugUnitTest` passed; `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface` passed on `emulator-5554`.
  UI proof: Before smoke `docs/reference/bug-native-startup-leaks-on-partial-failure-before.png`; after smoke `docs/reference/bug-native-startup-leaks-on-partial-failure-after.png`; both captured with `android screen capture` from `pi://debug/render` and manually inspected.
  Review: No findings.
  Commit: HEAD (this commit).

- [x] `PERF-RENDER-FULL-SNAPSHOT-COPY-EVERY-FRAME`
  State: Fixed
  Type: Performance issue, render CPU/memory
  Summary: Renderer copies the terminal grid every frame, then copies it again into renderer cache.
  Impact: Large terminals waste CPU and memory bandwidth even when content is unchanged.
  Evidence: `CoderRenderer::draw` calls `terminal.snapshot` in `app/src/main/cpp/coder_renderer.cpp:208`; `snapshot` copies `cells_` to `outputCells` in `app/src/main/cpp/coder_terminal.cpp:542`; renderer assigns `cachedCells_ = cells` in `app/src/main/cpp/coder_renderer.cpp:200`.
  Upstream reference: Ghostty keeps a renderer `terminal_state`, updates it under a tight mutex, then rebuilds GPU cells outside the terminal critical section in `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:1155-1280`, `:1358-1368`.
  Goal: Reduce or remove full-grid allocation/copy on clean frames while preserving selection overlay.
  Deliverables: Dirty-row transfer, renderer-owned buffers, or measured smaller step; before/after structural proof or measurement.
  Validation plan: Native build; terminal render UIAutomator screenshot; benchmark/trace or allocation reasoning.
  Resolution: Changed renderer cache update to take the snapshot vector by value and move it into `cachedCells_`, then render from `cachedCells_`. This removes the second full-grid copy on changed frames while preserving existing terminal snapshot and selection overlay behavior.
  Validation: `./gradlew :app:externalNativeBuildDebug` passed; `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface` passed on `emulator-5554`. Structural proof: old changed-frame cache path copied `N * sizeof(CoderCell)` from `snapshot` return into local cells plus copied another `N * sizeof(CoderCell)` via `cachedCells_ = cells`; new path keeps the snapshot return and replaces the renderer cache transfer with an O(1) vector move, reducing changed-frame full-grid cache-copy bandwidth from `2N` cell copies to `1N` cell copies.
  UI proof: Render smoke screenshot `docs/reference/perf-render-full-snapshot-copy-every-frame-after.png` captured with `android screen capture` from `pi://debug/render` and manually inspected.
  Review: No findings.
  Commit: HEAD (this commit).

- [ ] `PERF-RENDER-ROW-DIRTY-GPU-BUFFERS`
  State: Open
  Type: Performance issue, render architecture
  Summary: Android renderer rebuilds foreground/background vertex arrays monolithically instead of keeping row-wise dirty GPU-ready data.
  Impact: Small terminal changes can still force scanning/copying all cells and rebuilding large CPU-side vertex vectors.
  Evidence: Local renderer creates `std::vector<Vertex>` and `std::vector<SolidVertex>` per draw in `app/src/main/cpp/coder_renderer.cpp:224-225` and iterates all rows/cells when uploading in `coder_renderer.cpp:230-325`.
  Upstream reference: Ghostty's `Contents` is explicitly designed for row-wise dirty clearing to avoid rebuilding GPU buffers every frame in `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/cell.zig:33-73`, and `rebuildCells` skips non-dirty rows in `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:2338-2425`.
  Goal: Move toward persistent row-wise render buffers so clean rows are not rebuilt.
  Deliverables: Design/implementation for per-row retained glyph/background data, or first incremental step that removes per-frame vector churn; preserve cursor, selection, blinking, and decorations.
  Validation plan: Native build; UIAutomator terminal screenshot; structural proof showing clean rows skip rebuild or reduced allocations.

- [ ] `PERF-RENDER-GLYPH-VERTEX-STRIDE-TOO-LARGE`
  State: Open
  Type: Performance issue, GPU bandwidth
  Summary: Glyph vertex format uses 11 floats per vertex, 44-byte stride.
  Impact: Text-heavy frames upload excessive vertex data and consume avoidable GPU bandwidth.
  Evidence: `struct Vertex` in `app/src/main/cpp/coder_renderer.cpp:12`.
  Upstream reference: Ghostty packs one cell-text instance into a compact 32-byte `CellText` struct using integer positions, byte color, atlas enum, and packed bools in `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/opengl/shaders.zig:233-257`; backgrounds are `[4]u8` in `:259-260`.
  Goal: Reduce glyph vertex bandwidth without changing visual output.
  Deliverables: Packed color attributes; updated GL attribute declarations; byte-size comparison before/after.
  Validation plan: Native build; screenshot comparison/smoke; report old/new stride and upload byte reduction.

- [x] `PERF-RENDER-FRAME-ALLOCATION-CHURN`
  State: Fixed
  Type: Performance issue, CPU allocation
  Summary: Draw path allocates fresh foreground/background vectors every frame that needs upload.
  Impact: High-output or blinking sessions can cause avoidable heap churn and frame-time spikes.
  Evidence: Local draw creates `std::vector<Vertex> vertices` and `std::vector<SolidVertex> solidVertices` each frame in `app/src/main/cpp/coder_renderer.cpp:224-225`.
  Upstream reference: Ghostty preallocates retained cell contents per row in `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/cell.zig:95-123` and uses GL buffer wrappers that grow capacity but update with `setSubData` when possible in `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/opengl/buffer.zig:70-115`.
  Goal: Reuse CPU and GPU buffers across frames.
  Deliverables: Retained vector/buffer capacity, no fresh allocation on steady-state clean or small-dirty frames, measurement/proof of allocation reduction.
  Validation plan: Native build; UIAutomator smoke screenshot; allocation/count proof or structural proof.
  Resolution: Moved draw staging vectors into `CoderRenderer` members (`frameVertices_`, `frameSolidVertices_`, `frameSkipText_`) and clear/reuse them across uploads instead of constructing fresh vectors in `draw`.
  Validation: `./gradlew :app:externalNativeBuildDebug` passed; `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface` passed on `emulator-5554`. Structural proof: old upload path constructed 3 local vectors per upload frame (`vertices`, `solidVertices`, `skipText`) and reallocated capacity from zero; new path keeps 3 renderer-owned vectors, `clear()`/`assign()` reuse capacity after first growth, so steady-state upload frames allocate 0 new staging-vector buffers unless terminal size/content exceeds prior capacity.
  UI proof: Render smoke screenshot `docs/reference/perf-render-frame-allocation-churn-after.png` captured with `android screen capture` from `pi://debug/render` and manually inspected.
  Review: No findings.
  Commit: HEAD (this commit).

- [x] `BUG-RENDER-ATLAS-PADDING-UNINITIALIZED`
  State: Fixed
  Type: Bug report, rendering determinism
  Summary: Glyph atlas allocation leaves padding/border texels undefined.
  Impact: Future filtering or texture sampling changes can show garbage halos; current output depends on driver memory contents.
  Evidence: `glTexImage2D(..., nullptr)` in `app/src/main/cpp/coder_font.cpp:617`.
  Goal: Make atlas initial contents deterministic transparent black.
  Deliverables: Zero-filled allocation or clear path; no regressions to glyph upload; minimal memory overhead.
  Validation plan: Native build; terminal screenshot; optional GL/debug proof if practical.
  Resolution: Allocated a zero-filled RGBA buffer for atlas creation and passed it to `glTexImage2D`, making all padding and unused texels transparent black.
  Validation: `./gradlew :app:externalNativeBuildDebug` passed; `./gradlew testDebugUnitTest` passed; `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface` passed on `emulator-5554`.
  UI proof: Before `docs/reference/bug-render-atlas-padding-uninitialized-before.png`; after `docs/reference/bug-render-atlas-padding-uninitialized-after.png`; both captured with `android screen capture` from `pi://debug/render` and manually inspected.
  Review: No findings.
  Commit: HEAD (this commit).

- [x] `PERF-RENDER-ATLAS-NO-EVICTION`
  State: Fixed
  Type: Performance/resource scalability issue
  Summary: Glyph atlas grows to max texture size, then new glyph allocation fails permanently.
  Impact: Long sessions with many unique glyphs can lose glyph rendering until renderer/font reset.
  Evidence: Growth/failure path in `app/src/main/cpp/coder_font.cpp:620-633`, `:764-771`; no LRU or compaction exists.
  Goal: Keep recent glyphs renderable after atlas pressure.
  Deliverables: LRU eviction/page rotation, or documented smaller first step if implementation risk is high; stress plan with many unique glyphs.
  Validation plan: Native build; glyph stress test if feasible; UIAutomator smoke screenshot.
  Resolution: Added max-size atlas pressure recovery. If growth cannot proceed and allocation still fails, the font resets atlas pixels, cached glyph metadata, shelf allocator state, and atlas generation, then retries the requested glyph once so recent glyphs can render instead of failing permanently until renderer reset.
  Validation: `./gradlew :app:externalNativeBuildDebug` passed; `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface` passed on `emulator-5554`. Structural proof: old max-size overflow path returned `false` after `growAtlas()` failed; new path calls `resetAtlasForRecentGlyphs()` and retries allocation with an empty atlas, converting permanent failure into page-rotation-style recovery for current/recent glyphs.
  UI proof: Render smoke screenshot `docs/reference/perf-render-atlas-no-eviction-after.png` captured with `android screen capture` from `pi://debug/render`.
  Review: No findings.
  Commit: HEAD (this commit).

- [x] `PERF-RENDER-ATLAS-GROW-PRESERVE-DATA`
  State: Fixed
  Type: Performance issue, glyph atlas lifecycle
  Summary: Atlas growth rebuilds the atlas from scratch and clears glyph cache instead of preserving existing atlas data.
  Impact: Atlas growth can trigger expensive rerendering and visual stalls as previously cached glyphs are reuploaded on demand.
  Evidence: Local `growAtlas()` calls `rebuildAtlas()` in `app/src/main/cpp/coder_font.cpp:621-628`; `rebuildAtlas()` clears `glyphs_` and resets shelves in `coder_font.cpp:594-600`.
  Upstream reference: Ghostty atlas `grow` allocates larger data, zeroes it, copies old atlas data into the new atlas, and increments modified/resized counters in `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/Atlas.zig:320-364`; renderer only resizes/replaces GPU texture when atlas size exceeds texture width in `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:3355-3371`.
  Goal: Preserve cached glyph pixels and metadata across atlas growth where practical.
  Deliverables: Growth path that keeps existing glyph cache valid or explicitly proves shelf allocator prevents safe preservation; reduced glyph rerender after growth.
  Validation plan: Native build; glyph stress test or structural proof; UIAutomator smoke screenshot.
  Resolution: Added a CPU shadow atlas buffer, records glyph atlas coordinates, copies existing atlas rows into the larger buffer during growth, preserves shelf allocator state, reuploads preserved pixels with `glTexImage2D`, recalculates cached glyph UVs instead of clearing `glyphs_` while growing, and bumps an atlas generation so renderer vertex buffers rebuild after texture size changes.
  Validation: `./gradlew :app:externalNativeBuildDebug` passed; `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface` passed on `emulator-5554`. Structural proof: old growth path cleared `glyphs_`, forcing `G` cached glyphs to rerender/reupload on demand; new growth path keeps `G` metadata entries and copies `oldWidth * oldHeight * 4` atlas bytes once into the new texture, so existing glyphs remain valid after growth.
  UI proof: Render smoke screenshot `docs/reference/perf-render-atlas-grow-preserve-data-after.png` captured with `android screen capture` from `pi://debug/render` and manually inspected.
  Review: No findings.
  Commit: HEAD (this commit).

- [ ] `PERF-TERMINAL-MUTEX-CONTENTION-RENDER-FEED`
  State: Open
  Type: Performance issue, threading
  Summary: Render, feed, resize, selection, input, and getters share one terminal mutex.
  Impact: Continuous rendering can block input/feed and high-output sessions can stall frames.
  Evidence: `CoderTerminal` locks `mutex_` around `pump`, `feed`, `resize`, `snapshot`, input, selection, and getters; renderer calls `pump` then `snapshot` every frame.
  Upstream reference: Ghostty extracts critical terminal data under mutex, then does link/highlight/cell rebuild work outside the terminal critical section in `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:1164-1280`, `:1282-1368`.
  Goal: Reduce measured or obvious lock contention without unsafe concurrent terminal access.
  Deliverables: Shorter critical sections, copy reduction, or instrumentation proof; avoid unproven double-buffering unless needed.
  Validation plan: Native build; render/feed smoke; trace or reasoned measurement.

- [x] `BUG-RENDER-SYNCED-OUTPUT-MODE-IGNORED`
  State: Fixed
  Type: Bug report, terminal protocol UX
  Summary: Renderer does not honor synchronized output mode (`DECSET 2026`) to pause intermediate renders during bulk updates.
  Impact: Full-screen TUIs that use synchronized output can still show partial/intermediate frames, causing flicker and worse perceived performance.
  Evidence: Local draw path calls `terminal.pump()` then snapshots/draws every frame in `app/src/main/cpp/coder_renderer.cpp:204-230`; only local mode checks found are mouse/alt-scroll related in `app/src/main/cpp/coder_terminal.cpp:244-247`. `GHOSTTY_MODE_SYNC_OUTPUT` exists in `app/libs/include/ghostty/vt/modes.h:92`.
  Upstream reference: Ghostty checks `.synchronized_output` and skips rendering while active in `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:1176-1180`.
  Goal: Avoid rendering intermediate frames while synchronized output is active, without starving final frame after mode exits.
  Deliverables: Native mode check exposed to renderer or snapshot path; draw skip/present-last behavior; test sequence using DECSET/DECRST 2026 if feasible.
  Validation plan: Native build; terminal smoke screenshot; protocol smoke test or documented manual sequence.
  Resolution: Added locked `CoderTerminal::synchronizedOutput()` mode accessor and made `CoderRenderer::draw()` return immediately after `pump()` while `GHOSTTY_MODE_SYNC_OUTPUT` is active only after a non-empty glyph frame exists, preserving the last presented frame without allowing a blank initial frame.
  Validation: `./gradlew :app:externalNativeBuildDebug` passed; `./gradlew testDebugUnitTest` passed; `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface` passed on `emulator-5554`; blank after-screenshot regression was found during `BUG-STORE-BASEURL-HASHCODE-COLLISION` proof and fixed by requiring `cachedGlyphVertexCount_ > 0` before sync skip.
  UI proof: Before `docs/reference/bug-render-synced-output-mode-ignored-before.png`; after `docs/reference/bug-render-synced-output-mode-ignored-after.png`; both captured with `android screen capture` from `pi://debug/render` and manually inspected.
  Review: No findings.
  Commit: HEAD (this commit).

- [ ] `PERF-RENDER-SHAPER-RUN-CACHE-MISSING`
  State: Open
  Type: Performance issue, text shaping
  Summary: Shaped runs are recalculated repeatedly without a bounded run-level shaping cache.
  Impact: HarfBuzz shaping can dominate frame time for repeated prompts, ligatures, Arabic, emoji clusters, and stable rows.
  Evidence: Local renderer repeatedly calls `font_.shape(...)` for ASCII, Arabic, emoji clusters, and cell clusters in `app/src/main/cpp/coder_renderer.cpp:322` and subsequent shaping call sites; no run-level cache exists in `CoderFont` beyond glyph bitmap cache.
  Upstream reference: Ghostty adds a shaper cache because shaping once accounted for 96% of frame time, with a bounded 256-run cache in `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/shaper/Cache.zig:1-10`, `:32-78`; renderer consults and populates it in `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:2709-2735`, `:2977-3004`.
  Goal: Cache shaped run results using a key that includes text, font/style, feature flags, and relevant width constraints.
  Deliverables: Bounded cache with invalidation on font/feature/size changes; proof shaping calls drop on unchanged repeated rows.
  Validation plan: Native build; shaping cache unit test or instrumentation counters; UIAutomator smoke screenshot.

- [ ] `UX-RENDER-SYMBOL-CONSTRAINTS-MISSING`
  State: Open
  Type: UX issue, glyph layout quality
  Summary: Symbol-like glyphs, PUA/Nerd Font icons, and terminal graphics do not have Ghostty-style constraint logic for fitting or spanning cells.
  Impact: Powerline, Nerd Font icons, block/box glyphs, and symbols may be clipped, misaligned, or inconsistent versus desktop Ghostty.
  Evidence: Local renderer uses generic glyph bounds and only special-cases `GHOSTTY_CELL_WIDE_WIDE` in `app/src/main/cpp/coder_renderer.cpp:246-259`; no symbol/graphics-element constraint table exists.
  Upstream reference: Ghostty classifies symbol-like codepoints and graphics elements and computes `constraintWidth` based on neighboring cells in `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/cell.zig:233-330`; renderer passes those constraints into glyph rendering in `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:3176-3199`.
  Goal: Improve icon/box/powerline rendering by adopting or approximating Ghostty's symbol constraint rules.
  Deliverables: Symbol classification/constraint logic for relevant ranges; screenshot proof with Nerd Font/Powerline sample.
  Validation plan: Native build; UIAutomator screenshot with glyph demo; unit tests for constraint decisions if implemented in C++.

- [ ] `INVESTIGATE-RENDER-LINEAR-BLENDING-SRGB`
  State: Open
  Type: Investigation, rendering quality
  Summary: Android renderer uses simple alpha blending without explicit sRGB/linear blending policy or text-weight correction.
  Impact: Text color, contrast, and apparent glyph weight may differ from desktop Ghostty and vary by framebuffer/device behavior.
  Evidence: Local renderer enables blending with `glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA)` in `app/src/main/cpp/coder_renderer.cpp:76-120` and later switches glyph blending to premultiplied-style `GL_ONE, GL_ONE_MINUS_SRC_ALPHA` in `coder_renderer.cpp` draw path; no sRGB framebuffer or correction flags are present.
  Upstream reference: Ghostty tracks `use_display_p3`, `use_linear_blending`, and `use_linear_correction` shader flags in `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/opengl/shaders.zig:197-221`; its OpenGL path enables `GL_FRAMEBUFFER_SRGB` during context prep in `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/OpenGL.zig:130-137`.
  Goal: Decide whether Android GLES should enable sRGB/linear blending or text-weight correction, and document device constraints.
  Deliverables: Capability check, visual comparison, or non-actionable decision with evidence; no broad color change without screenshots.
  Validation plan: Device/emulator GL capability log; before/after screenshots if changed; UIAutomator smoke.

- [x] `BUG-NETWORK-CODERAPI-HTTPCLIENT-NOT-CLOSED`
  State: Fixed
  Type: Bug report, resource lifecycle
  Summary: Each `CoderApi` owns a Ktor `HttpClient`, but no close path exists when terminal sessions stop.
  Impact: Repeated terminal/session creation can leak network client resources.
  Evidence: `HttpClient(CIO)` in `app/src/main/java/com/coder/pi/CoderApi.kt:32`; sessions create `CoderApi` in `app/src/main/java/com/coder/pi/TerminalConnectionManager.kt:12`, `:61`.
  Goal: Ensure each owned `HttpClient` is closed exactly once at session/manager shutdown.
  Deliverables: `CoderApi.close()` or `Closeable`; ownership wired into `CoderTerminalSession.stop()`/manager; lifecycle test if feasible.
  Validation plan: Unit tests; `./gradlew testDebugUnitTest`; UIAutomator smoke screenshot if device available.
  Resolution: Made `CoderApi` implement idempotent `Closeable`, wired `CoderTerminalSession.stop()` to close its owned API after closing the terminal socket, and added a close-once regression test.
  Validation: `./gradlew testDebugUnitTest` passed; `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface` passed on `emulator-5554`.
  UI proof: Before smoke `docs/reference/bug-network-coderapi-httpclient-not-closed-before.png`; after smoke `docs/reference/bug-network-coderapi-httpclient-not-closed-after.png`; both captured with `android screen capture` from `pi://debug/render` and manually inspected.
  Review: No findings.
  Commit: HEAD (this commit).

- [x] `BUG-STORE-BASEURL-HASHCODE-COLLISION`
  State: Fixed
  Type: Bug report, persistence correctness
  Summary: Workspace state keys use Java/Kotlin `String.hashCode()` for `baseUrl`.
  Impact: Hash collisions can mix workspace aliases, icons, pins, reconnect tokens, or active terminal metadata between different servers.
  Evidence: `CoderSessionStore.stateKey` uses `${baseUrl.hashCode()}` in `app/src/main/java/com/coder/pi/CoderSessionStore.kt:170`.
  Goal: Use collision-resistant stable keying while preserving existing saved data where possible.
  Deliverables: Digest/encoding replacement; migration or compatibility read path; collision regression test using known colliding strings.
  Validation plan: Unit tests for unique prefixes and migration behavior; `./gradlew testDebugUnitTest`.
  Resolution: Replaced base URL `hashCode()` workspace prefix with SHA-256 hex digest of normalized base URL, kept legacy read paths for workspace state and reconnect tokens, removed both new and legacy active-terminal entries on deletion, and made UI smoke title matching resilient to debug font rotation.
  Validation: `./gradlew testDebugUnitTest` passed with regression tests for `https://coder.example/Aa` and `https://coder.example/BB` hash collision; first two UI smoke attempts failed with `Debug render title missing` due hardcoded rotating debug title expectation, then `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface` passed on `emulator-5554` after accepting any `DotAI OSC ` title; `./gradlew :app:externalNativeBuildDebug` passed for synchronized-output guard follow-up.
  UI proof: Before smoke `docs/reference/bug-store-baseurl-hashcode-collision-before.png`; after smoke `docs/reference/bug-store-baseurl-hashcode-collision-after.png`; both captured with `android screen capture` from `pi://debug/render` and manually inspected.
  Review: No findings.
  Commit: HEAD (this commit).

- [x] `BUG-OSC-PARSER-ADHOC-BYTE-SNIFFING`
  State: Non-actionable
  Type: Bug report, protocol correctness
  Summary: OSC 52, 9, 777, and OSC 7 forwarding are parsed with ad-hoc byte state.
  Impact: Fragmented, ST-terminated, or unusual valid OSC sequences can diverge from Ghostty parsing, affecting PWD, clipboard, notification, and progress events.
  Evidence: `processOscMetadata` and `finishOscMetadata` in `app/src/main/cpp/coder_terminal.cpp:591-675`; Ghostty exposes `ghostty/vt/osc.h` parser API.
  Goal: Use Ghostty OSC parser where it supports needed commands, or prove current parser handles required forms.
  Deliverables: Parser integration or targeted parser tests for BEL/ST/fragments; preserved existing OSC 9/52/777 behavior.
  Validation plan: Native/unit parser tests if possible; instrumentation OSC notification smoke if feasible; UI screenshot.
  Resolution: No code change. `app/libs/include/ghostty/vt/osc.h` only exposes typed data extraction for window title (`GHOSTTY_OSC_DATA_CHANGE_WINDOW_TITLE_STR`), not OSC 7, 52, 9/9;4, or 777 payloads used by Android forwarding. Current scanner already preserves state across fragments, terminates on BEL and ESC `\`, and keeps existing OSC 7/52/9/777 forwarding behavior.
  Validation: `./gradlew :app:externalNativeBuildDebug` passed; `./gradlew testDebugUnitTest` passed; `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface` passed on `emulator-5554`; debug OSC notification appeared in smoke proof.
  UI proof: Smoke screenshot `docs/reference/bug-osc-parser-adhoc-byte-sniffing-smoke.png` captured with `android screen capture`; notification `OSC notification smoke` visible.
  Review: No findings.
  Commit: HEAD (this commit).

- [ ] `UX-GESTURES-CUSTOM-TOUCH-STATE-MACHINE`
  State: Open
  Type: UX issue, maintainability
  Summary: Terminal gestures are one large custom touch state machine.
  Impact: Tap/double-tap/swipe/fling behavior can drift from Android conventions and is hard to regression-test.
  Evidence: `CoderTerminalView.onTouchEvent` handles pinch, tap counting, swipe, drag scroll, mouse tracking, and selection in `app/src/main/java/com/coder/pi/CoderTerminalView.kt:224-354`; no `GestureDetector` usage found.
  Goal: Improve maintainability/standard behavior without breaking terminal-specific mouse tracking and copy mode.
  Deliverables: Either safe `GestureDetectorCompat` adoption for tap/fling or documented non-actionable reason; UIAutomator gesture coverage.
  Validation plan: UIAutomator tests for tap/double-tap/swipe/scroll/copy/mouse where feasible; screenshots.

- [ ] `UX-HAPTICS-INCONSISTENT-POLICY`
  State: Open
  Type: UX issue, haptics
  Summary: Bell haptics and OSC progress haptics use different policy paths.
  Impact: Users cannot predict/control all terminal haptic feedback consistently.
  Evidence: Bell uses `performHapticFeedback(CLOCK_TICK)` in `app/src/main/java/com/coder/pi/CoderTerminalView.kt:1191-1198`; OSC progress uses `VibrationEffect.createWaveform` in `CoderTerminalView.kt:1308-1318`.
  Goal: One coherent settings/policy model for terminal haptics.
  Deliverables: Consistent enable/disable behavior; bell/progress pattern handling; settings/UI proof if changed.
  Validation plan: Unit/UI test where feasible; UIAutomator settings screenshot; manual proof fallback for vibration if emulator cannot vibrate.

- [ ] `UX-IME-PREEDIT-NOT-RENDERED`
  State: Open
  Type: UX issue, international text input
  Summary: Android input connection commits text and key events but does not expose composing/preedit text to the renderer.
  Impact: IME users typing CJK, accents, or dead-key compositions cannot see in-progress composition inside the terminal surface before commit.
  Evidence: Local `BaseInputConnection` overrides `commitText`, `sendKeyEvent`, and `deleteSurroundingText` only in `app/src/main/java/com/coder/pi/CoderTerminalView.kt:182-203`; search found no `setComposingText`, `finishComposingText`, or preedit support in app code.
  Upstream reference: Ghostty renderer state carries `preedit` and computes its visible range for cursor rendering in `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/State.zig:23-28`, `:45-123`; upstream renderer handles preedit during cell rebuild in `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:2381-2404`, `:2683-2705`.
  Goal: Support visible IME composing text without sending bytes to terminal until commit.
  Deliverables: Kotlin input connection composing callbacks; native/pre-render overlay or terminal preedit render path; CJK/dead-key manual or automated proof.
  Validation plan: Unit/input test where feasible; UIAutomator screenshot of composing text or exact emulator/IME blocker.

- [x] `BUG-IME-SINGLE-CODEPOINT-NONASCII-DROPPED`
  State: Fixed
  Type: Bug report, international text input
  Summary: Single non-ASCII committed characters can be dropped by the native text-input JNI path.
  Impact: IME/dead-key users committing one character such as `é`, `ع`, or `あ` may see no terminal input, while multi-character paths use raw UTF-8 bytes.
  Evidence: `sendText` sends one-character output through `native.nativeTextInput` in `app/src/main/java/com/coder/pi/CoderTerminalView.kt:471-488`; JNI iterates modified UTF-8 bytes and calls `CoderTerminal::key(0, *cursor, 0)` in `app/src/main/cpp/coder_jni.cpp:146-153`; `CoderTerminal::key` only sets UTF-8 for `unicodeChar < 0x80` in `app/src/main/cpp/coder_terminal.cpp:155-171`.
  Goal: Make committed non-ASCII text reach the terminal consistently for both one-codepoint and multi-codepoint input.
  Deliverables: UTF-8 text-write path for committed text or full Unicode key encoding; regression test for one-character non-ASCII commit; preserved control-key behavior.
  Validation plan: Unit/native input test if feasible; `./gradlew testDebugUnitTest`; UIAutomator or manual IME screenshot showing non-ASCII input.
  Resolution: Routed single-character committed text through UTF-8 write path when it contains non-ASCII characters, while preserving native key encoding for single ASCII input and existing prefixed/remote/multi-character write behavior.
  Validation: `./gradlew testDebugUnitTest` passed with `terminalTextInputUsesUtf8("é")` and `terminalTextInputUsesUtf8("あ")` regression coverage; `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface` passed on `emulator-5554`.
  UI proof: Before smoke `docs/reference/bug-ime-single-codepoint-nonascii-dropped-before.png` captured but blank due existing launch/render state; after smoke `docs/reference/bug-ime-single-codepoint-nonascii-dropped-after.png` captured with `android screen capture` from `pi://debug/render` and manually inspected.
  Review: No findings.
  Commit: HEAD (this commit).

- [x] `BUG-PASTE-BRACKETED-PASTE-MODE-IGNORED`
  State: Fixed
  Type: Bug report, protocol/security correctness
  Summary: Clipboard paste writes raw text instead of using Ghostty paste encoding and bracketed paste mode.
  Impact: TUIs and shells that enable bracketed paste cannot distinguish typed input from paste; unsafe pasted newlines/control bytes are not normalized through Ghostty's paste policy.
  Evidence: `pasteClip` forwards clipboard text to `sendText` in `app/src/main/java/com/coder/pi/CoderTerminalView.kt:500-512`; `sendText` writes multi-character text bytes directly in `CoderTerminalView.kt:471-488`; no local `GHOSTTY_MODE_BRACKETED_PASTE` usage was found. Ghostty exposes `ghostty_paste_encode`, which strips unsafe control bytes, wraps bracketed paste, and converts newlines for non-bracketed mode in `app/libs/include/ghostty/vt/paste.h:44-85`; `GHOSTTY_MODE_BRACKETED_PASTE` exists in `app/libs/include/ghostty/vt/modes.h:91`.
  Goal: Route clipboard paste through Ghostty paste encoding with current terminal bracketed-paste mode.
  Deliverables: Native paste method or Kotlin/native integration that checks mode 2004 and calls `ghostty_paste_encode`; tests for bracketed and non-bracketed paste; no change to ordinary typed text.
  Validation plan: Native/unit paste tests using DECSET/DECRST 2004; `./gradlew testDebugUnitTest`; UIAutomator terminal paste smoke screenshot.
  Resolution: Added `nativePaste` JNI path that checks `GHOSTTY_MODE_BRACKETED_PASTE`, encodes clipboard bytes through `ghostty_paste_encode`, and writes encoded paste bytes from `pasteClip` without changing ordinary `sendText` typed input.
  Validation: `./gradlew :app:externalNativeBuildDebug` passed; `./gradlew testDebugUnitTest` passed; `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#nativePasteUsesBracketedPasteMode` passed on `emulator-5554` and verifies non-bracketed newline to CR plus DECSET 2004 bracket wrapping; `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface` passed on `emulator-5554`.
  UI proof: Smoke screenshot `docs/reference/bug-paste-bracketed-paste-mode-ignored-after.png` captured with `android screen capture` from `pi://debug/render` and manually inspected.
  Review: No findings.
  Commit: HEAD (this commit).

- [x] `BUG-TERMINAL-FOCUS-EVENT-MODE-IGNORED`
  State: Fixed
  Type: Bug report, terminal protocol UX
  Summary: Focus reporting mode (`DECSET 1004`) is not wired to Android window/view focus changes.
  Impact: Editors and TUIs that rely on focus-in/focus-out cannot refresh state or suspend UI affordances correctly when the Android terminal gains or loses focus.
  Evidence: Android focus handling only hides system bars and refreshes surface in `app/src/main/java/com/coder/pi/TerminalActivity.kt:240-245`; no local `GHOSTTY_MODE_FOCUS_EVENT` usage was found. Ghostty exposes `ghostty_focus_encode` in `app/libs/include/ghostty/vt/focus.h:36-68`; upstream sends focus events when `.focus_event` mode is enabled in `/Users/shady/.cache/checkouts/github.com/ghostty-org/ghostty/src/termio/Termio.zig:619-631`.
  Goal: Send correct focus gained/lost escape sequences only when terminal focus reporting mode is active.
  Deliverables: Native focus-event method using current mode 1004 and `ghostty_focus_encode`; Android view/activity focus hook; test or manual sequence proof.
  Validation plan: Native/unit focus-mode test if feasible; UIAutomator focus transition smoke; screenshot/log proof or exact automation blocker.
  Resolution: Added `nativeFocusEvent` JNI path that checks `GHOSTTY_MODE_FOCUS_EVENT`, encodes focus gained/lost with `ghostty_focus_encode`, and hooked `MainActivity` plus `TerminalActivity` window focus changes through `CoderTerminalView.sendFocusEvent`.
  Validation: `./gradlew :app:externalNativeBuildDebug` passed; `./gradlew testDebugUnitTest` passed; `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#nativeFocusEventHonorsMode1004` passed on `emulator-5554` and verifies disabled mode emits empty, DECSET 1004 emits `CSI I`/`CSI O`, DECRST 1004 disables again; `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface` passed on `emulator-5554`.
  UI proof: Smoke screenshot `docs/reference/bug-terminal-focus-event-mode-ignored-after.png` captured with `android screen capture` from `pi://debug/render` and manually inspected.
  Review: No findings.
  Commit: HEAD (this commit).

- [ ] `A11Y-TERMINAL-NO-SCREEN-READER-VIRTUAL-NODES`
  State: Open
  Type: Accessibility issue
  Summary: `GLSurfaceView` terminal content is not exposed to screen readers.
  Impact: TalkBack users cannot explore visible terminal text through accessible virtual nodes.
  Evidence: No `ExploreByTouchHelper` usage found; `snapshotText()` exists.
  Goal: Expose useful visible terminal text to accessibility services.
  Deliverables: Virtual node support for lines or text ranges; accessible labels; fallback behavior when no terminal text exists.
  Validation plan: Accessibility/UIAutomator smoke; screenshot; document TalkBack manual check if automation cannot assert speech.

- [ ] `INVESTIGATE-NETWORK-KTOR-CIO-HANDOVER`
  State: Open
  Type: Investigation, network reliability
  Summary: API and terminal WebSockets use Ktor CIO; OkHttp may be better for mobile handover, but cause is unproven.
  Impact: Premature engine switch could add churn without improving reconnect reliability.
  Evidence: `HttpClient(CIO)` in `app/src/main/java/com/coder/pi/CoderApi.kt:32`; dependency in `app/build.gradle.kts:168`.
  Goal: Decide from evidence whether to keep CIO or switch to OkHttp.
  Deliverables: Handover test notes or blocker; decision record; code change only if evidence supports it.
  Validation plan: Wi-Fi/cellular or emulator network transition test if available; otherwise mark blocked with exact environment need.

## Not Filed As Issues

- [x] `NOBUG-HARFBUZZ-FONT-CHANGED-ON-RESIZE`
  State: Non-actionable
  Result: Denied as current bug.
  Evidence: `setCellSize` releases faces before rebuilding, and `hb_ft_font_create_referenced` is called after `configureFaceSize` in `app/src/main/cpp/coder_font.cpp:639-644`, `:655-656`, `:688-689`.
  Keep in mind: If future code changes face size without recreating `hb_font_t`, call `hb_ft_font_changed`.

- [x] `NOBUG-PROCESS-DEATH-RECONNECT-ID-PERSISTENCE`
  State: Non-actionable
  Result: Denied as current bug.
  Evidence: Active terminal metadata and `reconnect_id` persist in `CoderSessionStore.saveActiveTerminal` at `app/src/main/java/com/coder/pi/CoderSessionStore.kt:85-100`; loaded in `CoderApp.kt:336-358`; saved from `TerminalActivity.kt:82`, `:202`.
  Keep in mind: Buffer continuity after process death depends on remote backend behavior, not local persistence alone.

- [x] `NOBUG-GHOSTTY-TITLE-CALLBACK-MISSING`
  State: Non-actionable
  Result: Denied as current bug.
  Evidence: Title callback is registered via `GHOSTTY_TERMINAL_OPT_TITLE_CHANGED` in `app/src/main/cpp/coder_terminal.cpp:85`.

- [x] `NOBUG-HAPTIC-ENGINE-ABSENT`
  State: Non-actionable
  Result: Denied as current bug.
  Evidence: Bell and OSC progress haptics exist. Remaining work tracked by `UX-HAPTICS-INCONSISTENT-POLICY`.
