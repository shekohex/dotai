# LiteLLM Codex profile

The installer copies the profile and auth helper to `~/.codex/`. Configure
LiteLLM in Pi first so `~/.pi/agent/auth.json` contains `litellm.key`, then run:

```sh
./install.sh
codex --profile litellm --model <model-id>
```

Refresh the installed catalog when gateway availability changes:

```sh
LITELLM_API_KEY="$(node ~/.codex/pi-agent-auth.mjs litellm)" \
  node agent/scripts/generate-codex-litellm-model-catalog.mjs
```

PowerShell refresh:

```powershell
$env:LITELLM_API_KEY = node "$HOME/.codex/pi-agent-auth.mjs" litellm
node agent/scripts/generate-codex-litellm-model-catalog.mjs
Remove-Item Env:LITELLM_API_KEY
```

The generator requires Codex 0.154 on `PATH`, calls
`https://ai-gateway.0iq.xyz/v1/models` and `https://models.dev/api.json`, then
writes `~/.codex/litellm-models.json`. Run with `--help` for endpoint and output
overrides. The installer includes the repository's generated catalog, so manual
generation is needed only to refresh gateway availability, models.dev metadata,
or installed Codex metadata.

Generation is deterministic for the same exposed model ids, models.dev data,
and Codex runtime. Model ids and object keys use UTF-8 bytewise ordering; JSON
uses two-space indentation and one final newline. Source ordering, gateway
`created`, and gateway `owned_by` do not affect output.

`model_catalog_json` replaces Codex's catalog. The generator emits only models
returned by LiteLLM after filtering because every selected model is routed
through that provider. Exact bundled-model matches copy the complete installed
`codex debug models --bundled` `ModelInfo`.
Unknown-model instructions are captured from the installed Codex harness by
sending an unknown model to a temporary loopback Responses endpoint. The
generator neither stores nor invents a fallback prompt. Its report states how
many entries use each instruction source. Regenerate after Codex updates so the
catalog follows that installed runtime.

An exact canonical models.dev record must declare text input, text output, and
`tool_call=true` to prove agent capability. `name` becomes `display_name`.
Supported text/image inputs, context limits, and effort-valued reasoning options
become Codex fields. When an id has records from multiple providers, each field
is accepted independently only when every normalized candidate agrees; a
conflict is reported and keeps the conservative fallback for that field.

Reasoning efforts use Codex 0.154's named schema order:
`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, and
`persistent`. The generator reads descriptions from the installed bundled
catalog, preferring the bundled model with the broadest described effort set.
When a named effort has no installed description, its required description is
empty and the report counts it. The generator ignores custom effort strings
and does not infer levels from
`reasoning=true`, toggle options, or token-budget options. It also does not
invent an external model's default reasoning level; only exact bundled matches
retain an installed default. Regenerate after a Codex update so effort metadata
and descriptions follow the installed catalog.

PDF and video inputs, output limits, attachment, family, structured-output, and
other metadata without Codex 0.154 equivalents are ignored. Provider-ambiguous
and unmatched ids are retained unless their id unambiguously identifies an
embedding, reranker, transcription/ASR, speech/TTS, image-generation/editing,
or video-generation model. Multiple exact models.dev records are also excluded
when every record has complete capability metadata and none satisfies the three
agent requirements. Generation reports name and reasoning coverage, ambiguity,
missing evidence, retained match counts, and exclusions by reason; plausible
coding models are not dropped only because metadata is missing or ambiguous.

Codex first loads `~/.codex/config.toml`, then overlays only keys present in
`~/.codex/litellm.config.toml`. The profile overrides provider and catalog only,
so unrelated base defaults remain inherited. `model_catalog_json` therefore
selects and replaces the model catalog only while this profile is active. CLI
and project configuration layers have higher precedence than the profile.

At runtime Codex invokes `node pi-agent-auth.mjs litellm` from `~/.codex` and
reads Pi auth on every request-time token refresh. Interactive shells, login
shells, desktop launches, IDE launches, and scheduled processes therefore do
not depend on `.profile` or shell startup exports. Node must remain available
on `PATH` in the launching context.
