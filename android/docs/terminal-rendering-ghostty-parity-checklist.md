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

Status: review

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

- [ ] Document exact fallback priority for primary style, primary regular, bundled fallback, system emoji, system symbols, CJK, Arabic, and Droid fallback.
- [ ] Normalize fallback glyph baseline against terminal cell metrics.
- [ ] Normalize fallback advance for narrow and wide cells.
- [ ] Add fallback cache key coverage for face id, glyph id, style, presentation, and size.
- [ ] Add debug logs gated to rare first-use fallback decisions.
- [ ] Add fixtures for Nerd Font, CJK, Arabic fallback, symbols fallback, and missing glyph replacement.

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

Commit:

## TRGP-6: Render Decorations As Metric-Aware Sprites

Status: not-started

Research:

- Android encodes underline, strike, overline, underline kind, faint, and blink into `flags`: `app/src/main/cpp/coder_terminal.cpp:682-687`.
- Android draws underline styles with fixed fractions and segmented quads: `app/src/main/cpp/coder_renderer.cpp:521-550`.
- Android draws strikethrough and overline as fixed horizontal quads: `app/src/main/cpp/coder_renderer.cpp:552-553`.
- Ghostty renders underline, overline, strikethrough, and cursors through sprite glyphs using grid metrics: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:2949-3148`.
- Ghostty has config knobs for decoration position and thickness: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/config/Config.zig:435-455`.

Plan:

- Add decoration sprite primitives that use cell metrics and font size rather than hard-coded row fractions.
- Preserve current underline colors and link-style behavior if link state is later exposed.
- Ensure decorations layer underneath glyphs where appropriate and over text for strike where appropriate.
- Add fixtures for single, double, curly, dotted, dashed, colored underline, strike, overline, faint, blink, wide cells, emoji, and shaped runs.

Checklist:

- [ ] Replace single and double underline quads with metric-aware primitives.
- [ ] Replace dotted, dashed, and curly approximations with repeatable sprite geometry.
- [ ] Normalize strikethrough and overline positions to metrics.
- [ ] Ensure decorations handle wide cells and shaped glyph ownership.
- [ ] Add visual regression screenshots for all decoration styles.

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

Commit:

## TRGP-7: Split And Bound Atlas/Caching Strategy

Status: not-started

Research:

