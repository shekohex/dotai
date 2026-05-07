# External Integrations

**Analysis Date:** 2026-05-07

## APIs & External Services

**Web fetch / document scraping:**

- Firecrawl - used by `webfetch` in `src/extensions/fetch/index.ts`, `src/extensions/fetch/execution.ts`, and `src/extensions/fetch/types.ts`.
  - SDK/Client: `@mendable/firecrawl-js`
  - Auth: `FIRECRAWL_API_KEY` via `AuthStorage` provider `firecrawl`; fallback `process.env.FIRECRAWL_API_KEY`
  - Base URL: `WEBFETCH_FIRECRAWL_API_URL` or `FIRECRAWL_API_URL`; default fallback in `src/extensions/fetch/types.ts`
  - Notes: HTTP URLs are upgraded to HTTPS before scraping.

**Model usage / quota telemetry:**

- OpenAI / Codex usage endpoints - queried in `src/extensions/openusage/providers/codex.ts`.
  - Service URLs: `https://chatgpt.com/backend-api/wham/usage`, `https://auth.openai.com/oauth/token`
  - Auth: `openai-codex` auth storage key or cliproxy-auth file
  - Notes: refresh-token flow is implemented for cliproxy-backed accounts.

- Google / Gemini usage endpoints - queried in `src/extensions/openusage/providers/google-api.ts`, `src/extensions/openusage/providers/google-auth.ts`, and `src/extensions/openusage/providers/google-constants.ts`.
  - Service URLs: `https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`, `https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`, `https://cloudresourcemanager.googleapis.com/v1/projects`, `https://oauth2.googleapis.com/token`
  - Auth: `.gemini/oauth_creds.json`, `.gemini/settings.json`, optional client creds from local Gemini CLI installation, or cliproxy-auth files

- Z.ai usage endpoints - queried in `src/extensions/openusage/providers/zai.ts`.
  - Service URLs: `https://api.z.ai/api/biz/subscription/list`, `https://api.z.ai/api/monitor/usage/quota/limit`
  - Auth: provider API key via model registry or cliproxy-auth file

- LiteLLM gateway - detected in `src/extensions/litellm.ts`.
  - Candidate origins: `http://192.168.1.116:4000`, `http://100.100.1.116:4000`, `https://ai-gateway.0iq.xyz`
  - Health check: `/health/readiness`
  - Auth: `LITELLM_API_KEY` or stored `litellm` auth key
  - Notes: registers provider aliases `codex-openai`, `zai-coding-plan`, and `gemini` against the gateway.

- Cliproxy auth mirror - used by `src/extensions/openusage/cliproxy.ts` and `src/extensions/openusage/cliproxy-helpers.ts`.
  - Base URL envs: `CLIPROXYAPI_BASE_URL`, `CLIPROXY_BASE_URL`, `CLIPROXYAPI_URL`
  - API key envs: `CLIPROXYAPI_API_KEY`, `CLIPROXY_API_KEY`, `CLIPROXYAPI_MANAGEMENT_KEY`
  - Endpoints: `/v0/management/auth-files`, `/v0/management/auth-files/download`

- Google Search grounding - used by `src/extensions/websearch/execution.ts` and `src/extensions/websearch/types.ts`.
  - Client: `@mariozechner/pi-ai` model streaming
  - Auth: model-provider credentials from `ctx.modelRegistry.getApiKeyAndHeaders(model)`
  - Notes: model config injects `googleSearch` into request payload.

- GitHub CLI / GitHub PRs - used by `src/extensions/review/git.ts`, `src/extensions/review/pr-target.ts`, and `src/extensions/review/constants.ts`.
  - Commands: `gh --version`, `gh auth status`, `gh pr view`, `gh pr checkout`
  - Auth: `gh auth login`

- GitHub Packages registry - used by `scripts/install-github-package.sh` and `package.json` `publishConfig.registry`.
  - Registry: `https://npm.pkg.github.com`
  - Auth: `NODE_AUTH_TOKEN`, `NPM_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`

- Brave Search API - used by bundled GSD tooling in `src/resources/gsd/bin/lib/commands.cjs`.
  - Service URL: `https://api.search.brave.com/res/v1/web/search`
  - Auth: `BRAVE_API_KEY` or `~/.gsd/brave_api_key`
  - Notes: bundled GSD config in `src/resources/gsd/bin/lib/config.cjs` detects availability and falls back to built-in web search when absent.

- Coder workspace routing - used by `src/extensions/interview/public-url.ts` and `src/extensions/interview/server-runtime.ts`.
  - Env inputs: `CODER`, `CODER_URL`, `CODER_AGENT_URL`, `CODER_WILDCARD_ACCESS_URL`, `CODER_WORKSPACE_NAME`, `CODER_WORKSPACE_OWNER_NAME`, `CODER_WORKSPACE_AGENT_NAME`
  - Notes: builds shareable public URLs for interview sessions when running inside Coder.

**Static third-party assets:**

