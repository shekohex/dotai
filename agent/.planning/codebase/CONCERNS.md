# Codebase Concerns

**Analysis Date:** 2026-05-07

## Tech Debt

**Monolithic codebase mapping orchestration:**
- Issue: `src/extensions/gsd/lifecycle/map-codebase.ts` keeps backup/restore, git reachability checks, artifact validation, detached-job orchestration, and UI messaging in one 700+ line module.
- Files: `src/extensions/gsd/lifecycle/map-codebase.ts`, `test/gsd/lifecycle.test.ts`
- Impact: changes to one path can break backup logic or overwrite canonical docs; the file is hard to reason about and expensive to modify safely.
- Fix approach: split backup/validation/stamping/reporting into separate modules and keep command wiring in `map-codebase.ts` only.

**Synchronous session metadata writes on heartbeat:**
- Issue: `src/extensions/interview/server-session-store.ts` rewrites the full sessions JSON file synchronously, and `src/extensions/interview/server-runtime.ts` touches that store on a repeating heartbeat.
- Files: `src/extensions/interview/server-session-store.ts`, `src/extensions/interview/server-runtime.ts`
- Impact: every live interview adds sync disk I/O and whole-file rewrite contention; more sessions mean more event-loop blocking.
- Fix approach: batch touches, use unique temp files, and move the store to an atomic async write path or append-only log.

## Known Bugs

**Malformed Coder public-url env can abort interview startup:**
- Issue: `src/extensions/interview/public-url.ts` constructs `new URL(...)` from `CODER_WILDCARD_ACCESS_URL`, `CODER_URL`, and `CODER_AGENT_URL` without a guard.
- Files: `src/extensions/interview/public-url.ts`, `src/extensions/interview/server-runtime.ts`
- Impact: bad environment values can crash interview server startup instead of falling back to a local URL.
- Fix approach: catch URL parse failures and fall back to the loopback base URL.

**LiteLLM probe result is cached forever:**
- Issue: `src/extensions/litellm.ts` memoizes the first LiteLLM health probe in `litellmStatePromise` and never refreshes it.
- Files: `src/extensions/litellm.ts`
- Impact: a transient startup outage leaves bundled providers offline until the process restarts; recovered gateways are never re-probed.
- Fix approach: invalidate the cache on provider failure or re-probe on a timer.

**Uploaded images and copied media overwrite by basename:**
- Issue: `src/extensions/interview/server-request.ts` and `src/extensions/interview/server-saved-html.ts` derive saved filenames from `basename(...)` only.
- Files: `src/extensions/interview/server-request.ts`, `src/extensions/interview/server-saved-html.ts`
- Impact: two inputs with the same name clobber each other, and saved snapshots can point at the wrong image or lose earlier uploads.
- Fix approach: prefix filenames with question id or a unique upload id and keep the original name only for display.

**Missing/corrupt child-session state can stay “running”:**
- Issue: `src/subagent-sdk/persistence.ts` and `src/subagent-sdk/runtime/monitoring.ts` fall back to a running status when child-session state reads fail.
- Files: `src/subagent-sdk/persistence.ts`, `src/subagent-sdk/runtime/monitoring.ts`
- Impact: dead or corrupted child sessions can remain shown as live, which keeps polling active and hides failures.
- Fix approach: distinguish “missing”, “corrupt”, and “running” and finalize inactive sessions explicitly.

## Security Considerations

**Interview session token can leak to third-party asset hosts:**
- Issue: the live interview page embeds the session token in the URL and also loads Google Fonts plus JSDelivr assets.
- Files: `src/extensions/interview/server-runtime.ts`, `src/extensions/interview/form/index.html`, `src/extensions/interview/server-assets.ts`
- Impact: Referer headers can expose the session token to external hosts; the session can be hijacked if that token is logged or replayed.
- Fix approach: self-host fonts and chart/mermaid assets, and move auth off query-string URLs.

**Saved interview HTML renders raw HTML blocks:**
- Issue: `src/extensions/interview/server-saved-html.ts` inserts `media.type === "html"` content directly into the saved snapshot HTML.
- Files: `src/extensions/interview/server-saved-html.ts`, `src/extensions/interview/schema.ts`
- Impact: opening a saved interview can execute attacker-controlled script from question content or saved media.
- Fix approach: escape HTML by default and require an explicit trusted/sandboxed render mode for raw HTML blocks.

**Media request path allowlist is prefix-based, not canonical-path based:**
- Issue: `src/extensions/interview/server-runtime-support.ts` trusts resolved path prefixes instead of checking canonical `realpath()` roots.
- Files: `src/extensions/interview/server-runtime-support.ts`
- Impact: symlinked files under an allowed root can escape to other local files and be served by the interview server.
- Fix approach: resolve canonical paths before allowlist checks and deny symlink escapes.

## Performance Bottlenecks

**Interview sessions rewrite whole JSON file on every heartbeat:**
- Files: `src/extensions/interview/server-session-store.ts`, `src/extensions/interview/server-runtime.ts`
- Problem: each active session touches the shared sessions file on a timer, and every touch rewrites the entire file synchronously.
- Cause: session bookkeeping uses `readFileSync`, `writeFileSync`, and `renameSync` in the hot path.
- Improvement path: debounce heartbeat persistence, move to async I/O, and keep writes atomic with unique temp files.

