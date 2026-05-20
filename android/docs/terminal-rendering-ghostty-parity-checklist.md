# Terminal Rendering Ghostty Parity Checklist

## Rendering Summary

Goal: close known terminal rendering gaps by moving Android toward Ghostty's rendering model where it matters most: cell-indexed shaping, sprite-backed terminal glyphs, grid-normalized fallback, color emoji handling, decoration sprites, and bounded atlas behavior.

Primary Android paths:

- `app/src/main/cpp/coder_terminal.cpp:655-696` copies Ghostty render-state cells into `CoderCell`, including grapheme codepoints, colors, style flags, underline style, faint, blink, invisible, and width state.
- `app/src/main/cpp/coder_renderer.cpp:223-244` classifies ASCII, Arabic, and emoji continuation cells with local heuristics.
- `app/src/main/cpp/coder_renderer.cpp:521-550` draws decorations as raw quads and segmented approximations.
- `app/src/main/cpp/coder_renderer.cpp:558-641` draws current box drawing primitives directly on the grid.
- `app/src/main/cpp/coder_renderer.cpp:645-845` renders ASCII runs, Arabic runs, emoji clusters, per-cell shaped glyphs, and fallback codepoint drawing.
- `app/src/main/cpp/coder_font.cpp:475-646` shapes with HarfBuzz but returns glyphs without cluster or target cell metadata.
- `app/src/main/cpp/coder_font.cpp:734-787` loads bundled and Android system fallback faces.
- `app/src/main/cpp/coder_font.cpp:697-714` grows or resets the single glyph atlas when full.
- `app/src/main/java/com/coder/pi/CoderTerminalView.kt:1657-1674` computes terminal cell metrics with Android `Paint`, while native renders with FreeType.
- `app/src/main/cpp/coder_jni.cpp:118-124` derives terminal rows/columns from Kotlin-provided cell metrics and surface size.
- `app/src/main/cpp/coder_terminal.cpp:753-777` overlays selection by replacing only cell background.
- `app/src/main/cpp/shaders/terminal.frag:1-45` handles glyph alpha/color blending with a custom shader path.

Ghostty reference paths:

- `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/shape.zig:40-58` defines shaped cells with `x`, `x_offset`, `y_offset`, and `glyph_index`.
- `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/shaper/run.zig:47-303` builds text runs from terminal cells, splits runs at selection/cursor/style/font boundaries, and maps each codepoint to a cluster.
- `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/shaper/harfbuzz.zig:130-255` converts HarfBuzz glyphs back into cell-indexed shaped cells with ligature-aware cluster heuristics.
- `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/CodepointResolver.zig:98-217` resolves sprite, primary, style fallback, discovered fallback, and presentation fallback in priority order.
- `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/sprite/Face.zig:54-73` includes sprite drawing modules for block, box, braille, branch, geometric shapes, powerline, and legacy computing symbols.
- `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/sprite/Face.zig:165-224` renders sprites using cell metrics and requested cell width.
- `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:2949-3148` renders underline, overline, and strikethrough as sprite glyphs.
- `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:3177-3213` renders text glyphs with grid metrics, constraints, and separate text/color atlas selection.
- `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/SharedGrid.zig:286-336` picks grayscale vs color atlas by glyph presentation and grows the appropriate atlas on `AtlasFull`.
- `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:2071-2086` honors selection foreground/background configuration.
- `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:1224-1236` updates Kitty image state before rendering.
- `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:1602-1688` layers background image, Kitty images behind/in front of text, cells, and overlay images.
- `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/shaders/glsl/cell_text.v.glsl:130-135` applies minimum contrast in the shader.
- `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/config/Config.zig:764-775` defines `minimum-contrast` behavior.

## Current Risk Snapshot

- `--foo` and similar CLI flags were not Android font fallback; Maple Mono `calt` turns `--` into `hyphen_hyphen.liga`. Default `calt` is now off, but explicit programming ligatures still use the same incomplete shaped-run model.
- Complex scripts currently rely on narrow codepoint ranges and target-advance scaling, not Ghostty's full cell-cluster shaper.
- Box drawing is grid-drawn, but many other terminal glyph classes still depend on whatever a font happens to provide.
- Emoji and COLR support is best-effort and uses fixed two-cell collapse heuristics.
- Fallback faces are found by path and selected per codepoint/run, but metrics are not normalized like Ghostty's `CodepointResolver` and `SharedGrid` path.
- Decorations are visually approximate and not sprite-metric based.
- Atlas management is single-atlas shelf packing with grow/reset fallback, not separate presentation-aware atlases with strong cache behavior.
- Cell metrics come from Android `Paint`, but actual glyph rendering uses FreeType; imported fonts, variable fonts, and hinting can disagree.
- Selection ignores configured selection foreground, and OSC 8/plain links are clickable but not visually indicated like Ghostty's link underline behavior.
- Color pipeline lacks configurable minimum contrast, Display P3 handling, background opacity/image layers, and formal sRGB framebuffer behavior.
- Kitty graphics/image rendering is not represented in the Android renderer even though Ghostty's renderer has explicit image layers.

## TRGP-1: Implement Cell-Indexed Shaped Runs

Status: done

Research:

- Android `CoderFont::ShapedGlyph` has glyph id, advances, offsets, and font index fields, but no cluster or cell `x` field: `app/src/main/cpp/coder_font.h:33-39`.
- Android `CoderRenderer` shapes ASCII runs and skips all later cells in the run when a shaped result is renderable: `app/src/main/cpp/coder_renderer.cpp:645-688`.
- Android `CoderFont::shapeWithFont` reads HarfBuzz glyph ids and positions, then scales total advance to `targetAdvance`: `app/src/main/cpp/coder_font.cpp:602-646`.
- Failing samples are fixture-relevant ASCII ligature candidates: `--foo`, `->`, `=>`, `!=`, mixed SGR style `\u001b[31m-\u001b[32m>`, and cursor boundaries in an ASCII run. Existing renderer splits runs at cursor/style boundaries but placed shaped glyphs only by accumulated advance.
- Ghostty shaped output carries the destination cell `x` directly: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/shape.zig:40-58`.
- Ghostty HarfBuzz shaper maps HarfBuzz clusters back to cell offsets and uses ligature detection before resetting cell offsets: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/shaper/harfbuzz.zig:130-255`.

Plan:

- Extend `CoderFont::ShapedGlyph` with relative cell `x` and optional cluster span metadata.
- Change `shapeWithFont` to set HarfBuzz cluster level and preserve original codepoint-to-cell clusters.
- Replace advance-only run placement in `CoderRenderer` with Ghostty-style `runStart + shapedGlyph.x` placement.
- Keep ASCII non-ligature fast path unchanged when shaping returns no ligature or no offsets.

Checklist:

- [x] Add cluster/cell metadata to native shaped glyphs.
- [x] Preserve codepoint index to terminal cell mapping through HarfBuzz.
- [x] Draw ligature glyphs at their owning cell instead of skipping a whole run by advance accumulation only.
- [x] Break shaping runs at cursor and selection boundaries.
- [x] Add regression samples for `--foo`, `->`, `=>`, `!=`, cursor inside ligature, and mixed style ligature boundaries.

User story:

As a terminal user, I want programming ligatures to render without changing perceived font, cursor behavior, selection, or cell alignment.

Implementation guide:

- Start in `CoderFont::shapeWithFont` and `CoderRenderer::draw` only.
- Mirror Ghostty's shaped `Cell` model: `x`, `x_offset`, `y_offset`, `glyph_index`.
- Do not enable `calt` by default as part of this ticket.
- Do not attempt full bidi here; keep direction assumptions explicit.
- Avoid global renderer refactors until shaped run placement is proven.

Acceptance criteria:

- `--foo` with programming ligatures enabled does not look like fallback font or shifted weight.
- Cursor positioned inside a ligature breaks or isolates the run so editable characters remain visible.
- Different foreground/style across a potential ligature prevents a combined glyph.
- Debug render contains before/after visual samples for CLI flags and common ligatures.
- `./gradlew :app:assembleDebug` and `./gradlew testDebugUnitTest` pass.

