# Codebase Concerns

**Analysis Date:** 2026-05-05

## Tech Debt

**Upstream runtime monkey patches:**

- Issue: `src/extensions/bundled-resources.ts`, `src/extensions/model-family-system-prompt.ts`, `src/extensions/inline-extension-names.ts`, and `src/extensions/mermaid/patch.ts` patch upstream prototypes and private fields at load time.
- Files: `src/extensions/bundled-resources.ts`, `src/extensions/model-family-system-prompt.ts`, `src/extensions/inline-extension-names.ts`, `src/extensions/mermaid/patch.ts`
- Impact: Any upstream rename or shape change in `@mariozechner/pi-coding-agent` can break bundled resource discovery, system-prompt rewriting, inline extension naming, or Mermaid rendering for every session.
- Fix approach: Keep all upstream touch points in one adapter layer, add upgrade smoke tests against the exact dependency version, and revalidate patches on every upstream bump.

**Hardcoded runtime endpoints:**

- Issue: `src/extensions/litellm.ts` and `src/extensions/executor/settings.ts` ship with baked-in LAN, tailnet, and public candidate URLs.
- Files: `src/extensions/litellm.ts`, `src/extensions/executor/settings.ts`
- Impact: Infra rotation or a new machine layout breaks auto-discovery until the code or test override changes.
- Fix approach: Move candidates into config or environment-driven settings and keep a refresh path so runtime recovery does not require restart.

**Session registry file churn:**

- Issue: `touchSession()` in `src/extensions/interview/server-session-store.ts` reads and rewrites the full session registry file, and `listSessions()` rewrites again after pruning.
- Files: `src/extensions/interview/server-session-store.ts`, `src/extensions/interview/server-runtime-support.ts`
- Impact: Frequent heartbeats create synchronous disk churn and race windows. Concurrent processes can overwrite each other’s session updates.
- Fix approach: Use file locking, append-only persistence, or a small embedded database for session state.

**Silent recovery paths:**

- Issue: `src/subagent-sdk/persistence.ts`, `src/extensions/openusage/controller.ts`, and `src/extensions/gsd/lifecycle/map-codebase.ts` often swallow IO or refresh failures and fall back to empty/default state.
- Files: `src/subagent-sdk/persistence.ts`, `src/extensions/openusage/controller.ts`, `src/extensions/gsd/lifecycle/map-codebase.ts`
- Impact: Corruption, partial writes, and background refresh failures become invisible. Users see stale or empty state instead of a diagnosable error.
- Fix approach: Keep resilient fallbacks only at UI boundaries, and surface repairable failures with enough context to trace the source file or provider.

## Known Bugs

**Snapshot media filename collisions:**

- Symptoms: Upload and export paths derive filenames from `basename()` in `handleImageUpload()` and `copyMediaImages()`. Two different source files with the same basename overwrite each other in the session temp dir and the exported `images/` directory.
- Files: `src/extensions/interview/server-request.ts`, `src/extensions/interview/server-saved-html.ts`
- Trigger: Multiple uploaded images or source media files sharing a name like `image.png`.
- Workaround: Not detected.
- Fix approach: Generate unique names from session id, question id, and a content hash, then rewrite references to those names.

**Corrupt saved answers disappear on load:**

- Symptoms: `normalizeResponseItems()` in `src/extensions/interview/questions.ts` drops any saved response entry without a string `id` or valid `value`, and `loadSavedInterview()` loads the snapshot without reporting which entries were lost.
- Files: `src/extensions/interview/questions.ts`
- Trigger: Corrupted or hand-edited saved interview HTML with malformed `savedAnswers` entries.
- Workaround: None.
- Fix approach: Surface validation errors or retain invalid entries in a repair report instead of silently discarding them.

**LiteLLM discovery can stay pinned offline:**

- Symptoms: `resolveLiteLLMState()` stores the first probe result in `litellmStatePromise` and never invalidates it.
- Files: `src/extensions/litellm.ts`
- Trigger: Transient gateway outage or network blip during startup.
- Workaround: Restart process.
- Fix approach: Add a TTL, explicit refresh, or retry path before provider registration.

