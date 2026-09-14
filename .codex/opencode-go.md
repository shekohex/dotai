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

OpenCode Go models currently documented with
[Responses API endpoints](https://opencode.ai/docs/go/#endpoints) are:

- `gpt-5.6-luna`
- `grok-4.6`
- `muse-spark-1.3-contributor`
- `muse-spark-1.2-contributor`

Select one explicitly or choose one from the picker before the first request:

```sh
codex --profile opencode-go --model <model-id>
```

Model selection is required because the unrelated model inherited from base
`~/.codex/config.toml` may not exist at OpenCode Go.

The checked-in `opencode-go-models.json` catalog populates Codex's picker with
those four models. Regenerate it after documented endpoint changes with:

```sh
node agent/scripts/generate-codex-opencode-go-model-catalog.mjs
```

Generation requires Codex 0.154 on `PATH`. It sends one probe to a temporary
loopback Responses endpoint to capture Codex's installed unknown-model
instructions; it makes no OpenCode request and no paid model request. Model IDs
and object keys use UTF-8 bytewise ordering; JSON uses two-space indentation and
one final newline. Exact bundled-model matches retain current Codex metadata
except runtime cache hashes, including installed agent instructions. Other
documented models use captured installed-Codex fallback instructions with honest
fallback provenance; no instruction text is hand-copied. Exact `opencode-go` records from
[models.dev](https://models.dev/api.json) must confirm text input/output and tool
calling. Exact models.dev names become picker display names. Reasoning efforts
use Codex 0.154's named schema order: `none`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`, `ultra`, and `persistent`. Only `reasoning_options` entries with
`type=effort` are considered; `none` is omitted because it represents default/off,
not a selectable reasoning level. Installed Codex descriptions are reused when
available; an accepted level without one uses Codex's required empty description.
Boolean, toggle, and token-budget reasoning metadata never invents levels. Catalog
exposes only Codex-usable text and image inputs; models.dev PDF, audio, and video
modalities are not exposed as Codex attachments.

Codex 0.154 does not import a custom provider's standard `/models` response
into its model picker. The checked-in catalog and explicit model selection
provide discovery instead. Catalog metadata is conservative:
OpenCode's endpoint documentation identifies compatible model IDs and wire
protocol. models.dev supplies context and reasoning metadata, but the OpenCode
Go gateway remains the runtime authority. Only select models documented at
OpenCode Go's `/responses` endpoint; models exposed through `/chat/completions`
or `/messages` are not compatible with Codex's custom-provider wire protocol.
