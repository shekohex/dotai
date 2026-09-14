# OpenCode Go profile

The installer copies the profile and shared auth helper to `~/.codex/`.
Configure OpenCode Go in Pi first so `~/.pi/agent/auth.json` contains
`.["opencode-go"].key`, then run:

```sh
./install.sh
codex --profile opencode-go --model <model-id>
```

The profile overrides only provider routing, catalog, and authentication. Approval,
sandbox, personality, reasoning, feature, and other defaults continue to come
from `~/.codex/config.toml`.

PowerShell:

```powershell
./install.ps1
codex --profile opencode-go --model <model-id>
```

At runtime Codex invokes `node pi-agent-auth.mjs opencode-go` from `~/.codex`
and reads Pi auth on every request-time token refresh. Interactive shells,
login shells, desktop launches, IDE launches, and scheduled processes therefore
do not depend on `.profile` or shell startup exports. Node must remain available
on `PATH` in the launching context.

The checked-in catalog is generated from the authenticated OpenCode Go model
list at `GET https://opencode.ai/zen/go/v1/models`. OpenCode Go's live model
list is membership source of truth, including models whose endpoint
documentation uses another protocol label. The profile still routes requests
through Codex's OpenAI Responses API adapter.

Select one explicitly or choose one from the picker before the first request:

```sh
codex --profile opencode-go --model <model-id>
```

Model selection is required because the unrelated model inherited from base
`~/.codex/config.toml` may not exist at OpenCode Go.

The checked-in `opencode-go-models.json` catalog populates Codex's picker with
the models currently exposed by OpenCode Go. Regenerate it after model-list or
metadata changes with:

```sh
node agent/scripts/generate-codex-opencode-go-model-catalog.mjs
```

Generation requires Codex 0.154 on `PATH`. It performs authenticated GET
requests to OpenCode Go's `/models` endpoint and `models.dev`, plus one probe to
a temporary loopback Responses endpoint to capture Codex's installed
unknown-model instructions. It makes no paid model request. Model IDs and
object keys use UTF-8 bytewise ordering; JSON uses two-space indentation and one
final newline. Exact bundled-model matches retain current Codex metadata
except runtime cache hashes, including installed agent instructions. Other
models use captured installed-Codex fallback instructions with honest fallback
provenance; no instruction text is hand-copied. Exact `opencode-go` records from
[models.dev](https://models.dev/api.json) enrich entries when available. Exact
models.dev names become picker display names; reasoning levels come from
`reasoning_options` and use Codex 0.154's named schema order: `none`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `max`, `ultra`, and `persistent`. Only
`reasoning_options` entries with `type=effort` are considered; `none` is omitted
because it represents default/off, not a selectable reasoning level. Installed
Codex descriptions are reused when available; an accepted level without one
uses Codex's required empty description. Boolean, toggle, and token-budget
reasoning metadata never invents levels. Models without models.dev metadata
remain selectable with Codex fallback metadata.

When an exposed ID is a models.dev `family` alias, the generator uses the most
recently updated matching model record. OpenCode Go's `deepseek-flash` alias
therefore inherits current `deepseek-v4.1-flash` metadata, including reasoning
levels.

The generator excludes only generic structural non-agent families such as
embedding, image generation, speech synthesis, transcription, reranking, and
video generation. It reports exclusion counts. Other models returned by
OpenCode Go remain in the catalog, including models without complete metadata.

Codex 0.154 does not import a custom provider's standard `/models` response
into its model picker. The checked-in catalog and explicit model selection
provide discovery instead. Catalog metadata is conservative: models.dev
supplies optional display, context, modality, and reasoning metadata, while
the OpenCode Go gateway remains runtime authority.