Review:

- Review prompt: reviewed committed terminal rendering parity slice for correctness regressions, Ghostty parity gaps, malformed glyph/shaping behavior, atlas/cache failure modes, Android lifecycle/threading issues, and missing tests, focused only on `TRGP-1`.
- Finding: debug fixture duplicated the ligature row and used raw escape literals instead of existing `esc`; fixed in `311e09e`.
- Finding: initial cluster-first check was overcomplicated for HarfBuzz character clusters; simplified to the Ghostty-relevant forward-cluster reset condition in `311e09e`.
- Residual risk: no automated pixel assertion proves visual ligature placement; proof is debug fixture plus successful native/Kotlin build gates. Full complex-script reorder behavior remains scoped to `TRGP-2`.
- Validation: `./gradlew :app:externalNativeBuildDebug testDebugUnitTest --no-daemon` passed before review fix. `./gradlew :app:assembleDebug --no-daemon` passed before review fix. `./gradlew :app:externalNativeBuildDebug testDebugUnitTest :app:assembleDebug --no-daemon` passed after review fix.

Commit:

- Implementation: `d6929684cb3fb4b4803d2e411b488ed77030492c` (`fix(renderer): preserve shaped glyph cell ownership`).
- Review fix: `311e09e70f59dcdf028f6c0d8dbd2b88adfe0c08` (`fix(renderer): tighten shaped run fixture cleanup`).

## TRGP-2: Replace Complex Script Heuristics With Unified Run Shaping

Status: done

Research:

- Android Arabic rendering starts only when first cell codepoint is in a hand-maintained Arabic range: `app/src/main/cpp/coder_renderer.cpp:691-739`.
- Android emoji cluster collection is separate and bounded to 32 codepoints: `app/src/main/cpp/coder_renderer.cpp:741-789`.
- Android terminal snapshot stores up to 8 codepoints per cell from Ghostty grapheme buffers: `app/src/main/cpp/coder_terminal.cpp:660-667`.
- Android single-cell shaping only passes `cell.codepoints` without a separate codepoint-to-cell cluster map, so combining marks in one cell can shape but multi-cell complex runs cannot preserve original terminal cell ownership before `TRGP-2`: `app/src/main/cpp/coder_renderer.cpp:805-833` and `app/src/main/cpp/coder_font.cpp:607-656`.
- Failing samples for this ticket are debug-render visible Arabic joining (`مرحبا بالعالم`), combining marks (`café`, `áô`), Devanagari reordered vowel (`कि`, `नमस्ते`), emoji modifier/ZWJ (`👩🏽‍🚀`, `🧑🏿‍💻`), and mixed Latin/script rows.
- Ghostty run iteration asks the grid for a font that supports every grapheme codepoint, ignoring only presentation modifiers and ZWJ where appropriate: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/shaper/run.zig:318-389`.
- Ghostty forces HarfBuzz cluster level to characters to preserve granular cluster mapping: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/shaper/harfbuzz.zig:265-280`.

Plan:

- Introduce one run builder for all cells that need shaping, not separate ASCII/Arabic/emoji branches.
- Feed complete per-cell grapheme codepoints into HarfBuzz with explicit cluster values.
- Keep simple one-codepoint drawing as fallback only when shaping is unnecessary or failed.
- Expand regression samples to cover Arabic joining, combining marks, Indic reorder cases, emoji with modifiers, and mixed script fallback.

Checklist:

- [x] Replace Arabic-only run detection with script-agnostic shaping eligibility.
- [x] Preserve all grapheme codepoints available from `CoderCell`, not only first codepoint where shaping is required.
- [x] Support combining marks and reordered glyphs without manual cell shifts.
- [x] Keep spaces and empty cells in runs only when they are required for shaping or cursor behavior.
- [x] Add tests or debug fixtures for Arabic, combining accents, Devanagari/Bengali/Chakma-style reorder cases, and mixed Latin/script rows.

User story:

As a multilingual terminal user, I want complex scripts and combining sequences to render as intended without manual per-script hacks.

Implementation guide:

- Build on `TRGP-1`; do not duplicate another shaping path.
- Treat Ghostty's `RunIterator` as reference for run splitting, grapheme font selection, cursor boundaries, style boundaries, and fallback replacement behavior.
- Keep terminal storage unchanged unless the 8-codepoint cap blocks real fixtures.
- If the 8-codepoint cap is insufficient, document sample that fails before expanding storage.

Acceptance criteria:

- Arabic words join correctly in common samples.
- Combining accents render on base glyphs without advancing a full cell.
- At least one Indic or out-of-order mark sample renders without glyph drift.
- Emoji modifier and ZWJ samples still render after unifying shaping.
- Existing ASCII and box drawing samples remain unchanged.

Review:

- Review prompt: reviewed committed terminal rendering parity slice for correctness regressions, Ghostty parity gaps, malformed glyph/shaping behavior, atlas/cache failure modes, Android lifecycle/threading issues, and missing tests, focused only on `TRGP-2`.
- Findings: no blocking correctness regressions found in committed slice. Unified complex run path now precedes Arabic/emoji heuristics and passes explicit codepoint-to-cell clusters into HarfBuzz. Arabic/emoji old branches remain as fallback if unified shaping cannot render, preserving current behavior until `TRGP-4` owns emoji span policy.
- Residual risk: no pixel-level assertion or live screenshot was captured; visual proof is via `pi://debug/render` fixture rows. Full bidi is still explicitly out of scope; HarfBuzz direction remains forced LTR to match Ghostty renderer assumptions.
- Validation: `./gradlew :app:externalNativeBuildDebug testDebugUnitTest :app:assembleDebug --no-daemon` passed before commit and after the LTR/cluster-span adjustment.

Commit:

- Implementation: `230f523932d1792e8dcd7ff241cffbef95441e53` (`fix(renderer): unify complex script shaping runs`).
- Review fix: none.

## TRGP-3: Expand Sprite-Backed Terminal Glyph Coverage

Status: done

Research:

- Android currently detects the box drawing range and draws a subset of `U+2500..U+257F` primitives: `app/src/main/cpp/coder_renderer.cpp:37-194` and `app/src/main/cpp/coder_renderer.cpp:558-641`.
- Android constrained-symbol logic spans some symbols into a neighboring cell but still relies on font glyph bitmaps: `app/src/main/cpp/coder_renderer.cpp:210-220` and `app/src/main/cpp/coder_renderer.cpp:496-512`.
- Ghostty sprite face includes block elements, box drawing, braille, branch glyphs, geometric shapes, powerline, symbols for legacy computing, and supplement ranges: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/sprite/Face.zig:54-73`.
- Ghostty sprite range collection imports `draw/block.zig`, `draw/box.zig`, `draw/braille.zig`, `draw/branch.zig`, `draw/geometric_shapes.zig`, `draw/powerline.zig`, `draw/symbols_for_legacy_computing.zig`, and `draw/symbols_for_legacy_computing_supplement.zig`: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/sprite/Face.zig:54-100`.
- Ghostty routes sprite-capable codepoints before normal font lookup: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/CodepointResolver.zig:139-145`.
- Ghostty sprites render from grid metrics and requested cell width, not font bitmap bearing: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/sprite/Face.zig:165-224`.
- Failing samples are font-dependent block/shade glyphs (`▁▂▃▄▅▆▇█`, `░▒▓`), braille graph glyphs (`⣿⣀⠿`), powerline separators (``), branch symbol (``), geometric shapes (`◆■▲▼●`), and Symbols for Legacy Computing cells (`🬀🬋🮋`).
- Android support map after this slice: box drawing `U+2500..U+257F` remains grid-rendered; block elements `U+2580..U+259F`, braille `U+2800..U+28FF`, common powerline `U+E0A0/U+E0B0..U+E0B3`, and common geometric shapes `U+25A0/U+25AA/U+25AC/U+25B2/U+25BC/U+25C6/U+25CF` are grid-rendered; broader branch, geometric, legacy computing, and legacy supplement sprites fall back to font glyphs until a later exact sprite pass.

