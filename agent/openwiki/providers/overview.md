# Providers & models

How the wrapper resolves which model/provider serves a request. This sits on top of upstream pi-ai's builtin providers and adds a gateway selector, synthesized providers, fallback chains, a usage tracker, and an OpenAI fast/image extension.

The default model is `openai-codex` / `gpt-5.5` (`src/default-settings.ts`), but at runtime the **active mode** (`src/default-modes.ts`) usually decides the provider+model — e.g. `build` → `codex-openai/gpt-5.6-terra`, `cheap-review` → `zai/glm-5.2`, `rush` → `opencode-go/deepseek-v4-flash`. See [Architecture → Mode system](../architecture/overview.md#mode-system).

An explicit `--model` takes precedence over the active mode's primary model for the current Pi process. It keeps the mode's thinking level, tools, system prompt, and fallback chain, and is not persisted as a mode-model override. `--provider` participates only when paired with `--model`, per upstream Pi CLI parsing.

## LiteLLM gateway selection

`src/extensions/litellm.ts` discovers a local/team OpenAI-compatible proxy (LiteLLM) and, when one is healthy, **re-registers providers to route through it** instead of their native endpoints.

- **Candidate priority** (first healthy wins): `lan` (`192.168.1.116:4000`) → `tail` (`100.100.1.116:4000`) → `public` (`ai-gateway.0iq.xyz`). Probed via `GET /health/readiness` with a 1s timeout; the result is cached.
- When a gateway is alive it registers, through the gateway:
  - `codex-openai` — `openai-responses` API, models copied from `getBuiltinModels("openai-codex")` (with `gpt-5.6-luna`/`sol`/`terra` overridden to a 372k context window), key from `AuthStorage("litellm")` or `$LITELLM_API_KEY`.
  - `zai-coding-plan`, `deepseek` — proxied through the gateway, litellm key.
  - `gemini` — proxied to `<gateway>/v1beta` via `google-generative-ai` (only when the winning candidate has an `origin`).
- `zai` is **never proxied** — it always uses its native `https://api.z.ai/api/coding/paas/v4` URL with `$ZAI_API_KEY`.
- `opencode-go` is **never touched** by this extension — it always uses the upstream builtin with `$OPENCODE_API_KEY`.

If no gateway is healthy, this extension registers nothing and upstream builtins serve everything directly.

## Provider roster

| Name used in modes | Registered by                   | Upstream pi-ai id                      | Auth / env                             |
| ------------------ | ------------------------------- | -------------------------------------- | -------------------------------------- |
| `codex-openai`     | litellm (proxy when gateway up) | `openai-codex` (builtin models copied) | litellm key / `$LITELLM_API_KEY`       |
| `opencode-go`      | upstream builtin                | `opencode-go`                          | `$OPENCODE_API_KEY` (not via `/login`) |
| `zai`              | litellm (native URL) or builtin | `zai`                                  | `$ZAI_API_KEY`                         |
| `zai-coding-plan`  | litellm only (synthesized)      | —                                      | litellm key                            |
| `deepseek`         | litellm (proxy) or builtin      | `deepseek`                             | litellm key, or `$DEEPSEEK_API_KEY`    |
| `gemini`           | litellm (proxy) or builtin      | `google`                               | google credentials                     |

> `zai-coding-plan` exists **only** when the gateway is up — it has no builtin registration, so the default-modes fallback chains (which include it) only resolve end-to-end when a gateway is reachable. `zai` itself still works natively without a gateway.

## Model fallbacks

`src/extensions/model-fallbacks.ts` defines a global chain used by background tasks (not the main chat model) that need _some_ working model for cheap auxiliary calls:

```
codex-openai/gpt-5.4-mini → zai/glm-5.2 → zai-coding-plan/glm-5.2
→ opencode-go/deepseek-v4-flash → deepseek/deepseek-v4-flash
→ gemini/gemini-3.1-flash-lite-preview → gemini/gemini-3.1-pro-preview
→ gemini/gemini-2.5-pro
```

- `resolveModelFallbackAuth()` walks the chain, calling `modelRegistry.find(provider, model)` then `getApiKeyAndHeaders()`; the first candidate that authenticates wins (failures are warned and skipped).
- `appendCurrentModelFallback()` appends the current session model (deduped).
- `modelForOpenAIResponses()` adapts Gemini models to an `openai-responses` API wrapper with a cleaned `/v1` URL.
- **Consumers:** `branch-summary`, `compaction`, `session-query/execution`, `coreui/ai-autocomplete-backend`, `context-prune/summarizer`, `interview`.

These fallbacks are independent from a mode's own `fallbacks` list (which drives interactive failover handled by the `modes` extension).

## Mode failover (interactive)

The `modes` extension applies the active mode's model and, on provider errors, walks the mode's own `fallbacks` list (`src/extensions/modes/failover.ts`, `model-failure.ts`, `model-health-store.ts`). Health is persisted so a known-bad provider is skipped for a while. On resume, `restore.ts` re-applies the mode.

## openai-better: fast mode + image generation

`src/extensions/openai-better/` adds two opt-in features:

- **`/fast`** — injects `service_tier: "priority"` into the request payload on `before_provider_request`, only for supported Codex models (`gpt-5.4`, `gpt-5.5`, `gpt-5.4-mini` and their `openai-codex/` aliases). Toggle persisted at `settings.json#openaiBetter.fast.enabled`; auto-enables on `model_select` to a supported model.
- **`/imagen` + `image_generation` tool** — image generation routed **exclusively through the LiteLLM gateway** (depends on `litellm.ts` for credentials/base URL). Supports action (auto/diffusion/edit), output format (png/jpeg/webp), and save modes (none/project/global/custom), with base64 image rendering.

Settings shape (`openaiBetter`): `{ fast: { persistState, enabled, supportedModels[] }, image: { enabled, defaultModel, defaultSave, outputFormat, timeoutMs } }`.

## openusage: live usage tracking

`src/extensions/openusage/` polls provider usage/rate-limit APIs and shows bars/alerts in the TUI.

- `controller.ts` hooks `session_start`, `model_select`, `modes:changed`, `agent_end` to refresh; `model-map.ts` maps the current provider to a usage provider (`codex-openai`/`openai-codex` → `codex`, `google*` → `google`, `zai*` → `zai`).
- Per-provider fetchers in `providers/`:
  - `codex.ts` — `chatgpt.com/backend-api/wham/usage` with OAuth token rotation + cliproxy fallback; reads `x-codex-*-used-percent` headers or `rate_limit` body.
  - `zai.ts` — `api.z.ai/api/monitor/usage/quota/limit` + subscription list; token-window limits.
  - `google.ts` — multi-step: ID token → `loadCodeAssist` (tier) → GCP project discovery → quota fetch.
- Snapshots are cached and in-flight requests deduped; auth falls back to the cliproxy account store.

## pi-ai-models (shared, not registered standalone)

`src/extensions/pi-ai-models.ts` is the bridge to upstream pi-ai:

- Registers builtin pi-ai providers into pi's model registry.
- `AuthStorageCredentialStore` adapts pi `AuthStorage` ↔ pi-ai `CredentialStore`.
- `registerPiAiProvider()` is what `litellm.ts` uses to inject overridden providers.
- `modelsForRequest()` prefers `requestProviders` (overrides like the litellm registrations) over builtins, creating an ad-hoc `createRequestProvider()` on first use for single-model providers.
- Exposes `streamModel()` / `completeModel()` / `completeSimpleModel()` wrappers that dynamically resolve the correct provider API (anthropic, openai-completions, openai-responses, google-generative-ai, …).

## Auth & environment variables

| Var                                                                                    | Used by                              |
| -------------------------------------------------------------------------------------- | ------------------------------------ |
| `$LITELLM_API_KEY` (or `AuthStorage("litellm")`)                                       | litellm-proxied providers + `imagen` |
| `$ZAI_API_KEY`                                                                         | `zai` (native) + `zai` usage fetch   |
| `$OPENCODE_API_KEY`                                                                    | `opencode-go` (upstream builtin)     |
| `$DEEPSEEK_API_KEY`                                                                    | `deepseek` when no gateway           |
| `$NODE_AUTH_TOKEN` / `$NPM_TOKEN` / `$GH_TOKEN` / `$GITHUB_TOKEN` (or `gh auth token`) | `pi update` GitHub Packages auth     |

`openai-better.fast.supportedModels`, `aiAutocomplete.*`, `contextPrune.*`, `dynamic_workflows.*`, `sessionQuery.*`, `sessionArchive.*`, `interview.*`, and `openaiBetter.*` are all settings keys read from `~/.pi/agent/settings.json` (or project `.pi/settings.json`).
