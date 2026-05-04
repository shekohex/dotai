## Install

```bash
curl -fSL {{INSTALL_SCRIPT_URL}} | bash -s -- --npm
```

```bash
curl -fSL {{INSTALL_SCRIPT_URL}} | bash -s -- --pnpm
```

```bash
curl -fSL {{INSTALL_SCRIPT_URL}} | bash -s -- --bun
```

```bash
curl -fSL {{INSTALL_SCRIPT_URL}} | bash -s -- --yarn
```

## Notes

Install requires GitHub auth. Script checks `NODE_AUTH_TOKEN`, `NPM_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then falls back to `gh auth token`. Token must have `read:packages`. Refresh scopes with `gh auth refresh -s read:packages`.

{{CHANGELOG_BODY}}
