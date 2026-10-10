# bidi-fix

Direction-aware message rendering for Arabic and mixed Arabic/English chat in Paseo.

v1 is a web and desktop stopgap: a CSS stylesheet plus a `MutationObserver` that tags message blocks with `dir`. Native (iOS/Android) is a no-op.

## Why a DOM patch

Paseo renders Markdown with `react-native-markdown-display`. Each paragraph is an RN `View` with `flexDirection: "row"` and no direction handling. Timeline transformers may only return `type: "plugin"` items and the plugin SDK does not export the Markdown renderer, so a plugin cannot replace the paragraph rule. The DOM is the only seam.

## Layout

```
index.client.tsx     calls installBidiFix() and returns its cleanup
client/web.ts        the only module that touches DOM globals; gated on Platform.OS === "web"
shared/direction.ts  pure detectDirection(text); unit tested
```

## Direction rule

`detectDirection(text)` ignores fenced and inline code, then:

1. first strong letter is Arabic (U+0600–06FF, 0750–077F, 08A0–08FF, FB50–FDFF, FE70–FEFF) → `rtl`
2. else Arabic words outnumber Latin words → `rtl`
3. else `ltr` (empty and punctuation-only text included)

Rule 2 counts whitespace-separated words, not letters. Letter counts misclassify the spec sample `useEffect بيعمل re-render لما الـ deps تتغير` (21 Latin letters vs 16 Arabic, but 4 Arabic words vs 3 Latin). A token with any Arabic letter counts as Arabic. Arabic digits and punctuation are not strong.

## DOM shape observed (Paseo 0.11.2, web)

Observed on the live app with the plugin disabled. Classes are hashed and unstable; only the attributes below are used.

```html
<div data-testid="assistant-message" data-message-text="true">
  <div data-paseo-markdown-tag="h2">
    <div dir="auto">
      <span data-paseo-markdown-tag="code">useEffect</span
      ><span> في React</span>
    </div>
  </div>
  <div data-paseo-markdown-tag="p">
    <div dir="auto">
      <span>الـ </span><span data-paseo-markdown-tag="code">setup</span
      ><span> ممكن يرجّع function</span>
    </div>
  </div>
  <div data-paseo-markdown-tag="li">
    <div
      dir="auto"
      data-paseo-markdown-ignore="true"
      data-paseo-markdown-list-marker="true"
    >
      1.
    </div>
    <div>
      <div dir="auto"><span>قبل ما الـ effect يتشغّل تاني</span></div>
    </div>
  </div>
  <div data-paseo-markdown-tag="pre">…</div>
</div>

<div data-testid="user-message">
  …
  <div dir="auto" data-message-text="true">
    اشرحلي بالعربي المصري إزاي useEffect …
  </div>
</div>
```

Anchors (all come from Paseo's `dataSet`/`testID` props, which RN-web emits as `data-*`):

| Anchor                                                | Used for                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `[data-testid="assistant-message"]`, `"user-message"` | Message roots. Nothing outside them is touched.                                                                                                                    |
| `[data-paseo-markdown-tag="p" \| "li" \| "h1".."h6"]` | Blocks that get `dir` and `data-bidi`                                                                                                                              |
| `[data-message-text]` inside `user-message`           | The user's text block                                                                                                                                              |
| `[dir="auto"]` inside a block                         | Text roots RN-web created. `dir="auto"` is overridden with the block direction, because `dir="auto"` re-detects per element and would keep a Latin-first chunk LTR |
| `[data-paseo-markdown-tag="code" \| "pre"]`           | Forced `dir="ltr"`, excluded from direction detection                                                                                                              |
| `[data-paseo-markdown-list-marker]`                   | Kept `ltr` so `1.` does not render as `.1`; margin flipped                                                                                                         |
| `[data-paseo-markdown-ignore]`, nested `ul`/`ol`      | Excluded from a block's text                                                                                                                                       |

The composer (`[data-composer-input]`, `textarea`, `contenteditable`) and terminals (`.xterm`) are rejected before any lookup. Diffs and editors are never inside a message root, so they are not reached.

## Behavior

- One `<style id="paseo-bidi-fix">`: `unicode-bidi: plaintext; text-align: start` on text roots (fallback before tagging), `unicode-bidi: isolate` once tagged, `direction: ltr; unicode-bidi: isolate; text-align: left` on code.
- `MutationObserver` on `document.body` (`childList`, `subtree`, `characterData`). Mutations are mapped to their message root with `closest()`, roots are batched in a `Set` and processed once per `requestAnimationFrame`. Streaming text re-tags within a frame.
- Tagging is idempotent: attributes are only written when the value changes, and the original `dir` is remembered per element.
- `flex-direction` is **not** changed. `dir="rtl"` already reverses a `row` flex container, so the spec's `row-reverse` would flip it back to LTR. `justify-content: flex-start` then means the right edge.
- Cleanup disconnects the observer, cancels the pending frame, restores each tagged element's original `dir` (`auto`), removes `data-bidi`, and removes the style element.

## Native

No-op in v1. `installBidiFix()` returns an empty cleanup when `Platform.OS !== "web"`. Fixing iOS/Android needs a change in Paseo's Markdown paragraph rule or an SDK seam for custom Markdown rules.

## Known limitations

- Depends on Paseo's `data-paseo-markdown-*` attributes and `data-testid` values; a renderer refactor can break it silently.
- Tables, blockquotes, and tool-call output are not re-aligned.
- A streaming block that starts Latin and turns out Arabic-majority flips direction mid-stream.
- Physical margins on list content and blockquote borders are not mirrored (only the list marker margin is).
- Direction is per block; a single paragraph with a hard line break is treated as one block.

## Development

```
npm install
npm run typecheck
npm run lint
npm run test
npm run format
```

Install with `paseo plugin install <path>`, reload with `paseo plugin reload bidi-fix`.