## Security Considerations

**Unescaped HTML in saved snapshots:**

- Risk: `renderMediaBlockHtml()` inserts `media.html` directly into exported snapshot HTML when `media.type === "html"`.
- Files: `src/extensions/interview/server-saved-html.ts`
- Current mitigation: Other fields are escaped, and `safeInlineJSON()` protects embedded JSON payloads.
- Recommendations: Sanitize HTML before writing snapshots or render HTML media inside a sandboxed iframe or separate origin.

**Media path trust boundary is broad:**

- Risk: `handleMediaRequest()` accepts any path under `cwd`, `homedir()`, or `tmpdir()`, and uses `resolve()` instead of canonical path checks.
- Files: `src/extensions/interview/server-runtime-support.ts`, `src/extensions/interview/server-saved-html.ts`
- Current mitigation: Prefix allowlist only.
- Recommendations: Canonicalize with `realpathSync()`, narrow allowed roots to per-session assets, and reject symlink escapes. The same trust model appears in `copyMediaImages()`.

**Remote CDN scripts execute in live interview origin:**

- Risk: `buildCdnScripts()` injects Chart.js and Mermaid from jsDelivr into the live interview page when those media types are present.
- Files: `src/extensions/interview/server-assets.ts`, `src/extensions/interview/server-runtime-support.ts`
- Current mitigation: None beyond HTTPS transport.
- Recommendations: Bundle assets locally or gate remote loading behind an explicit trusted-CDN toggle. Those scripts run with access to same-origin session state and form data.

## Performance Bottlenecks

**Whole-file session persistence:**

- Problem: Every heartbeat calls `touchSession()`, which reloads and rewrites the full session registry. Prune logic also rewrites the file.
- Files: `src/extensions/interview/server-session-store.ts`, `src/extensions/interview/server-runtime-support.ts`
- Cause: Synchronous read-modify-write on a single JSON file.
- Improvement path: Move to append-only storage, sqlite, or locked atomic updates.

**Snapshot generation copies everything on save:**

- Problem: Save flow rebuilds the full saved HTML, rewrites media references, and copies media assets on every save request.
- Files: `src/extensions/interview/server-runtime.ts`, `src/extensions/interview/server-saved-html.ts`
- Cause: Per-save traversal of the whole question tree and attachment set.
- Improvement path: Reuse stable asset paths or dedupe copied files by content hash.

## Fragile Areas

**Prototype patching of upstream classes:**

- Files: `src/extensions/bundled-resources.ts`, `src/extensions/model-family-system-prompt.ts`, `src/extensions/inline-extension-names.ts`, `src/extensions/mermaid/patch.ts`
- Why fragile: Behavior depends on upstream method names, private fields, and render semantics. A dependency upgrade can turn a load-time patch into a startup failure or a silent UI regression.
- Safe modification: Keep compatibility code isolated, pin the upstream package version, and gate upgrades with smoke tests that exercise the patched paths.

**Module-scoped executor state and inspection cache:**

- Files: `src/extensions/executor/status.ts`, `src/extensions/executor/tools-descriptions.ts`
- Why fragile: Executor status and inspection data are cached by cwd and MCP URL, so stale state persists until explicit cleanup. Tool descriptions can also remain stale after a server restart with the same URL.
- Safe modification: Clear caches on shutdown and settings changes, and test crash/restart flows.
- Test coverage: Restart-after-shutdown is covered in `test/executor.test.ts`; crash cleanup, stale cache invalidation, and post-restart description refresh are not.

**Hardcoded gateway discovery:**

- Files: `src/extensions/litellm.ts`, `src/extensions/executor/settings.ts`
- Why fragile: The discovery order is tied to concrete LAN, tailnet, and public endpoints. Environment changes require code changes or explicit test overrides.
- Safe modification: Move candidate discovery into config or env-driven settings and test startup against missing or rotated endpoints.

## Scaling Limits

**Single-process local server assumptions:**