**LiteLLM startup probe is serial and blocking:**
- Files: `src/extensions/litellm.ts`
- Problem: gateway detection probes candidates one at a time with a 1s timeout each before provider registration finishes.
- Cause: the extension waits for the first healthy gateway during startup instead of probing in parallel or in the background.
- Improvement path: probe candidates concurrently and refresh health lazily after the extension is already loaded.

**GSD map command is a large synchronous orchestration path:**
- Files: `src/extensions/gsd/lifecycle/map-codebase.ts`
- Problem: long-running map operations mix sync file work and `execFileSync` checks in one command handler.
- Cause: one module owns both control flow and filesystem/git verification.
- Improvement path: move validation, backup management, and report writing into smaller helpers with narrower responsibilities.

## Fragile Areas

**Private upstream `SessionManager` API dependency:**
- Issue: `persistSessionBootstrap()` reaches into `SessionManager` with `_rewriteFile` via a local property accessor.
- Files: `src/subagent-sdk/persistence.ts`
- Impact: upstream `@mariozechner/pi-coding-agent` changes can break child-session bootstrap at runtime.
- Safe modification: keep the private API call isolated in one helper and revalidate it on every upstream bump.

**Editor command parsing assumes one-space splitting:**
- Issue: `openExternalEditor()` in `src/extensions/files/browser-actions.ts` splits `$VISUAL`/`$EDITOR` on literal spaces.
- Files: `src/extensions/files/browser-actions.ts`
- Impact: editors with quoted args or paths containing spaces launch incorrectly or lose arguments.
- Safe modification: store editor binary and args separately or parse shell-style quoting explicitly.

**Saved media filenames are not unique:**
- Issue: image copies in the interview save path are based on basename only.
- Files: `src/extensions/interview/server-request.ts`, `src/extensions/interview/server-saved-html.ts`
- Impact: duplicate names overwrite earlier files and make snapshots nondeterministic.
- Safe modification: include a question id, upload id, or content hash in the final filename.

## Scaling Limits

**Interview snapshot storage can grow without pruning:**
- Files: `src/extensions/interview/server-runtime.ts`, `src/extensions/interview/server-request.ts`
- Current capacity: every save can create a new snapshot directory plus copied images in tmp storage.
- Limit: repeated autosaves or large image payloads consume disk space quickly.
- Scaling path: add retention rules, a cleanup command, and image-size/image-count caps on save.

**Subagent temp-file contract depends on tmpdir cleanup:**
- Files: `src/subagent-sdk/persistence.ts`, `src/subagent-sdk/runtime/monitoring.ts`
- Current capacity: one marker/outcome file per session id lives under OS temp directories.
- Limit: stale markers accumulate if the process exits early or cleanup never runs.
- Scaling path: add periodic temp cleanup and a startup sweep for old session artifacts.

## Dependencies at Risk

**Remote asset providers:**
- Files: `src/extensions/interview/form/index.html`, `src/extensions/interview/server-assets.ts`
- Risk: Google Fonts and JSDelivr availability or CSP changes can break the interview UI.
- Impact: offline or locked-down environments lose fonts, charts, and mermaid rendering.
- Migration plan: vendor assets locally or make remote assets optional.

**Hardcoded LiteLLM candidates:**
- Files: `src/extensions/litellm.ts`
- Risk: the LAN/Tailscale/public gateway list is environment-specific and can drift.
- Impact: provider registration may stay offline even though a usable gateway exists elsewhere.
- Migration plan: move candidate URLs into config and surface health in settings.

**Hardcoded executor probe endpoints:**
- Files: `src/extensions/executor/settings.ts`
- Risk: default MCP URLs point at a specific local network.
- Impact: auto-start probing wastes time or misses the active endpoint outside that network.
- Migration plan: keep defaults but make every candidate overridable from runtime config.

## Missing Critical Features

**No trusted/sandboxed mode for raw HTML media blocks:**
- Files: `src/extensions/interview/server-saved-html.ts`, `src/extensions/interview/schema.ts`
- Problem: HTML media blocks can execute directly in saved snapshots.
- Blocks: safe offline viewing of externally sourced or user-authored content.

**No canonical-path guard for media symlink traversal:**
- Files: `src/extensions/interview/server-runtime-support.ts`
- Problem: the media endpoint trusts path prefixes instead of canonical roots.
- Blocks: secure serving of local media when symlinks exist under allowed directories.

## Test Coverage Gaps

- `src/extensions/interview/public-url.ts`: malformed `CODER_*` URLs are not covered; the startup crash path stays untested.
- `src/extensions/interview/server-request.ts` and `src/extensions/interview/server-saved-html.ts`: duplicate-basename upload collisions are not covered.
- `src/subagent-sdk/persistence.ts`: missing or corrupt child-session state falling back to `running` is not covered.
- `src/extensions/files/browser-actions.ts`: `$EDITOR` / `$VISUAL` commands with spaces or quoted args are not covered.

---

*Concerns audit: 2026-05-07*
