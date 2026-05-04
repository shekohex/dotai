## Install

```bash
tmp="$(mktemp)" && printf '%s\n%s\n' '@shekohex:registry=https://npm.pkg.github.com' "//npm.pkg.github.com/:_authToken=$(gh auth token)" > "$tmp" && npm install --global @shekohex/agent@{{PACKAGE_VERSION}} --userconfig "$tmp" && rm "$tmp"
```

```bash
tmp="$(mktemp)" && printf '%s\n%s\n' '@shekohex:registry=https://npm.pkg.github.com' "//npm.pkg.github.com/:_authToken=$(gh auth token)" > "$tmp" && NPM_CONFIG_USERCONFIG="$tmp" pnpm add --global @shekohex/agent@{{PACKAGE_VERSION}} && rm "$tmp"
```

```bash
tmpdir="$(mktemp -d)" && printf '%s\n%s\n' '@shekohex:registry=https://npm.pkg.github.com' "//npm.pkg.github.com/:_authToken=$(gh auth token)" > "$tmpdir/.npmrc" && XDG_CONFIG_HOME="$tmpdir" bun add --global @shekohex/agent@{{PACKAGE_VERSION}} && rm -rf "$tmpdir"
```

```bash
tmp="$(mktemp)" && printf '%s\n%s\n' '@shekohex:registry=https://npm.pkg.github.com' "//npm.pkg.github.com/:_authToken=$(gh auth token)" > "$tmp" && yarn global add @shekohex/agent@{{PACKAGE_VERSION}} --userconfig "$tmp" && rm "$tmp"
```

## Notes

Rolling preview release from latest `main`.
Version published to GitHub Packages uses commit-scoped prerelease suffix.
Install requires GitHub auth. `gh auth token` must come from session with `read:packages` scope. Refresh scopes with `gh auth refresh -s read:packages`, or replace `$(gh auth token)` with any GitHub token that has `read:packages`.

## Changelog

{{CHANGELOG_BODY}}