- Current capacity: Designed around one local user/session per runtime directory.
- Files: `src/extensions/interview/server-runtime.ts`, `src/extensions/interview/server-session-store.ts`
- Limit: Concurrent interviews from multiple processes contend on the same session, recovery, and snapshot directories.
- Scaling path: Isolate runtime directories per session or move registry state into a process-safe store.

## Dependencies at Risk

**Patched upstream package:**

- Risk: `patches/@mariozechner+pi-coding-agent+0.72.1.patch` changes vendored behavior and types in `@mariozechner/pi-coding-agent`.
- Files: `patches/@mariozechner+pi-coding-agent+0.72.1.patch`
- Impact: Dependency upgrades can invalidate the patch or reintroduce renderer and spacing regressions.
- Migration plan: Rebase the patch on every upstream bump and keep a smoke test around the touched render and session-selector paths.

**External CDN assets:**

- Risk: `src/extensions/interview/server-assets.ts` and `src/extensions/interview/server-runtime-support.ts` inject Chart.js and Mermaid from jsDelivr when those media types are present.
- Files: `src/extensions/interview/server-assets.ts`, `src/extensions/interview/server-runtime-support.ts`
- Impact: Offline or filtered-network environments lose those rendered assets, and CDN compromise becomes a same-origin script execution risk.
- Migration plan: Bundle assets locally or add an offline fallback.

**LiteLLM gateway endpoints:**

- Risk: `src/extensions/litellm.ts` hardcodes LAN, tailnet, and public gateway URLs.
- Files: `src/extensions/litellm.ts`
- Impact: Gateway rotation, private network changes, or provider relocation break auto-discovery without a code update.
- Migration plan: Source gateway candidates from config or environment and add retry/refresh behavior.

**Executor MCP endpoints:**

- Risk: `src/extensions/executor/settings.ts` hardcodes executor probe URLs for a specific LAN and tailnet topology.
- Files: `src/extensions/executor/settings.ts`, `src/extensions/executor/connection.ts`
- Impact: Any network readdressing breaks executor startup and tool registration until settings are overridden.
- Migration plan: Move probe URLs into configuration and surface a clearer fallback path when no candidate resolves.

## Missing Critical Features

- Not detected.

## Test Coverage Gaps

**Session-store behavior under contention:**

- What’s not tested: Concurrent `registerSession()`, `touchSession()`, and `unregisterSession()` behavior, plus recovery after a partial write.
- Files: `src/extensions/interview/server-session-store.ts`
- Risk: Lost sessions or stale `/sessions` results.
- Priority: High

**Saved HTML security and asset collisions:**

- What’s not tested: Raw HTML rendering in `media.type === "html"`, duplicate basenames in uploaded or exported media, and symlink escapes through `/media` or export copying.
- Files: `src/extensions/interview/server-saved-html.ts`, `src/extensions/interview/server-runtime-support.ts`, `src/extensions/interview/server-request.ts`
- Risk: XSS in exported snapshots and incorrect or leaked assets.
- Priority: High

**LiteLLM cache invalidation:**

- What’s not tested: Retry after a transient startup outage, refresh after gateway recovery, or endpoint rotation after `resolveLiteLLMState()` caches a failure.
- Files: `src/extensions/litellm.ts`
- Risk: Providers stay offline until restart.
- Priority: Medium

**Patch compatibility with upstream internals:**

- What’s not tested: Behavior after upstream method or field shape changes in patched runtime classes.
- Files: `src/extensions/bundled-resources.ts`, `src/extensions/model-family-system-prompt.ts`, `src/extensions/mermaid/patch.ts`
- Risk: Startup failure or silent prompt/render regressions after dependency upgrades.
- Priority: Medium

**Executor endpoint drift:**

- What’s not tested: Default LAN/tailnet candidate failure, settings override behavior, or stale tool-description refresh after the MCP server restarts on the same URL.
- Files: `src/extensions/executor/settings.ts`, `src/extensions/executor/tools-descriptions.ts`, `src/extensions/executor/status.ts`
- Risk: Executor appears broken or stale despite a healthy backend.
- Priority: Medium

---

_Concerns audit: 2026-05-05_
