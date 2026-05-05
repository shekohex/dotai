# External Integrations

**Analysis Date:** 2026-05-05

## APIs & External Services

**Model routing:**

- LiteLLM gateway - runtime provider router in `src/extensions/litellm.ts` that registers `codex-openai`, `zai-coding-plan`, and `gemini` against candidate gateways `http://192.168.1.116:4000`, `http://100.100.1.116:4000`, and `https://ai-gateway.0iq.xyz`; readiness path `/health/readiness`; auth comes from upstream `AuthStorage` provider `litellm`.

**Web fetching:**

- Firecrawl - used by `webfetch` in `src/extensions/fetch/`; client `@mendable/firecrawl-js`; auth provider `firecrawl`; API URL `WEBFETCH_FIRECRAWL_API_URL` or `FIRECRAWL_API_URL`; default `http://192.168.1.121:3000/`.

**Google / Gemini:**

- Google Gemini / Code Assist - auth refresh and quota lookup in `src/extensions/openusage/providers/google-auth.ts`, `src/extensions/openusage/providers/google-api.ts`, and `src/extensions/openusage/providers/google.ts`; direct `fetch` to `cloudcode-pa.googleapis.com`, `cloudresourcemanager.googleapis.com`, and `oauth2.googleapis.com`; auth sources are `~/.gemini/oauth_creds.json`, `~/.gemini/settings.json`, or cliproxy auth-files; `src/extensions/websearch/execution.ts` uses Gemini grounded search via `googleSearch` tool configuration.

**OpenAI Codex:**

- OpenAI Codex - usage snapshot and token refresh in `src/extensions/openusage/providers/codex.ts`; direct `fetch` to `chatgpt.com/backend-api/wham/usage` and `auth.openai.com/oauth/token`; auth provider `openai-codex` or cliproxy auth-files.

**Z.ai:**

- Z.ai - usage snapshot in `src/extensions/openusage/providers/zai.ts`; direct `fetch` to `api.z.ai/api/biz/subscription/list` and `api.z.ai/api/monitor/usage/quota/limit`; auth provider `zai` or `zai-coding-plan`, or cliproxy auth-files.

**Cliproxy broker:**

- Cliproxy auth broker - `src/extensions/openusage/cliproxy.ts` and `src/extensions/openusage/cliproxy-helpers.ts` discover and download provider auth-files; env `CLIPROXYAPI_BASE_URL` / `CLIPROXY_BASE_URL` / `CLIPROXYAPI_URL` and `CLIPROXYAPI_API_KEY` / `CLIPROXY_API_KEY` / `CLIPROXYAPI_MANAGEMENT_KEY`; readiness `/v0/management/auth-files`; download `/v0/management/auth-files/download?name=...`.

**Remote tool execution:**

- MCP servers - executor connects over Streamable HTTP in `src/extensions/executor/mcp-client.ts`; client `@modelcontextprotocol/sdk`; default candidates `http://192.168.1.116:4788/mcp` and `http://100.100.1.116:4788/mcp`.

**GitHub PR flow:**

- GitHub CLI - PR checkout and auth verification in `src/extensions/review/pr-target.ts`; `gh auth login` and `gh auth status`; PR references are parsed from `https://github.com/<owner>/<repo>/pull/<n>` in `src/extensions/review/pr-reference.ts`.

**Browser CDN assets:**

- jsDelivr - interview assets load Chart.js and Mermaid from `https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js` and `https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js` in `src/extensions/interview/server-assets.ts` and `src/extensions/interview/server-runtime-support.ts`.

**Coder workspace:**

- Coder - interview server publishes a public URL from workspace env in `src/extensions/interview/public-url.ts` and `src/extensions/interview/server-runtime.ts`.
  - Env: `CODER`, `CODER_URL`, `CODER_AGENT_URL`, `CODER_WILDCARD_ACCESS_URL`, `CODER_WORKSPACE_NAME`, `CODER_WORKSPACE_OWNER_NAME`, `CODER_WORKSPACE_AGENT_NAME`

## Data Storage

**Databases:**