- Android uses one RGBA atlas for grayscale glyphs, color glyphs, and COLR fallback pixels: `app/src/main/cpp/coder_font.cpp:652-693`.
- Android grows the atlas up to device max and resets for recent glyphs if full: `app/src/main/cpp/coder_font.cpp:697-714`.
- Android row rendering restarts up to two times if atlas generation changes during row build: `app/src/main/cpp/coder_renderer.cpp:848-852`.
- Ghostty uses separate grayscale and color atlases: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/SharedGrid.zig:48-92`.
- Ghostty tracks atlas `modified` and `resized` counters and syncs only changed atlases: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/Atlas.zig:42-51` and `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:1572-1585`.
- Ghostty grows the specific atlas that receives `AtlasFull`: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/font/SharedGrid.zig:286-336`.

Plan:

- Split text and color glyph atlas paths or emulate the separation with explicit presentation partitions.
- Replace global reset-on-full behavior with a bounded cache policy that avoids repeated frame rebuild loops.
- Add counters for atlas glyph count, growth, reset, misses, and per-frame rebuild attempts.
- Validate with large emoji, CJK, Nerd Font, and TUI symbol workloads.

Checklist:

- [ ] Separate grayscale/text glyphs from color/emoji glyphs.
- [ ] Track atlas modified/resized generations separately.
- [ ] Add deterministic behavior for atlas full beyond max texture size.
- [ ] Avoid recursive glyph allocation loops that repeatedly rebuild rows.
- [ ] Add stress fixture that fills atlas with mixed text, CJK, emoji, symbols, and fallback glyphs.
- [ ] Add debug counters or logs for atlas growth/reset/miss rates.

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

Commit:

## TRGP-8: Align Kotlin Cell Metrics With Native FreeType Metrics

Status: not-started

Research:

- Kotlin computes `fontPixelSize` from `sp` and cell height/width from Android `Paint`: `app/src/main/java/com/coder/pi/CoderTerminalView.kt:1655-1674`.
- JNI computes terminal columns/rows from Kotlin cell dimensions and passes those same dimensions to native renderer and terminal: `app/src/main/cpp/coder_jni.cpp:118-124`.
- Native `CoderFont::setCellSize` accepts Kotlin cell dimensions and a separate font pixel size, then rebuilds FreeType faces: `app/src/main/cpp/coder_font.cpp:382-390`.
- Native baseline is recalculated from FreeType face metrics after atlas rebuild: `app/src/main/cpp/coder_font.cpp:806-819`.
- Ghostty derives grid metrics and glyph rendering constraints from one font grid model, so cell width, glyph width, baseline, sprites, and atlas render options share metrics.

Plan:

- Add native metric reporting for active FreeType primary face after `setCellSize`/font load.
- Compare Kotlin `Paint` metrics with FreeType metrics for built-in and imported fonts.
- Move toward native-authoritative cell metrics if mismatch is measurable and stable.
- Keep Kotlin fallback only for pre-render sizing before native metrics are available.

Checklist:

- [ ] Add debug metric dump comparing Kotlin cell width/height/pixel size to FreeType ascender, descender, advance, and baseline.
- [ ] Verify built-in fonts at 12, 14, 16, 18, 20, and 22sp.
- [ ] Verify imported font metrics path.
- [ ] Decide whether native should report authoritative cell metrics to Kotlin.
- [ ] Ensure terminal resize columns/rows match rendered grid with no clipped final row/column.
- [ ] Add regression samples for font-size changes, font family changes, and surface rotation/resizes.

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

Commit:

## TRGP-9: Render Selection, Links, Cursor, And Highlights With Full Theme Semantics

Status: not-started

Research:

- `CoderTheme` stores `selectionForeground`, but JNI only passes `selectionBackground`: `app/src/main/java/com/coder/pi/CoderTheme.kt:24-25` and `app/src/main/java/com/coder/pi/CoderNative.kt:12`.
- Native selection overlay only mutates selected cell background: `app/src/main/cpp/coder_terminal.cpp:753-777`.
- Android clickable hyperlinks are resolved from OSC 8 or plain URL text at tap time, but no renderer state visually marks them: `app/src/main/java/com/coder/pi/CoderTerminalView.kt:1581-1595`.
- Ghostty applies configured selection foreground/background: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:2071-2086` and `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:2808-2855`.
- Ghostty gives links an underline or double underline depending on existing underline style: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:2930-2943`.
- Android cursor drawing supports block/underline/bar modes, but cursor geometry and opacity are local primitives: `app/src/main/cpp/coder_renderer.cpp:858-900`.

Plan:

- Thread selection foreground from theme through Kotlin/JNI/native snapshot/rendering.
- Add selected-cell foreground override and verify inverse/bold/faint interactions.
- Add optional link visual state if render-state exposes OSC8 link coverage or if plain URL highlighting is cheap and bounded.
- Align cursor geometry and layering with Ghostty sprite behavior where practical.

Checklist:

- [ ] Pass `selectionForeground` through `CoderNative.nativeSetTerminalTheme` and native theme state.
- [ ] Apply selection foreground to selected cells without losing original foreground after selection clears.
- [ ] Verify inverse, faint, blink, bold, wide cells, emoji, and shaped runs under selection.
- [ ] Add visual indication for OSC 8 links if link coverage is available from Ghostty state.
- [ ] Add bounded plain URL link highlighting only if it does not require scanning full scrollback every frame.
- [ ] Align block, underline, and bar cursor geometry with cell metrics and wide-tail behavior.

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

Commit:

## TRGP-10: Audit Color, Contrast, And Blending Pipeline

Status: not-started

Research:

- Android glyph shader uses a custom sRGB-ish coverage correction and pre-multiplied output path: `app/src/main/cpp/shaders/terminal.frag:1-45`.
- Android terminal renderer uses `GL_ONE, GL_ONE_MINUS_SRC_ALPHA` for glyphs and `GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA` for solid quads: `app/src/main/cpp/coder_renderer.cpp:927-949`.
- Ghostty exposes `minimum-contrast`: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/config/Config.zig:764-775`.
- Ghostty renderer config includes background opacity, selection colors, bold color, and colorspace: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:608-643`.
- Ghostty shaders apply minimum contrast before text output: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/shaders/glsl/cell_text.v.glsl:130-135`.
- Ghostty OpenGL backend chooses sRGB internal formats when linear blending is enabled: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/OpenGL.zig:292-430`.

Plan:

- Document current Android blending math and compare screenshots against Ghostty for low-contrast text, faint text, color glyphs, and bright themes.
- Decide whether to add configurable minimum contrast or keep theme-exact rendering.
- Verify sRGB/linear assumptions on Android GLES surfaces and glyph atlas formats.
- Add test/debug rows for low contrast and color glyph blending.

Checklist:

- [ ] Add debug rows for low-contrast foreground/background pairs.
- [ ] Compare glyph weight and color output against Ghostty on sRGB themes.
- [ ] Verify color glyph alpha path and monochrome glyph coverage path independently.
- [ ] Decide if `minimum-contrast` belongs in Android settings or fixed renderer behavior.
- [ ] Audit faint, blink, inverse, selection, cursor, and color emoji blending.
- [ ] Document whether Display P3/background opacity are out of Android scope.

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

Commit:

## TRGP-11: Decide Scope For Terminal Image Layers

Status: not-started

Research:

- Ghostty renderer updates Kitty image state before drawing when image data is dirty: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:1224-1236`.
- Ghostty draws image layers behind text, between backgrounds/text, in front of text, and as overlays: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/renderer/generic.zig:1602-1688`.
- Ghostty has image data byte limits in config: `~/.cache/checkouts/github.com/ghostty-org/ghostty/src/config/Config.zig:2391`.
- Android renderer currently has only solid background/cell quads and glyph atlas paths; no image texture path exists in `CoderRenderer`.

Plan:

- Verify whether `ghostty-vt` exposes Kitty graphics/image state through the C API used by Android.
- Decide whether images are in product scope or explicitly deferred.
- If in scope, design separate bounded image texture/cache path before implementation tickets.
- If out of scope, add graceful behavior and debug docs so image escape sequences do not corrupt text rendering.

Checklist:

- [ ] Determine C API availability for Kitty graphics/image state.
- [ ] Add manual probe for common Kitty image output and observe current Android behavior.
- [ ] Decide product scope: support, ignore safely, or defer.
- [ ] If supporting, create follow-up implementation tickets for image decoding, texture upload, layering, limits, and cleanup.
- [ ] If deferring, document unsupported behavior and ensure terminal text remains intact.

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

Commit:

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

Status: not-started

Checklist:

- [ ] All `TRGP-*` tickets have completed checkbox state.
- [ ] Every ticket has `Research`, `Review`, and `Commit` filled by implementer.
- [ ] Debug render covers shaping, scripts, sprites, emoji, fallback, decorations, and atlas stress samples.
- [ ] Android debug and release builds pass.
- [ ] Existing OSC, IME, cursor, dirty-row upload, and terminal feed behavior are not regressed.
- [ ] Remaining gaps are explicitly documented with failing samples or blockers.

Acceptance criteria:

- User-visible rendering matches Ghostty for covered sample rows or documented deltas are intentional.
- No known high-risk atlas, shaping, fallback, or decoration regressions remain.
- Final docs match actual implementation and validation evidence.

Review:

Commit:
