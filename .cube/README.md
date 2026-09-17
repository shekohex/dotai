# dotai CubeSandbox

Project-owned CubeSandbox image and operator CLI, adapted from
[`shekohex/cubesandbox-pve@774d85b8c4aa06d63085845ff064efe26aec00b6`](https://github.com/shekohex/cubesandbox-pve/tree/774d85b8c4aa06d63085845ff064efe26aec00b6).

## Image contract

Build requires exact 40-character `DOTAI_REF` and BuildKit `github_token` secret:

```sh
GITHUB_TOKEN="$(gh auth token)" docker buildx build \
  --platform linux/amd64 \
  --build-arg DOTAI_REF="$(git rev-parse HEAD)" \
  --secret id=github_token,env=GITHUB_TOKEN \
  -f .cube/Dockerfile .
```

Image pins JS Hakim base digest, Paseo 0.8.0, Codex 0.154.0, and gh 2.101.0 with checksum. Exact dotai ref supplies dotai configuration and Pi 0.85.1 package contract. Build removes source checkout, GitHub state, Git credentials, Git identity, auth files, and Paseo identity. Health port `49983` belongs to Cube adapter; it is not an app preview.

`pi` is runtime shim:

```bash
set -euo pipefail
cd /workspace/dotai/agent
exec npm run pi -- "$@"
```

Therefore `/workspace/dotai` must exist and `/workspace/dotai/agent` dependencies must be installed by runtime bootstrap before `pi` use.

## Operator CLI

```sh
uv run .cube/sandbox.py config
uv run .cube/sandbox.py deploy --build-arg DOTAI_REF="$(git rev-parse HEAD)"
uv run .cube/sandbox.py prepare-snapshot
uv run .cube/sandbox.py create
```

Defaults come from `.cube/config.json`. `CUBE_API_URL` and `CUBE_SANDBOX_DOMAIN` are trusted host settings; repository values are assertions and mismatches fail before credentials or network access. `CUBE_API_KEY` stays host-only.

`prepare-snapshot` creates a dedicated source Sandbox with empty environment, checks repository/auth/GitHub/Git/Paseo identity paths, snapshots it as `dotai` by default, then destroys source on success or failure. Never prepare snapshot from initialized work sandbox.

Manual CLI-created sandboxes carry `owner=operator-cli`. Paseo plugin owns only sandboxes recorded in private plugin state and never adopts manual sandboxes. Runtime bootstrap clones `shekohex/dotai` `main` into `/workspace/dotai`, runs `npm ci` in `agent`, then configures Git credential integration with runtime `GH_TOKEN`/`GITHUB_TOKEN`. Tokens never enter image or snapshot.

No Android tooling/support included.
