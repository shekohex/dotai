# dotai CubeSandbox

Project-owned CubeSandbox image and operator CLI, adapted from
[`shekohex/cubesandbox-pve@774d85b8c4aa06d63085845ff064efe26aec00b6`](https://github.com/shekohex/cubesandbox-pve/tree/774d85b8c4aa06d63085845ff064efe26aec00b6).

## Image contract

Build requires exact 40-character `DOTAI_REF`, recorded as image provenance. To validate through
the authorized remote builder without changing local Docker state:

```sh
DOCKER_HOST=ssh://builder@bbcr.0iq.xyz \
GITHUB_TOKEN="$(gh auth token)" \
docker buildx build \
  --platform linux/amd64 \
  --build-arg DOTAI_REF="$(git rev-parse HEAD)" \
  --secret id=github_token,env=GITHUB_TOKEN \
  --load \
  --tag "dotai-cubesandbox-pr34:$(git rev-parse --short=12 HEAD)" \
  -f .cube/Dockerfile .
```

After inspection, remove only that task-owned tag:

```sh
DOCKER_HOST=ssh://builder@bbcr.0iq.xyz \
docker image rm "dotai-cubesandbox-pr34:$(git rev-parse --short=12 HEAD)"
```

The token value stays out of command arguments and build layers/history. Current Dockerfile does not
mount it because dotai clone moved entirely to runtime; the validation invocation still exercises
secret-safe BuildKit transport. Cleanup must remove only task tag above, never global cache or other
remote images/containers/volumes.

Image pins JS Hakim base digest, Paseo 0.8.0, and Codex 0.154.0. Codex uses official standalone
installer with exact `--release`; gh 2.95.0 comes from pinned base image and is verified as `coder`.
No dotai checkout or config is installed at build time. Build leaves no source checkout, GitHub
state, Git credentials, Git identity, auth files, or Paseo identity. Health port `49983` belongs to
Cube adapter; it is not an app preview.

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

Manual CLI-created sandboxes carry `owner=operator-cli`. Paseo plugin owns only sandboxes recorded
in private plugin state and never adopts manual sandboxes. Runtime bootstrap clones `shekohex/dotai`
`main` into `/workspace/dotai`, runs `gh auth setup-git`, `./install.sh --yes`, and `npm ci` in
`agent`. Before Paseo daemon starts, it copies local `~/.pi/agent/auth.json`, `~/.codex/auth.json`,
and `~/.paseo/config.json` into runtime sandbox with mode `0600`. Override manual CLI sources with
`CUBE_PI_AUTH_FILE`, `CUBE_CODEX_AUTH_FILE`, and `CUBE_PASEO_CONFIG_FILE`. These runtime files and
GitHub token never enter image or prepared snapshot.

No Android tooling/support included.
