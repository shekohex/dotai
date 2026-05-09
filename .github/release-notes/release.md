## Changelog

{{CHANGELOG_BODY}}

## Install

### UNIX

```bash
curl -fsSL {{INSTALL_SCRIPT_URL}} | bash -s -- --npm
```

```bash
curl -fsSL {{INSTALL_SCRIPT_URL}} | bash -s -- --pnpm
```

```bash
curl -fsSL {{INSTALL_SCRIPT_URL}} | bash -s -- --bun
```

```bash
curl -fsSL {{INSTALL_SCRIPT_URL}} | bash -s -- --yarn
```

### Windows PowerShell

```powershell
$env:PI_PACKAGE_MANAGER='npm'; irm {{WINDOWS_INSTALL_SCRIPT_URL}} | iex
```

```powershell
$env:PI_PACKAGE_MANAGER='pnpm'; irm {{WINDOWS_INSTALL_SCRIPT_URL}} | iex
```

```powershell
$env:PI_PACKAGE_MANAGER='bun'; irm {{WINDOWS_INSTALL_SCRIPT_URL}} | iex
```

```powershell
$env:PI_PACKAGE_MANAGER='yarn'; irm {{WINDOWS_INSTALL_SCRIPT_URL}} | iex
```

## Notes

Install requires GitHub auth. Script checks `NODE_AUTH_TOKEN`, `NPM_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then falls back to `gh auth token`. Token must have `read:packages`. Refresh scopes with `gh auth refresh -s read:packages`.
