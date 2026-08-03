---
name: generating-orb-sheets
description: Generate, assemble, decontaminate, validate, and install resource-driven animated orb sprite sheets for Pi Live. Use when creating or replacing Pi Live orb artwork, generating keyed animation frames with GPT Image, editing orb catalog packs, or validating sprite alpha, layout, anchoring, and state tracks.
---

# Generating Orb Sheets

## Contract

- Treat the pack manifest as source of truth for `columns`, `rows`, state tracks, timing, looping, reduced-motion frames, and fallbacks.
- Generate separate frames or small batches. Do not ask GPT Image for one perfect large sheet.
- Every source uses exact flat `#FF00FF`: no texture, shadow, gradient, floor, labels, gutters, grid lines, or key color in subject.
- Final sheets use native RGBA. Runtime never chroma-keys.
- Default `alphaMode` is `hard`: alpha values must be only 0 or 255. Use `soft` only for intentional translucent effects.

## Prompt Template

```text
Create animation frame(s) for a resource-driven assistant character sprite.
Character: <visual language and invariant features>.
State/action: <state and exact pose/expression progression>.
Layout: <single frame or small ROWS×COLUMNS batch>, equal cells, row-major, no gutters or bleed.
Geometry: identical silhouette scale, bottom-center baseline, safe padding; only <listed motion> may shift by <pixels/direction>.
Background: perfectly uniform exact #FF00FF, absent from character. No scene, shadows, text, labels, grid lines, logos, watermark, or actor likeness.
Output: square raster, crisp mid-size UI sprite, complete character visible in every cell.
```

## Workflow

1. Copy `templates/miss-minutes-pack.json` or create another pack manifest. Keep frame indices unique and within its declared grid.
2. Create deterministic frame plan:
   ```bash
   uv run --with-requirements scripts/requirements.txt python scripts/orb_sheet.py init-spec \
     --pack-manifest templates/miss-minutes-pack.json --frames-dir /tmp/orb-frames \
     --state-batch-columns 4 --state-batch-rows 2 --out /tmp/orb-frames.json
   ```
3. Generate each state row as one small batch with GPT Image using the prompt contract and references. Do not fabricate missing final art locally.
4. For batch sources, set each frame entry's `sourceColumns`, `sourceRows`, and `sourceFrame`. Set `offsetX`/`offsetY` only for intentional motion; negative `offsetY` moves upward.
5. Assemble, remove chroma, normalize scale/baseline, and emit anchor metadata:
   ```bash
   uv run --with-requirements scripts/requirements.txt python scripts/orb_sheet.py assemble \
     --spec /tmp/orb-frames.json --out /tmp/miss-minutes.png --metadata-out /tmp/miss-minutes.metadata.json
   ```
6. Append pack to `macos/PiLive/Sources/PiLive/Resources/Orbs/catalog.json`, copy PNG beside it, then validate:
   ```bash
   uv run --with-requirements scripts/requirements.txt python scripts/orb_sheet.py validate \
     --input macos/PiLive/Sources/PiLive/Resources/Orbs/miss-minutes.png \
     --catalog macos/PiLive/Sources/PiLive/Resources/Orbs/catalog.json --pack-id miss-minutes \
     --metadata /tmp/miss-minutes.metadata.json
   ```
7. Preview idle, fastest talking, muted, success/failure, ending, and reduced motion at 30/82/100/132 points. Check no clipping, wobble, matte fringe, blank frame, or background rectangle.
8. Only after replacement passes validation, remove superseded packs and files from user-facing catalog/resources.

## Miss Minutes Direction

Use supplied references read-only. Preserve orange clock face, expressive eyes/lashes, black ticks, thin rubber-hose limbs, white gloves, orange shoes, and warm mid-century TVA-cartoon feel. Exclude scenes, text, Marvel/TVA logos, and actor likeness. Template uses 8×12, 256px cells, one semantic state per row, and eight frames per state.