- Not detected.

**File Storage:**

- Local filesystem only. Key paths: `~/.pi/agent/settings.json`, `~/.pi/agent/modes.json`, `~/.pi/agent/interview-sessions.json`, `~/.pi/agent/interview-recovery/`, `~/.pi/agent/interview-snapshots/`, `~/.pi/agent/prompt-stash.jsonl`, `.pi/debug/provider-requests.jsonl`, `~/.gemini/oauth_creds.json`, and `~/.gemini/settings.json`.
- Dependency patch marker: `~/.pi/agent/state/dependency-patches/<hash>.applied` from `scripts/postinstall.mjs`.
- Temporary artifacts are written under `os.tmpdir()` in `src/extensions/fetch/execution.ts`, `src/subagent-sdk/launch.ts`, and related helpers.

**Caching:**

- In-memory only. Examples: LiteLLM state in `src/extensions/litellm.ts`, cliproxy state in `src/extensions/openusage/cliproxy.ts`, and usage snapshot caches in `src/extensions/openusage/controller.ts`.

## Authentication & Identity

**Auth Provider:**

- Upstream `AuthStorage` in `@mariozechner/pi-coding-agent` stores secrets for `litellm`, `firecrawl`, `openai-codex`, `zai`, `zai-coding-plan`, and `cliproxyapi`.
- Google auth uses `~/.gemini/oauth_creds.json` and `~/.gemini/settings.json`; `src/extensions/openusage/providers/google-auth.ts` also loads OAuth client data from installed `@google/gemini-cli-core` paths under common global package locations.
- GitHub auth is delegated to `gh auth login` in `src/extensions/review/pr-target.ts`.
- Z.ai and Codex use provider keys or cliproxy auth-files.

## Monitoring & Observability

**Error Tracking:**

- Not detected.

**Logs:**

- UI notifications and stderr output are the main feedback channels.
- Debug provider-request tracing writes `.pi/debug/provider-requests.jsonl` when `PI_DEBUG_PROVIDER_REQUESTS`, `PI_DEBUG_PROVIDER_REQUESTS_LOG`, or `PI_DEBUG_SYSTEM_PROMPT` is enabled in `src/extensions/debug-provider-request.ts`.

## CI/CD & Deployment

**Hosting:**

- npm package published through `publishConfig.registry = https://npm.pkg.github.com`.
- Runtime ships CLI wrappers in `bin/pi.js` and `bin/pi.cmd`.

**CI Pipeline:**

- Not detected.

## Environment Configuration

**Required env vars:**

- `PI_CODING_AGENT_DIR`
- `PI_SKIP_VERSION_CHECK`
- `SHEKOHEX_AGENT_SKIP_SETTINGS_INSTALL`
- `PI_DEBUG_PROVIDER_REQUESTS`
- `PI_DEBUG_SYSTEM_PROMPT`
- `PI_DEBUG_PROVIDER_REQUESTS_LOG`
- `LITELLM_API_KEY`
- `FIRECRAWL_API_KEY`
- `WEBFETCH_FIRECRAWL_API_URL` or `FIRECRAWL_API_URL`
- `CLIPROXYAPI_BASE_URL` / `CLIPROXY_BASE_URL` / `CLIPROXYAPI_URL`
- `CLIPROXYAPI_API_KEY` / `CLIPROXY_API_KEY` / `CLIPROXYAPI_MANAGEMENT_KEY`
- `CODER`
- `CODER_URL`
- `CODER_AGENT_URL`
- `CODER_WILDCARD_ACCESS_URL`

**Secrets location:**

- Secrets stay in upstream auth storage, cliproxy auth-files, and local user files, not in repo.

## Webhooks & Callbacks

**Incoming:**

- No remote webhooks detected.
- Local interview callbacks are handled by `src/extensions/interview/server-runtime.ts` over HTTP routes such as `/heartbeat`, `/cancel`, `/progress`, `/submit`, `/save`, `/generate`, and `/option-insight`.

**Outgoing:**

- None beyond the API calls listed above.

---

_Integration audit: 2026-05-05_