- Google Fonts - loaded by `src/extensions/interview/form/index.html`.
- jsDelivr CDN - used by `src/extensions/interview/server-assets.ts` and `src/extensions/interview/server-runtime-support.ts` to inject `chart.js` and `mermaid` assets when those media types are requested.

## Data Storage

**Databases:**

- Not detected.

**File Storage:**

- Local filesystem only.
- `~/.pi/agent/settings.json` and `~/.pi/agent/modes.json` - seeded by `scripts/postinstall.mjs`.
- `~/.pi/agent/prompt-stash.jsonl` - managed by `src/extensions/prompt-stash/storage.ts`.
- `~/.pi/agent/sessions/**` and tmp marker files - managed by `src/subagent-sdk/persistence.ts`.
- `~/.pi/interview-snapshots/**` and `~/.pi/interview-recovery/**` - managed by `src/extensions/interview/server-runtime.ts` and `src/extensions/interview/settings.ts`.
- `.pi/gsd.json` and `.planning/**` - managed by `src/extensions/gsd/shared.ts` and the GSD extension.
- `~/.gemini/oauth_creds.json` and `~/.gemini/settings.json` - consumed by `src/extensions/openusage/providers/google-auth.ts`.
- `~/.gsd/*.json` / `~/.gsd/*_api_key` - used by bundled GSD tooling in `src/resources/gsd/bin/lib/config.cjs` and `src/resources/gsd/bin/lib/init.cjs`.

**Caching:**

- No external cache service detected.
- In-memory caches only: `litellmStatePromise` in `src/extensions/litellm.ts`, `cliproxyStatePromise` in `src/extensions/openusage/cliproxy.ts`, `settingsCache` in `src/extensions/gsd/settings.ts`, and snapshot caches in `src/extensions/openusage/controller.ts`.

## Authentication & Identity

**Auth Provider:**

- Mixed provider model.
- `AuthStorage` from `@mariozechner/pi-coding-agent` stores credentials for `openai-codex`, `litellm`, `firecrawl`, and `cliproxyapi`.
- Google auth uses local Gemini CLI credential files plus token refresh in `src/extensions/openusage/providers/google-auth.ts`.
- GitHub PR review flows rely on `gh auth login` and `gh auth status`.

## Monitoring & Observability

**Error Tracking:**

- None detected.

**Logs:**

- `ctx.ui.notify(...)` is the primary user-facing status channel across extensions.
- `src/extensions/interview/server-assets.ts` and `src/extensions/interview/server-runtime.ts` write verbose messages to stderr when `verbose` is enabled.
- `src/extensions/debug-provider-request.ts` can write request traces to the path from `PI_DEBUG_PROVIDER_REQUESTS_LOG`.

## CI/CD & Deployment

**Hosting:**

- Local CLI package; no web app hosting target detected.
- `src/extensions/interview/server-runtime.ts` starts a local HTTP server for interview sessions and can expose a Coder public URL when the environment is available.

**CI Pipeline:**

- Not detected in repository files.
- Validation happens through npm scripts in `package.json` (`typecheck`, `lint`, `format:check`, `test`, `build`).

## Environment Configuration

**Required env vars:**

- `FIRECRAWL_API_KEY`
- `FIRECRAWL_API_URL` / `WEBFETCH_FIRECRAWL_API_URL`
- `LITELLM_API_KEY`
- `BRAVE_API_KEY`
- `EXA_API_KEY`
- `CLIPROXYAPI_BASE_URL` / `CLIPROXY_BASE_URL` / `CLIPROXYAPI_URL`
- `CLIPROXYAPI_API_KEY` / `CLIPROXY_API_KEY` / `CLIPROXYAPI_MANAGEMENT_KEY`
- `PI_CODING_AGENT_DIR`
- `CODER`, `CODER_URL`, `CODER_AGENT_URL`, `CODER_WILDCARD_ACCESS_URL`
- `PI_DEBUG_PROVIDER_REQUESTS`, `PI_DEBUG_SYSTEM_PROMPT`, `PI_DEBUG_PROVIDER_REQUESTS_LOG`

**Secrets location:**

- `AuthStorage` in `@mariozechner/pi-coding-agent` for provider tokens.
- `~/.gemini/oauth_creds.json` for Gemini credentials.
- `~/.gsd/` for bundled GSD API key files and defaults.
- `gh` credential store or GitHub token env vars for GitHub Packages and PR flows.
- No repo `.env` files detected.

## Webhooks & Callbacks

**Incoming:**

- No third-party webhooks detected.
- Local interview form callbacks are handled in `src/extensions/interview/server-runtime.ts`:
  - `POST /submit`
  - `POST /save`
  - `POST /cancel`
  - `POST /progress`
  - `POST /generate`
  - `POST /option-insight`
  - plus local status endpoints `GET /health`, `/sessions`, `/media`, `/styles.css`, `/theme-light.css`, `/theme-dark.css`, `/script.js`

**Outgoing:**

- External API calls listed above; no webhook sender integration detected.

---

_Integration audit: 2026-05-07_