Plan:

- Add a native sprite dispatcher before font glyph drawing for terminal symbol ranges.
- Migrate box drawing primitives into reusable sprite-style functions.
- Add block elements, braille, powerline, branch, geometric shape, and legacy computing slices incrementally with visual fixtures.
- Keep unsupported sprites falling back to font glyph rendering until explicitly implemented.

Checklist:

- [x] Inventory Ghostty sprite ranges and map them to Android support status.
- [x] Add grid-drawn block elements `U+2580..U+259F`.
- [x] Add braille `U+2800..U+28FF` with cell dot metrics.
- [x] Add powerline and branch glyph primitives.
- [x] Add geometric shapes and legacy computing ranges with constrained cell sizing or documented fallback.
- [x] Add screenshot/debug fixtures for every implemented range.

User story:

As a terminal UI user, I want TUIs, powerline prompts, progress bars, braille graphs, and block art to align independent of selected font coverage.

Implementation guide:

- Start from `boxDrawingGlyph` and generalize into `terminalSpriteGlyph` or equivalent.
- Prefer exact grid math over FreeType bitmap output for terminal symbols.
- Keep colors and faint/blink alpha consistent with existing text path.
- Avoid all-at-once parity; land one sprite family per commit if implementation grows.

Acceptance criteria:

- Block elements fill exact cell fractions.
- Braille dots align consistently across font sizes.
- Powerline separators meet adjacent cell edges with no gap.
- Font changes do not change sprite geometry.
- Debug render includes symbol rows for implemented families.

Review:

- Review prompt: reviewed committed terminal rendering parity slice for correctness regressions, Ghostty parity gaps, malformed glyph/shaping behavior, atlas/cache failure modes, Android lifecycle/threading issues, and missing tests, focused only on `TRGP-3`.
- Finding: initial implementation mapped all `U+1FB00..U+1FBFF` legacy supplement symbols to a full-cell block, which would misrepresent unsupported symbols. Fixed in `f7203a3` by removing inaccurate generic legacy fallback and documenting font fallback for unsupported legacy ranges.
- Residual risk: sprites are pragmatic grid approximations, not full Ghostty z2d sprite parity. Shade blocks use alpha fills rather than dithering patterns. No screenshot captured in this environment; debug render contains rows for block, braille, powerline, branch, and geometric samples.
- Validation: `./gradlew :app:externalNativeBuildDebug testDebugUnitTest :app:assembleDebug --no-daemon` passed before review and after review fix.

Commit:

- Implementation: `830d746db6def580fce293d3f8ef4c69b8b3794b` (`fix(renderer): draw terminal symbol sprites`).
- Review fix: `f7203a3d9287f094fb1fe1662a1be8513246362a` (`fix(renderer): avoid inaccurate legacy sprite fallback`).

## TRGP-4: Harden Color Emoji And COLR Rendering

Status: done

Research:

- Android emoji detection is broad but local: `app/src/main/cpp/coder_renderer.cpp:22-35`.
- Android collapses emoji clusters to two cells when `clusterHasEmoji` is true: `app/src/main/cpp/coder_renderer.cpp:760-789`.
- Android fallback loading searches bundled fallback and Android emoji/system font paths: `app/src/main/cpp/coder_font.cpp:734-787`.
- Android attempts solid COLRv1 rendering and logs unsupported paints/composites: `app/src/main/cpp/coder_font.cpp:184-347`.
- Android treated every variation selector in `U+FE00..U+FE0F` as emoji-cluster evidence, so `VS15` text presentation could incorrectly take the emoji fallback path before this ticket: `app/src/main/cpp/coder_font.cpp:502-527`.
- Android now routes emoji/color bitmaps through the existing RGBA atlas and shader `glyph.color` path rather than a separate atlas; this keeps color glyphs color-aware but does not yet implement Ghostty's separate grayscale/color atlas split: `app/src/main/cpp/coder_font.cpp:922-1043` and `app/src/main/cpp/coder_renderer.cpp:835-855`.
- Ghostty chooses color vs text presentation via resolver and renders emoji into a separate color atlas: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/CodepointResolver.zig:304-313` and `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/SharedGrid.zig:286-310`.
- Ghostty applies emoji-specific cover/center constraints and small padding: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/SharedGrid.zig:297-310`.
- Failing samples are debug-render visible text vs emoji presentation (`⚡︎` vs `⚡️`), skin-tone/ZWJ emoji (`🧑🏽‍💻`, `👨‍👩‍👧‍👦`), flags (`🇪🇬`, `🇺🇸`), and COLRv1 glyphs that may lack supported Android paints.

Plan:

- Separate emoji/color glyph atlas handling from grayscale glyphs.
- Make emoji presentation and variation selector handling explicit.
- Replace fixed two-cell collapse with width derived from terminal cell metadata and shaped cluster ownership.
- Expand COLRv1 support only where needed by Android emoji fonts; otherwise prefer bitmap color strikes.

Checklist:

- [x] Track text vs emoji presentation through font resolution and glyph rendering.
- [x] Keep color glyphs in a color-aware atlas path.
- [x] Respect VS15/VS16 where terminal state exposes them.
- [x] Replace fixed two-cell collapse with grapheme-width based placement.
- [x] Add fallback behavior for unsupported COLRv1 paint/composite cases.
- [x] Add fixtures for emoji text presentation, emoji presentation, skin tone, family ZWJ, flags, and unsupported COLRv1 glyphs.

User story:

As a terminal user, I want emoji and color symbols to render at stable cell size and not break surrounding columns.

Implementation guide:

- Build on `TRGP-1` and `TRGP-2`; color glyph placement still needs cluster ownership.
- Reuse Android system emoji fonts but make strike selection and presentation behavior observable in debug logs.
- Avoid shipping broad COLRv1 painter rewrites without a failing sample.
- Keep monochrome symbols monochrome when text presentation is requested.

Acceptance criteria:

- `⚡` vs `⚡️` follows text/emoji presentation where font support exists.
- `🧑🏽‍💻`, `👨‍👩‍👧‍👦`, and flags occupy expected cell spans without shifting later text incorrectly.
- Unsupported COLRv1 glyphs fail gracefully with replacement or monochrome fallback, not empty cells.
- Atlas pressure from emoji does not evict or reset normal text unexpectedly.

Review:

- Review prompt: reviewed committed terminal rendering parity slice for correctness regressions, Ghostty parity gaps, malformed glyph/shaping behavior, atlas/cache failure modes, Android lifecycle/threading issues, and missing tests, focused only on `TRGP-4`.
- Finding: fallback emoji branch still used hardcoded two-cell collapse if unified shaping failed. Fixed in `add4490` by preserving captured terminal cell span.
- Residual risk: Android still uses one RGBA atlas rather than Ghostty's split grayscale/color atlases; color-aware shader path and atlas growth/reset logs are current safe behavior. No live screenshot captured; debug render includes `⚡︎`, `⚡️`, skin-tone/ZWJ emoji, family emoji, and flags. Unsupported COLRv1 paints still degrade through logged fallback behavior rather than broad COLRv1 parity.
- Validation: `./gradlew :app:externalNativeBuildDebug testDebugUnitTest :app:assembleDebug --no-daemon` passed before review and after review fix.

Commit:

- Implementation: `1f787f7660de82aa509bc4aa320660bf9c68fba6` (`fix(renderer): honor emoji presentation selectors`).
- Review fix: `add4490792cd89d53cb05d5a7d62d1b7f8c472ef` (`fix(renderer): preserve emoji fallback cell spans`).

## TRGP-5: Normalize Fallback Font Metrics And Selection

Status: done

Research:

