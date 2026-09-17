# dotai CubeSandbox

Project-owned CubeSandbox image and operator CLI, adapted from
[`shekohex/cubesandbox-pve@774d85b8c4aa06d63085845ff064efe26aec00b6`](https://github.com/shekohex/cubesandbox-pve/tree/774d85b8c4aa06d63085845ff064efe26aec00b6).

## Image contract

Deployment requires exact 40-character `DOTAI_REF`, recorded as image provenance. Use the project
CLI from repository root; it builds and pushes the image through the selected Docker host, creates
the Cube template, waits for `READY`, then assigns the configured alias:

```sh
DOCKER_HOST=ssh://builder@bbcr.0iq.xyz \
uv run .cube/sandbox.py --template-alias dotai deploy \
  --build-arg DOTAI_REF="$(git rev-parse HEAD)"
```

Remote registry authentication remains with the Docker host. Pass Cube credentials only through
`CUBE_API_KEY`; never place credentials in build arguments. Do not prune global cache or unrelated
remote images, containers, or volumes.

Image uses exact JS Hakim base tag
`bbcr.0iq.xyz/hakim/cube-hakim-js:71a7eaf6d746-20260917122636` without a digest, and pins Paseo
0.8.0 and Codex 0.154.0. Codex uses official standalone
installer with exact `--release`; gh comes from the exact base image and is verified as `coder`.
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
and `~/.paseo/config.json` into runtime sandbox with mode `0600`.

Runtime also transfers only configured SSH auth pair, effective Git `user.signingkey` pair, and the
`github.com` entries selected from `known_hosts`. `CUBE_SSH_AUTH_KEY` defaults to
`~/.ssh/id_ed25519`; `CUBE_SSH_KNOWN_HOSTS_FILE` defaults to `~/.ssh/known_hosts`. Sources must be
regular non-symlink files inside host `~/.ssh`; traversal and missing/mismatched pairs fail before
clone. Relative subdirectories are preserved under sandbox `/home/coder/.ssh`. Runtime config copies
effective `user.name`, `user.email`, `gpg.format=ssh`, `commit.gpgsign=true`, and `user.signingkey`,
and enforces `StrictHostKeyChecking=yes`. With no GitHub token, clone uses SSH; token-backed gh/HTTPS
flow remains available.

Override manual CLI JSON sources with `CUBE_PI_AUTH_FILE`, `CUBE_CODEX_AUTH_FILE`, and
`CUBE_PASEO_CONFIG_FILE`. Private material uses Cube file transfer, never environment variables or
command arguments. Sandboxed code can read copied keys: a Work Sandbox is trusted for explicitly
authorized coding. Never snapshot, publish, or adopt key-bearing state outside its owning Work
Sandbox. Image and prepared snapshot contain no SSH key, Git signing configuration, runtime identity,
or GitHub token.

No Android tooling/support included.
