# LiteLLM Codex profile

The installer copies the profile and auth helper to `~/.codex/`. Configure
LiteLLM in Pi first so `~/.pi/agent/auth.json` contains `litellm.key`, then run:

```sh
./install.sh
LITELLM_API_KEY="$(node ~/.codex/pi-agent-auth.mjs litellm)" \
  node agent/scripts/generate-codex-litellm-model-catalog.mjs
codex --profile litellm --model <model-id>
```

PowerShell catalog generation:

```powershell
./install.ps1
$env:LITELLM_API_KEY = node "$HOME/.codex/pi-agent-auth.mjs" litellm
node agent/scripts/generate-codex-litellm-model-catalog.mjs
Remove-Item Env:LITELLM_API_KEY
codex --profile litellm --model <model-id>
```

The generator requires Codex 0.154 on `PATH`, calls
`https://ai-gateway.0iq.xyz/v1/models` by default, and writes
`~/.codex/litellm-models.json`. Run with `--help` for endpoint and output
overrides.

`model_catalog_json` replaces Codex's catalog. The generator emits only models
returned by LiteLLM because every selected model is routed through that
provider. Exact bundled-model matches retain current
`codex debug models --bundled` metadata. Other exposed models use conservative
text-only metadata cloned from a bundled public model; context, reasoning, and
tool compatibility cannot be inferred from `/models` and must be supported by
the gateway model. Regenerate after either gateway availability or installed
Codex changes.

At runtime Codex invokes `node pi-agent-auth.mjs litellm` from `~/.codex` and
reads Pi auth on every request-time token refresh. Interactive shells, login
shells, desktop launches, IDE launches, and scheduled processes therefore do
not depend on `.profile` or shell startup exports. Node must remain available
on `PATH` in the launching context.