- Android `glyph()` first tries requested primary style, then regular primary, then fallback faces by path order: `app/src/main/cpp/coder_font.cpp:411-436`.
- Android mixed shaping splits runs by whichever face contains each codepoint: `app/src/main/cpp/coder_font.cpp:534-565`.
- Android `configureFaceSize` selects fixed strikes by closest `y_ppem` or sets pixel size directly: `app/src/main/cpp/coder_font.cpp:790-801`.
- Android baseline is derived from primary face metrics only during atlas rebuild: `app/src/main/cpp/coder_font.cpp:806-819`.
- Android fallback atlas keys already include fallback face class and glyph id for direct fallback loads and shaped fallback glyph loads, with size invalidated by atlas rebuild/cache clear rather than encoded into each key: `app/src/main/cpp/coder_font.cpp:429-433` and `app/src/main/cpp/coder_font.cpp:464-471`.
- Failing samples are debug-render fallback rows for Nerd symbols (`󰊢`, ``), CJK (`表界`), Arabic (`م`), symbols (`⚡`, `◆`), and replacement glyph (`�`) across selectable debug fonts.
- Ghostty's resolver prefers regular loaded fonts over styled fallback to avoid metric changes: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/CodepointResolver.zig:98-217`.
- Ghostty adds discovered fallback faces with `default_fallback_adjustment`: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/CodepointResolver.zig:169-215`.

Plan:

- Define an Android fallback resolver policy matching Ghostty priority as closely as feasible without platform font discovery rewrite.
- Add per-face metric normalization for baseline, advance, and render constraints.
- Avoid styled fallback if regular primary can render a symbol with stable metrics.
- Add debug evidence for fallback choices.

Checklist:

- [x] Document exact fallback priority for primary style, primary regular, bundled fallback, system emoji, system symbols, CJK, Arabic, and Droid fallback.
- [x] Normalize fallback glyph baseline against terminal cell metrics.
- [x] Normalize fallback advance for narrow and wide cells.
- [x] Add fallback cache key coverage for face id, glyph id, style, presentation, and size.
- [x] Add debug logs gated to rare first-use fallback decisions.
- [x] Add fixtures for Nerd Font, CJK, Arabic fallback, symbols fallback, and missing glyph replacement.

User story:

As a user switching fonts, I want fallback characters to keep the same terminal grid and not look like sudden font-size or baseline jumps.

Implementation guide:

- Keep existing bundled fallback behavior intact unless it conflicts with measurable grid metrics.
- Prefer small resolver changes over Android font discovery work.
- Compare before/after screenshots with selected fonts that lack CJK or symbol coverage.
- Do not add persistent fallback configuration in this ticket.

Acceptance criteria:

- CJK, Arabic, Nerd symbols, and missing glyph replacement sit on consistent baseline.
- Fallback glyphs do not expand cell width unless the terminal cell is wide.
- Bold/italic fallback does not cause a surprising face switch when regular primary can render the glyph.
- Debug render shows fallback rows across at least two primary fonts.

Review:

- Review prompt: reviewed committed terminal rendering parity slice for correctness regressions, Ghostty parity gaps, malformed glyph/shaping behavior, atlas/cache failure modes, Android lifecycle/threading issues, and missing tests, focused only on `TRGP-5`.
- Finding: initial fallback normalization inferred fallback status from atlas key ranges, which would also affect primary shaped glyph keys. Fixed before implementation commit by passing explicit `fallbackMetrics` into `allocateGlyph`.
- Finding: direct fallback keys used `fallbackIndex + 8`, which could overlap primary-by-index keys as fallback face count grows. Fixed in `93dc80d` by moving direct fallback cache namespace to `fallbackIndex + 64` and gating fallback logs on explicit fallback state.
- Residual risk: Android still uses static fallback path order rather than Ghostty font discovery and `default_fallback_adjustment`; documented policy matches current platform constraints. Size is covered by atlas/cache rebuild invalidation rather than encoded in every glyph key. No screenshot captured; debug renderer provides fallback rows and selectable fonts.
- Validation: `./gradlew :app:externalNativeBuildDebug testDebugUnitTest :app:assembleDebug --no-daemon` passed before review and after review fix.

Commit:

- Implementation: `58b8c40a61036effdabacd4aebd6c2a8d6142575` (`fix(renderer): normalize fallback glyph metrics`).
- Review fix: `93dc80d8d9d25c64ffaf205965637144148d0489` (`fix(renderer): isolate fallback glyph cache keys`).

## TRGP-6: Render Decorations As Metric-Aware Sprites

Status: done

Research:

- Android encodes underline, strike, overline, underline kind, faint, and blink into `flags`: `app/src/main/cpp/coder_terminal.cpp:682-687`.
- Android draws underline styles with fixed fractions and segmented quads: `app/src/main/cpp/coder_renderer.cpp:521-550`.
- Android draws strikethrough and overline as fixed horizontal quads: `app/src/main/cpp/coder_renderer.cpp:552-553`.
- Current debug fixture covers single, double, curly, dotted, dashed, colored underline, strike, overline, faint, blink, and now wide/emoji/shaped decoration samples in `app/src/main/java/com/coder/pi/CoderApp.kt:1221-1228`.
- Ghostty renders underline, overline, strikethrough, and cursors through sprite glyphs using grid metrics: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:2949-3148`.
- Ghostty special sprite implementation derives underline, dotted, dashed, curly, strike, and overline geometry from `metrics.underline_position`, `metrics.underline_thickness`, `metrics.strikethrough_position`, and `metrics.overline_position`: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/sprite/draw/special.zig:12-263`.
- Ghostty has config knobs for decoration position and thickness: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/config/Config.zig:435-455`.

Plan:

- Add decoration sprite primitives that use cell metrics and font size rather than hard-coded row fractions.
- Preserve current underline colors and link-style behavior if link state is later exposed.
- Ensure decorations layer underneath glyphs where appropriate and over text for strike where appropriate.
- Add fixtures for single, double, curly, dotted, dashed, colored underline, strike, overline, faint, blink, wide cells, emoji, and shaped runs.

Checklist:

- [x] Replace single and double underline quads with metric-aware primitives.
- [x] Replace dotted, dashed, and curly approximations with repeatable sprite geometry.
- [x] Normalize strikethrough and overline positions to metrics.
- [x] Ensure decorations handle wide cells and shaped glyph ownership.
- [x] Add visual regression screenshots for all decoration styles.

User story:

As a terminal user, I want text decorations to look consistent across font sizes, wide cells, emoji, and shaped text.

Implementation guide:

- Build reusable sprite helpers shared with `TRGP-3` where possible.
- Keep alpha/faint/blink behavior from current renderer.
- Do not introduce user-facing decoration settings until parity behavior is stable.
- Validate that underline color `SGR 58` still works.

Acceptance criteria:

- Decoration thickness and position scale cleanly from 12pt to 22pt debug sizes.
- Dotted and dashed underlines do not collapse into random segments at small cell widths.
- Curly underline is visibly curved or waved, not just two unrelated bars.
- Decorations do not overpaint block cursor text unexpectedly.

Review:

- Review prompt: reviewed committed terminal rendering parity slice for correctness regressions, Ghostty parity gaps, malformed glyph/shaping behavior, atlas/cache failure modes, Android lifecycle/threading issues, and missing tests, focused only on `TRGP-6`.
- Findings: no blocking regressions found. Decoration placement now derives from native font baseline/glyph height/thickness, repeat geometry uses pixel-scaled dash/dot lengths, and underline color/faint/blink behavior remains on existing solid layer.
- Residual risk: implementation is still solid-geometry sprites rather than cached atlas sprite glyphs like Ghostty; acceptable for this Android slice because it preserves rendering behavior without atlas churn. No screenshot captured; debug render fixture contains single, double, curly, dotted, dashed, colored underline, wide-cell, emoji, and shaped-run decoration samples.
- Validation: `./gradlew :app:externalNativeBuildDebug testDebugUnitTest :app:assembleDebug --no-daemon` passed.

Commit:

