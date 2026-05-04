## Install

```bash
NODE_AUTH_TOKEN="$(gh auth token)" npm install --global @shekohex/agent@{{PACKAGE_VERSION}} --registry=https://npm.pkg.github.com
```

```bash
NODE_AUTH_TOKEN="$(gh auth token)" pnpm add --global @shekohex/agent@{{PACKAGE_VERSION}} --registry=https://npm.pkg.github.com
```

```bash
NODE_AUTH_TOKEN="$(gh auth token)" bun add --global @shekohex/agent@{{PACKAGE_VERSION}} --registry=https://npm.pkg.github.com
```

```bash
NODE_AUTH_TOKEN="$(gh auth token)" yarn global add @shekohex/agent@{{PACKAGE_VERSION}} --registry https://npm.pkg.github.com
```

## Notes

Rolling preview release from latest `main`.
Version published to GitHub Packages uses commit-scoped prerelease suffix.
Install requires GitHub auth. `gh auth token` must come from session with `read:packages` scope, or replace it with any token in `NODE_AUTH_TOKEN` that has `read:packages`.

## Changelog

{{CHANGELOG_BODY}}
