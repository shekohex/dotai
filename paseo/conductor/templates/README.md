# Page templates

Self-contained HTML pages agents can fill in and deliver as a rich deliverable. Each file carries
its own CSS (Paseo's palette, light and dark through `prefers-color-scheme`, a system font stack)
and works on phones and wide screens.

| File              | Use it for                                                      |
| ----------------- | --------------------------------------------------------------- |
| `explainer.html`  | How something works: summary, numbered flow, SVG diagram, risks |
| `report.html`     | Audits and reviews: key numbers, verdict, findings, table       |
| `gallery.html`    | Screens and videos with filters and a full-size viewer          |
| `comparison.html` | Options side by side with pros and cons and a recommendation    |

## Use

1. Copy a template into a new folder of its own (the server serves only that folder).
2. Replace the example content; `<!-- EDIT -->` marks the spots. Keep it plain words.
3. Put images, videos, and other files next to it and link them by relative path, such as
   `assets/demo.mp4`. Remote URLs are not needed and may not load.
4. Deliver it: `op=deliver title="<what it shows>" target=<absolute path to the .html>`.

The user opens it from the dashboard. The plugin starts a temporary server on `127.0.0.1` (shared
on the tailnet with `tailscale serve` when Tailscale runs, never `funnel`). The page runs in a
sandboxed frame. The server serves the page's folder only, with these rules:

- no `..`, dotfiles, or symlinks out of the folder
- only page, style, script, data, image, video, audio, and font files
- assets up to 25 MB; video and audio up to 1 GB, with seeking

The server stops on **Close server**, after 10 idle minutes, or when the plugin unloads.

## Edit the templates

The server embeds these files, because Paseo bundles plugin code. After changing one, run
`npm run templates`; a test fails while the embedded copy is out of date. On start the plugin
writes them to `~/.paseo/conductor/templates/`, where agents copy them from.