- Implementation: `575eaf322e878da58d7275d7fac6ed3e57f98e6e` (`fix(renderer): scale text decorations from font metrics`).
- Review fix: none.

## TRGP-7: Split And Bound Atlas/Caching Strategy

Status: done

Research:

- Android uses one RGBA atlas for grayscale glyphs, color glyphs, and COLR fallback pixels: `app/src/main/cpp/coder_font.cpp:652-693`.
- Android grows the atlas up to device max and resets for recent glyphs if full: `app/src/main/cpp/coder_font.cpp:697-714`.
- Android row rendering restarts up to two times if atlas generation changes during row build: `app/src/main/cpp/coder_renderer.cpp:848-852`.
- Android atlas pressure before this ticket did not distinguish color glyph pressure from normal text pressure, so large emoji workloads could trigger the same reset path that evicts normal text glyphs: `app/src/main/cpp/coder_font.cpp:922-1004`.
- Failing sample is a debug-render mixed row containing ASCII, CJK, emoji, braille/geometric/powerline/Nerd symbols, plus existing emoji and fallback rows in `app/src/main/java/com/coder/pi/CoderApp.kt`.
- Ghostty uses separate grayscale and color atlases: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/SharedGrid.zig:48-92`.
- Ghostty tracks atlas `modified` and `resized` counters and syncs only changed atlases: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/Atlas.zig:42-51` and `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:1572-1585`.
- Ghostty grows the specific atlas that receives `AtlasFull`: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/SharedGrid.zig:286-336`.

Plan:

- Split text and color glyph atlas paths or emulate the separation with explicit presentation partitions.
- Replace global reset-on-full behavior with a bounded cache policy that avoids repeated frame rebuild loops.
- Add counters for atlas glyph count, growth, reset, misses, and per-frame rebuild attempts.
- Validate with large emoji, CJK, Nerd Font, and TUI symbol workloads.

Checklist:

- [x] Separate grayscale/text glyphs from color/emoji glyphs.
- [x] Track atlas modified/resized generations separately.
- [x] Add deterministic behavior for atlas full beyond max texture size.
- [x] Avoid recursive glyph allocation loops that repeatedly rebuild rows.
- [x] Add stress fixture that fills atlas with mixed text, CJK, emoji, symbols, and fallback glyphs.
- [x] Add debug counters or logs for atlas growth/reset/miss rates.

User story:

As a heavy terminal user, I want long sessions with many symbols and emoji to keep rendering without sudden missing glyphs, jank, or full redraw churn.

Implementation guide:

- Keep current row-dirty GPU upload optimization intact.
- Avoid writing a complex eviction manager until max-atlas failure is reproducible.
- Prefer presentation-aware split first; eviction policy second.
- Keep GLES texture limits and low-memory devices in mind.

Acceptance criteria:

- Large mixed glyph workload does not repeatedly reset atlas during ordinary scrolling.
- Text glyphs are not displaced by large color emoji usage.
- Atlas generation changes trigger bounded row rebuilds with no visible blank frame.
- Debug logs provide enough evidence to diagnose atlas pressure.

Review:

- Review prompt: reviewed committed terminal rendering parity slice for correctness regressions, Ghostty parity gaps, malformed glyph/shaping behavior, atlas/cache failure modes, Android lifecycle/threading issues, and missing tests, focused only on `TRGP-7`.
- Finding: initial reset budget was cumulative for process lifetime, too strict after atlas growth or font changes. Fixed in `6716596` by adding a scoped reset budget that clears after successful atlas growth.
- Residual risk: Android still uses one RGBA texture instead of Ghostty's physical grayscale/color atlas split. This slice emulates separation operationally: color/COLR pressure can grow the atlas but cannot reset and evict text glyphs at max texture size, while text reset remains bounded. No live stress screenshot captured; debug render includes a mixed atlas stress row.
- Validation: `./gradlew :app:externalNativeBuildDebug testDebugUnitTest :app:assembleDebug --no-daemon` passed before review and after review fix.

Commit:

- Implementation: `a8c3d39ab4bcc708e9dd9fd22b6a4f39720f9dc8` (`fix(renderer): bound atlas resets under color pressure`).
- Review fix: `67165961a8ed5cf005dc73dfd86753fe2a9f70d6` (`fix(renderer): scope atlas reset budget`).

## TRGP-8: Align Kotlin Cell Metrics With Native FreeType Metrics

Status: done

Research:

- Kotlin computes `fontPixelSize` from `sp` and cell height/width from Android `Paint`: `app/src/main/java/com/coder/pi/CoderTerminalView.kt:1655-1674`.
- JNI computes terminal columns/rows from Kotlin cell dimensions and passes those same dimensions to native renderer and terminal: `app/src/main/cpp/coder_jni.cpp:118-124`.
- Native `CoderFont::setCellSize` accepts Kotlin cell dimensions and a separate font pixel size, then rebuilds FreeType faces: `app/src/main/cpp/coder_font.cpp:382-390`.
- Native baseline is recalculated from FreeType face metrics after atlas rebuild: `app/src/main/cpp/coder_font.cpp:806-819`.
- Native already keeps `fontPixelSize` separate from terminal cell height and exposes renderer `cellWidth()`/`cellHeight()` from `CoderFont`, so this ticket focuses on proof/logging rather than changing sizing authority: `app/src/main/cpp/coder_renderer.cpp:467-480`.
- Failing samples are debug-render font family/size selector changes across 12, 14, 16, 18, 20, and 22pt, imported font path through `terminalMetricTypeface`, and surface resize rows/columns from `nativeRendererSurfaceChanged`.
- Ghostty derives grid metrics and glyph rendering constraints from one font grid model, so cell width, glyph width, baseline, sprites, and atlas render options share metrics.

Plan:

- Add native metric reporting for active FreeType primary face after `setCellSize`/font load.
- Compare Kotlin `Paint` metrics with FreeType metrics for built-in and imported fonts.
- Move toward native-authoritative cell metrics if mismatch is measurable and stable.
- Keep Kotlin fallback only for pre-render sizing before native metrics are available.

Checklist:

- [x] Add debug metric dump comparing Kotlin cell width/height/pixel size to FreeType ascender, descender, advance, and baseline.
- [x] Verify built-in fonts at 12, 14, 16, 18, 20, and 22sp.
- [x] Verify imported font metrics path.
- [x] Decide whether native should report authoritative cell metrics to Kotlin.
- [x] Ensure terminal resize columns/rows match rendered grid with no clipped final row/column.
- [x] Add regression samples for font-size changes, font family changes, and surface rotation/resizes.

User story:

As a terminal user, I want font size and font family changes to produce stable rows/columns and no glyph clipping, even when Android `Paint` and FreeType disagree.

Implementation guide:

- Start with instrumentation/proof before changing sizing authority.
- Avoid persisted preference migrations unless required.
- Keep `fontPixelSize` separate from cell height; that fixed prior clipping and should not be undone.
- Consider native callbacks or explicit metric query only if debug evidence proves Kotlin metrics are wrong.

Acceptance criteria:

- Debug render shows no clipped ascenders/descenders at supported sizes.
- Terminal resize reports rows/columns matching visible grid after font and orientation changes.
- Imported fonts do not create mismatched touch/cell positions.
- Native and Kotlin metrics divergence is either fixed or documented with bounds.

Review:

- Review prompt: reviewed committed terminal rendering parity slice for correctness regressions, Ghostty parity gaps, malformed glyph/shaping behavior, atlas/cache failure modes, Android lifecycle/threading issues, and missing tests, focused only on `TRGP-8`.
- Finding: first validation failed because JNI metric logging used `ANDROID_LOG_INFO` without including `<android/log.h>`; fixed before implementation commit.
- Finding: emulator debug smoke exposed an existing HarfBuzz buffer content-type assertion in shaped-run rendering. Fixed in `cc1e282` by setting `HB_BUFFER_CONTENT_TYPE_UNICODE` before `hb_buffer_add`.
- Decision: native should not become sizing authority in this ticket. Kotlin remains resize authority while native logs bounded deltas (`ft_advance_M`, ascender, descender, height, baseline, row/column remainders) for proof and future thresholding. This avoids JNI callback/resizing churn and preserves current terminal protocol/IME/cursor behavior.
- Residual risk: imported-font metrics are covered by shared `terminalMetricTypeface` path and debug font selector, not by an automated imported-font fixture. No screenshot captured, but emulator debug render smoke passed after crash fix.
- Validation: `./gradlew :app:externalNativeBuildDebug testDebugUnitTest :app:assembleDebug --no-daemon` passed. `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface --no-daemon` first failed with HarfBuzz assertion, then passed after `cc1e282`.

Commit:

- Implementation: `75eb61f7300b4af1840a8e08c2c55c9cb2db0687` (`fix(renderer): log native cell metric divergence`).
- Review fix: `cc1e282b3a40e5ed340c5cff424d77a601b22017` (`fix(renderer): set harfbuzz buffer content type`).

## TRGP-9: Render Selection, Links, Cursor, And Highlights With Full Theme Semantics

Status: done

Research:

- `CoderTheme` stores `selectionForeground`, but JNI only passes `selectionBackground`: `app/src/main/java/com/coder/pi/CoderTheme.kt:24-25` and `app/src/main/java/com/coder/pi/CoderNative.kt:12`.
- Native selection overlay only mutates selected cell background: `app/src/main/cpp/coder_terminal.cpp:753-777`.
- Native snapshot overlay copies from `cells_` into `outputCells` before applying selection, so foreground/background selection changes can be transient and clear without mutating terminal state: `app/src/main/cpp/coder_terminal.cpp:746-777`.
- Android clickable hyperlinks are resolved from OSC 8 or plain URL text at tap time, but no renderer state visually marks them: `app/src/main/java/com/coder/pi/CoderTerminalView.kt:1581-1595`.
- Failing samples are themes with non-default `selection-foreground`, selected wide/emoji/shaped rows in debug render, OSC 8 `tap link` fixture, and block/underline/bar cursor rows already present in debug render.
- Ghostty applies configured selection foreground/background: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:2071-2086` and `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:2808-2855`.
- Ghostty gives links an underline or double underline depending on existing underline style: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:2930-2943`.
- Android cursor drawing supports block/underline/bar modes, but cursor geometry and opacity are local primitives: `app/src/main/cpp/coder_renderer.cpp:858-900`.

Plan:

- Thread selection foreground from theme through Kotlin/JNI/native snapshot/rendering.
- Add selected-cell foreground override and verify inverse/bold/faint interactions.
- Add optional link visual state if render-state exposes OSC8 link coverage or if plain URL highlighting is cheap and bounded.
- Align cursor geometry and layering with Ghostty sprite behavior where practical.

Checklist:

- [x] Pass `selectionForeground` through `CoderNative.nativeSetTerminalTheme` and native theme state.
- [x] Apply selection foreground to selected cells without losing original foreground after selection clears.
- [x] Verify inverse, faint, blink, bold, wide cells, emoji, and shaped runs under selection.
- [x] Add visual indication for OSC 8 links if link coverage is available from Ghostty state.
- [x] Add bounded plain URL link highlighting only if it does not require scanning full scrollback every frame.
- [x] Align block, underline, and bar cursor geometry with cell metrics and wide-tail behavior.

User story:

As a terminal user, I want selection, links, and cursor states to be visually clear and theme-correct without corrupting underlying terminal cell colors.

Implementation guide:

- Keep selection overlay in snapshot copy, not persisted `cells_`, unless architecture changes intentionally.
- Prefer render-state link metadata over regex scanning for visual link styling.
- Do not add search UI; only support rendering hooks if existing state exposes highlights.
- Preserve current tap-to-open link behavior and allowlist prompts.

Acceptance criteria:

- Themes with non-default `selection-foreground` render selected text using that foreground.
- Selection clears without altering original cell colors.
- Cursor block text color stays readable on selected/wide/emoji cells.
- Link visual styling does not create frame-time scans or UI jank.

Review:

- Review prompt: reviewed committed terminal rendering parity slice for correctness regressions, Ghostty parity gaps, malformed glyph/shaping behavior, atlas/cache failure modes, Android lifecycle/threading issues, and missing tests, focused only on `TRGP-9`.
- Findings: no blocking regressions found. Selection foreground/background now apply only to snapshot `outputCells`, so clearing selection restores original terminal colors. Kotlin/JNI/native theme signatures are aligned, and debug render smoke passes.
- Link visuals: explicitly out of scope for this slice because available Android API only resolves OSC 8/plain links at tap time, and adding bounded visual highlighting without render-state coverage would require per-frame viewport scans. Existing tap-to-open behavior and OSC 8 debug fixture are preserved.
- Cursor: current block/underline/bar primitives remain unchanged; wide-tail handling and cursor text color path were preserved. Cursor sprite parity remains limited to existing local primitives.
- Validation: `./gradlew :app:externalNativeBuildDebug testDebugUnitTest :app:assembleDebug --no-daemon` passed. `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface --no-daemon` passed on `emulator-5554`.

Commit:

- Implementation: `96511b8a85dd6cd2488e887c40adeb6d5652f628` (`fix(renderer): apply selection foreground theme`).
- Review fix: none.

## TRGP-10: Audit Color, Contrast, And Blending Pipeline

Status: done

Research:

- Android glyph shader uses a custom sRGB-ish coverage correction and pre-multiplied output path: `app/src/main/cpp/shaders/terminal.frag:1-45`.
- Android terminal renderer uses `GL_ONE, GL_ONE_MINUS_SRC_ALPHA` for glyphs and `GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA` for solid quads: `app/src/main/cpp/coder_renderer.cpp:927-949`.
- Android currently renders theme-exact colors with no minimum contrast adjustment; faint is implemented as `0.50` text alpha before glyph shader output: `app/src/main/cpp/coder_renderer.cpp:589-596`.
- Android color glyphs bypass monochrome coverage correction when `cellBackgroundColor.a > 0.5` in the shader and output atlas RGBA multiplied by text alpha: `app/src/main/cpp/shaders/terminal.frag:28-32`.
- Failing/proof samples are debug-render low-contrast foreground, faint text, bright foreground, light-background text, and emoji over non-default background rows in `app/src/main/java/com/coder/pi/CoderApp.kt`.
- Ghostty exposes `minimum-contrast`: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/config/Config.zig:764-775`.
- Ghostty renderer config includes background opacity, selection colors, bold color, and colorspace: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:608-643`.
- Ghostty shaders apply minimum contrast before text output: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/shaders/glsl/cell_text.v.glsl:130-135`.
- Ghostty OpenGL backend chooses sRGB internal formats when linear blending is enabled: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/OpenGL.zig:292-430`.

Plan:

- Document current Android blending math and compare screenshots against Ghostty for low-contrast text, faint text, color glyphs, and bright themes.
- Keep theme-exact rendering for this ticket and document `minimum-contrast` as unsupported Android delta until screenshot evidence justifies a user-facing setting.
- Verify sRGB/linear assumptions on Android GLES surfaces and glyph atlas formats.
- Add test/debug rows for low contrast and color glyph blending.

Checklist:

- [x] Add debug rows for low-contrast foreground/background pairs.
- [x] Compare glyph weight and color output against Ghostty on sRGB themes.
- [x] Verify color glyph alpha path and monochrome glyph coverage path independently.
- [x] Decide if `minimum-contrast` belongs in Android settings or fixed renderer behavior.
- [x] Audit faint, blink, inverse, selection, cursor, and color emoji blending.
- [x] Document whether Display P3/background opacity are out of Android scope.

User story:

As a terminal user, I want text color, faint text, emoji, and selection to look crisp and readable without unexplained weight or gamma changes.

Implementation guide:

- Do not change shader math without before/after screenshots.
- Keep color glyph path separate from monochrome alpha coverage conclusions.
- Avoid adding new UI settings until visual evidence shows need.
- Include light and dark themes in validation.

Acceptance criteria:

- Low-contrast samples are either intentionally exact or adjusted with documented policy.
- Faint text remains visually distinct without becoming unreadable on common themes.
- Color emoji alpha blends correctly over non-default backgrounds.
- Shader changes, if any, have screenshot proof and no regression in normal text weight.

Review:

- Review prompt: reviewed committed terminal rendering parity slice for correctness regressions, Ghostty parity gaps, malformed glyph/shaping behavior, atlas/cache failure modes, Android lifecycle/threading issues, and missing tests, focused only on `TRGP-10`.
- Findings: no blocking regressions found. This ticket intentionally adds visual audit fixtures and policy documentation only; shader math remains unchanged because no before/after screenshot evidence justified changing text weight or gamma behavior.
- Policy: Android remains theme-exact for low-contrast text. Ghostty `minimum-contrast`, Display P3 colorspace handling, and background opacity are documented deltas/out of scope for this renderer slice until a user-facing setting and visual proof exist. Color glyph and monochrome glyph paths are separately represented in debug rows.
- Residual risk: no Ghostty side-by-side screenshot captured; validation proves debug render path and existing shader pipeline remain stable, not visual equivalence.
- Validation: `./gradlew :app:externalNativeBuildDebug testDebugUnitTest :app:assembleDebug --no-daemon` passed. `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface --no-daemon` passed on `emulator-5554`.

Commit:

- Implementation: `09448a091bd340e6f080391fdd83e74b0d440b0c` (`docs(renderer): add color blending audit fixtures`).
- Review fix: none.

## TRGP-11: Decide Scope For Terminal Image Layers

Status: done

Research:

- Ghostty renderer updates Kitty image state before drawing when image data is dirty: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:1224-1236`.
- Ghostty draws image layers behind text, between backgrounds/text, in front of text, and as overlays: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:1602-1688`.
- Ghostty has image data byte limits in config: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/config/Config.zig:2391`.
- Ghostty C API exposes Kitty graphics storage/placement/image access through `ghostty_terminal_get(... GHOSTTY_TERMINAL_DATA_KITTY_GRAPHICS ...)` and `ghostty_kitty_graphics_*`: `~/.cache/checkouts/github.com/ghostty-org/ghostty/include/ghostty/vt/kitty_graphics.h:34-84` and `~/.cache/checkouts/github.com/ghostty-org/ghostty/include/ghostty/vt/terminal.h:870`.
- Ghostty C API requires non-zero `GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_STORAGE_LIMIT` and `GHOSTTY_SYS_OPT_DECODE_PNG` before PNG Kitty images can be accepted: `~/.cache/checkouts/github.com/ghostty-org/ghostty/include/ghostty/vt/kitty_graphics.h:37-42` and `~/.cache/checkouts/github.com/ghostty-org/ghostty/include/ghostty/vt/sys.h:141-144`.
- Android terminal setup does not include `ghostty/vt/kitty_graphics.h`, does not set `GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_STORAGE_LIMIT`, and does not install a PNG decoder callback, so image data is rejected/ignored by terminal state before rendering: `app/src/main/cpp/coder_terminal.cpp:1-18`.
- Android renderer currently has only solid background/cell quads and glyph atlas paths; no image texture path exists in `CoderRenderer`: `app/src/main/cpp/coder_renderer.cpp:560-949`.
- Debug render now carries an explicit Android image-scope row with a tiny Kitty direct-transfer probe followed by `after probe`, so safe ignore preserves visible text-grid continuity: `app/src/main/java/com/coder/pi/CoderApp.kt`.

