# GSD Debug Knowledge Base

Resolved debug sessions. Used by `gsd-debugger` to surface known-pattern hypotheses at the start of new investigations.

---

## gsd-command-parser-unstable-suggestions — `/gsd` autocomplete crashed on debug session frontmatter

- **Date:** 2026-05-06
- **Error patterns:** unstable suggestions, command suggestions, fuzzy search, /gsd debug, Invalid frontmatter, must not have additional properties, slug, goal
- **Root cause:** `DebugSessionFrontmatterSchema` is stricter than actual debug session file frontmatter and crashes `/gsd` autocomplete when session files include `slug` and `goal`.
- **Fix:** Added optional `slug` and `goal` fields to `DebugSessionFrontmatterSchema` so `/gsd` debug session parsing accepts actual session frontmatter.
- **Files changed:** src/extensions/gsd/autocomplete.ts, src/extensions/gsd/state/debug.ts, test/gsd/commands.test.ts

---