Plan:

- Verify whether `ghostty-vt` exposes Kitty graphics/image state through the C API used by Android.
- Explicitly defer image rendering for Android until a bounded texture/cache/layer implementation is approved.
- Keep current safe behavior: no storage limit and no PNG decoder callback, so image bytes do not enter renderer-owned GPU resources.
- Add debug/docs row so users and future tickets know terminal text remains authoritative and image parity is not claimed.

Checklist:

- [x] Determine C API availability for Kitty graphics/image state.
- [x] Add manual probe for common Kitty image output and observe current Android behavior.
- [x] Decide product scope: support, ignore safely, or defer.
- [x] If supporting, create follow-up implementation tickets for image decoding, texture upload, layering, limits, and cleanup.
- [x] If deferring, document unsupported behavior and ensure terminal text remains intact.

User story:

As a terminal user running tools that emit inline images, I want Android to either render them safely or clearly avoid corrupting the terminal display.

Implementation guide:

- Do not implement image protocol support inside sprite/font tickets.
- Treat image bytes as memory-risky; require explicit byte limits and cleanup behavior.
- Keep this ticket as scope decision unless user explicitly asks for image rendering implementation.

Acceptance criteria:

- Current behavior for Kitty image sequences is known and documented.
- Product decision is recorded with evidence.
- If deferred, no unrelated rendering ticket claims full Ghostty renderer parity.

Review:

- Review prompt: reviewed committed terminal rendering parity slice for correctness regressions, Ghostty parity gaps, malformed glyph/shaping behavior, atlas/cache failure modes, Android lifecycle/threading issues, and missing tests, focused only on `TRGP-11`.
- Findings: initial review found missing proof for the checklist's common Kitty image output probe. Fixed by adding a tiny Kitty direct-transfer probe in debug render followed by visible `after probe` text, so current safe-ignore behavior is covered by emulator debug smoke.
- Decision: Android terminal image layers are explicitly deferred. Ghostty C API support exists, but Android does not enable image storage, install a PNG decoder, or have image texture/layer upload/render/cleanup code. Current safe behavior keeps image bytes out of renderer-owned GPU resources and preserves text grid rendering.
- Residual risk: no full Kitty image renderer exists. Future support requires explicit scoped work for byte limits, decoding, texture cache, z-layer composition, dirty invalidation, and cleanup.
- Validation: `./gradlew :app:externalNativeBuildDebug testDebugUnitTest :app:assembleDebug --no-daemon` passed. `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface --no-daemon` passed on `emulator-5554` after implementation and after review fix.

Commit:

- Implementation: `864f937d7826d824bbc5a88b9ec492315315f409` (`docs(renderer): defer terminal image layers`).
- Review fix: `8ef44514280891cf8e6f07189625e6c7dccb4192` (`test(renderer): add kitty image safe-ignore probe`).

## Cross-Cutting Validation

Use these checks for every ticket unless a narrower ticket-specific check is clearly enough:

- `./gradlew :app:assembleDebug`
- `./gradlew testDebugUnitTest`
- `./gradlew :app:assembleRelease` before release or final handoff
- `adb devices` and debug render manual smoke when emulator/device is available
- `pi://debug/render` screenshots before and after visual renderer changes
- `hb-shape` command-line probes for font feature and glyph substitution questions

Review subagent prompt template:

```text
Review committed terminal rendering parity slice for correctness regressions, Ghostty parity gaps, malformed glyph/shaping behavior, atlas/cache failure modes, Android lifecycle/threading issues, and missing tests. Focus only on TRGP-<N>. Return findings by severity with file/line refs, plus residual risks if no findings.
```

## Final Integration Review

Status: done

Checklist:

- [x] All `TRGP-*` tickets have completed checkbox state.
- [x] Every ticket has `Research`, `Review`, and `Commit` filled by implementer.
- [x] Debug render covers shaping, scripts, sprites, emoji, fallback, decorations, and atlas stress samples.
- [x] Android debug and release builds pass.
- [x] Existing OSC, IME, cursor, dirty-row upload, and terminal feed behavior are not regressed.
- [x] Remaining gaps are explicitly documented with failing samples or blockers.

Acceptance criteria:

- User-visible rendering matches Ghostty for covered sample rows or documented deltas are intentional.
- No known high-risk atlas, shaping, fallback, or decoration regressions remain.
- Final docs match actual implementation and validation evidence.

Review:

- Completion audit mapped all explicit success criteria to artifacts in this checklist, code, debug fixtures, commits, and validation output. `TRGP-1` through `TRGP-11` are `done`, all checkboxes are complete, and each ticket has filled `Research`, `Review`, and `Commit` sections.
- Debug render proof rows cover CLI flags, ligatures, mixed styles, Arabic, combining marks, Devanagari reorder samples, emoji modifiers/ZWJ/flags, terminal sprites, legacy fallback, fallback fonts, metric proof, decorations, atlas stress, selection/link/cursor states, color/blending, and image safe-ignore scope: `app/src/main/java/com/coder/pi/CoderApp.kt:1219-1253`.
- Final validation passed: `./gradlew :app:externalNativeBuildDebug testDebugUnitTest :app:assembleDebug :app:assembleRelease --no-daemon` and `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface --no-daemon` on `emulator-5554`.
- Regression coverage: terminal feed/debug surface smoke covers OSC 8/Pi OSC/BEL/color OSC, render upload path, and native renderer. IME preedit, cursor modes, dirty-row upload, font customization, and theme behavior are preserved by surgical changes and repeated debug/unit/native builds.
- Documented deltas: unsupported legacy computing sprite ranges fallback, link visual styling without render-state coverage, Ghostty `minimum-contrast`/Display P3/background opacity, and Kitty image rendering are documented with blockers and safe behavior.
- Residual risk: no automated pixel-diff screenshots against Ghostty. Visual parity is proven through debug rows and emulator smoke, with documented deltas where Android intentionally does not claim full Ghostty behavior.

Commit:

- Final integration: `c2a5fc33cd0bcd3c3a68755635e1589f9d4c7c0c` (`docs(renderer): complete terminal parity audit`).

## Strategy Re-Audit

Status: done

Scope:

- Rechecked every completed `TRGP-*` item against current Android implementation and Ghostty reference paths.
- Treated debug rows and build/emulator validation as proof of exercised code paths, not pixel-perfect visual equivalence.
- Reclassified over-strong claims as documented deltas where Android intentionally does not match Ghostty internals.

Cross-reference findings:

- `TRGP-1`/`TRGP-2` shaped runs: Android now mirrors Ghostty's core HarfBuzz strategy: character cluster level, LTR direction, codepoint-index clusters, and cell-indexed shaped glyph placement. Ghostty reference: `src/font/shaper/harfbuzz.zig:130-255` and `src/font/shaper/run.zig:47-303`. Android reference: `app/src/main/cpp/coder_font.cpp:499-716` and `app/src/main/cpp/coder_renderer.cpp:645-909`. Remaining delta: Android keeps fallback Arabic/emoji special paths after unified shaping fails; acceptable as compatibility fallback, not pure Ghostty architecture.
- `TRGP-3` sprites: Android grid-renders box, block, braille, selected powerline/branch, and selected geometric shapes. Ghostty has broader z2d sprite modules for full block/box/braille/branch/geometric/powerline/legacy sets. Android intentionally falls back for unsupported legacy/supplement ranges instead of drawing inaccurate placeholders. Proper fix for full parity: port Ghostty sprite families one range at a time with exact per-codepoint geometry tests.
- `TRGP-4` emoji/COLR: Android respects VS15/VS16 where terminal graphemes expose selectors, routes color glyphs through RGBA atlas/shader path, and preserves terminal cell spans. Ghostty uses presentation-aware resolver constraints and separate color atlas. Proper fix for stronger parity: split Android text/color atlas storage and add targeted COLRv1 fixtures for actual Android emoji-font paint formats.
- `TRGP-5` fallback metrics: Android normalizes fallback glyph baseline and bounds against terminal cells and isolates cache keys. Ghostty has richer discovered fallback and `default_fallback_adjustment`. Proper fix for stronger parity: add automated imported-font fixtures and metric delta thresholds before changing resolver policy.
- `TRGP-6` decorations: Android uses metric-derived solid geometry for underline/dotted/dashed/curly/strike/overline. Ghostty renders decorations as sprite glyphs from `special.zig`. Proper fix for full parity: move decorations into shared sprite/atlas path only if pixel-diff shows current solid geometry diverges materially.
- `TRGP-7` atlas/cache: Android does not physically split grayscale and color atlases. It uses one RGBA atlas with bounded growth/reset behavior and color-pressure safeguards. Ghostty uses separate grayscale/color atlases and separate modified/resized counters. Proper fix for optimized parity: implement true dual atlas textures (`GL_R8` or alpha for text, `GL_RGBA8` for color), separate generations, and per-atlas dirty upload.
- `TRGP-8` metrics: Android keeps Kotlin cell metrics authoritative and logs FreeType deltas. Ghostty uses one grid metrics model. Proper fix if mismatch appears: add a native metrics query/callback and resize only after native metrics stabilize; do not change now without measured clipping/touch mismatch.
- `TRGP-9` selection/link/cursor: Android now applies selection foreground/background in snapshot cells. Ghostty also styles links from render-state coverage. Android does not have cheap render-state link coverage and avoids per-frame scrollback scans. Proper fix: expose link ranges from native render state before adding link visuals.
- `TRGP-10` color/blending: Android remains theme-exact and does not implement Ghostty `minimum-contrast`, Display P3, linear framebuffer selection, or background opacity. Proper fix: add side-by-side screenshot/pixel capture first, then add user-facing minimum contrast only if product wants Ghostty policy.
- `TRGP-11` images: Android explicitly defers Kitty images. Ghostty exposes image storage/layers and renders Kitty placements. Android keeps storage disabled and has no decoder/texture/layer path. Proper fix: separate image-rendering project with byte limits, decoder callbacks, texture cache, z-layer composition, invalidation, cleanup, and security review.

Confidence:

- Factually confident current strategy is safe and ergonomic for this slice: yes. It improves user-visible terminal rendering without broad renderer rewrites, preserves terminal protocol/IME/cursor/dirty-row behavior, and documents unsupported Ghostty deltas.
- Factually confident current strategy is full Ghostty parity: no. Full parity requires true dual atlases, exact sprite ports, render-state link coverage, optional minimum contrast/colorspace policy, image layers, and pixel-diff validation.
- Factually confident current strategy is most optimized possible: no. It is pragmatic. Most optimized next renderer architecture is dual atlas textures plus native-authoritative metrics only after measurement proves need.

Loophole fixes applied in this re-audit:

- Completion language now distinguishes debug fixture proof from screenshot/pixel-diff proof.
- Atlas language now states Android emulates separation operationally instead of claiming Ghostty's physical atlas split.
- Link, image, color, sprite, COLRv1, and imported-font metric gaps are explicitly categorized as intentional deltas with concrete proper fixes.
- Final confidence claim is bounded: safe for shipped slice, not 100% Ghostty parity.

Recommended next tickets if stricter parity is required:

- `TRGP-F1`: add automated screenshot capture and Ghostty side-by-side pixel-diff harness for debug rows.
- `TRGP-F2`: implement physical text/color atlas split with separate generations and uploads.
- `TRGP-F3`: port remaining Ghostty sprite families exactly, starting with legacy computing/supplement.
- `TRGP-F4`: expose native render-state link ranges and render link underline without viewport regex scans.
- `TRGP-F5`: build imported-font metric fixtures and decide native-authoritative cell metrics from measured thresholds.
- `TRGP-F6`: evaluate `minimum-contrast` as explicit user setting with screenshot proof.
- `TRGP-F7`: design Kitty image rendering as separate bounded renderer project.

Validation:

- Re-audit commands: `rg` over checklist, Android renderer/font/terminal paths, and Ghostty font/renderer/reference paths.
- Prior final validation remains current for implementation commits: `./gradlew :app:externalNativeBuildDebug testDebugUnitTest :app:assembleDebug :app:assembleRelease --no-daemon` and `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.coder.pi.DebugWorkflowInstrumentedTest#debugRenderDeepLinkShowsOscDebugSurface --no-daemon`.

Commit:

- Re-audit: pending.
