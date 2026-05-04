#!/usr/bin/env bash

set -euo pipefail

PACKAGE_SCOPE='@shekohex'
PACKAGE_NAME='@shekohex/agent'
REGISTRY_URL='https://npm.pkg.github.com'
RAW_PACKAGE_ENDPOINT='https://npm.pkg.github.com/@shekohex%2fagent'
GITHUB_API_URL='https://api.github.com/'

package_manager='npm'
package_version=''
token_source=''
token_value=''
default_package_version=''

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

note() {
  printf '%s\n' "$1" >&2
}

usage() {
  cat >&2 <<'EOF'
Usage: install-github-package.sh [--npm|--pnpm|--bun|--yarn] [--version VERSION]

Auth lookup order:
1. NODE_AUTH_TOKEN
2. NPM_TOKEN
3. GH_TOKEN
4. GITHUB_TOKEN
5. gh auth token

Examples:
  curl -fSL https://raw.githubusercontent.com/shekohex/dotai/main/agent/scripts/install-github-package.sh | bash -s -- --npm
  curl -fSL https://raw.githubusercontent.com/shekohex/dotai/main/agent/scripts/install-github-package.sh | bash -s -- --bun --version 0.72.1-dev.abcdef0
EOF
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --npm)
        package_manager='npm'
        ;;
      --pnpm)
        package_manager='pnpm'
        ;;
      --bun)
        package_manager='bun'
        ;;
      --yarn)
        package_manager='yarn'
        ;;
      --version)
        [[ $# -ge 2 ]] || fail '--version requires value'
        package_version="$2"
        shift
        ;;
      --help|-h)
        usage
        ;;
      *)
        fail "unknown argument: $1"
        ;;
    esac
    shift
  done
}

resolve_auth_token() {
  if [[ -n "${NODE_AUTH_TOKEN:-}" ]]; then
    token_source='NODE_AUTH_TOKEN'
    token_value="$NODE_AUTH_TOKEN"
    return
  fi

  if [[ -n "${NPM_TOKEN:-}" ]]; then
    token_source='NPM_TOKEN'
    token_value="$NPM_TOKEN"
    return
  fi

  if [[ -n "${GH_TOKEN:-}" ]]; then
    token_source='GH_TOKEN'
    token_value="$GH_TOKEN"
    return
  fi

  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    token_source='GITHUB_TOKEN'
    token_value="$GITHUB_TOKEN"
    return
  fi

  if command -v gh >/dev/null 2>&1; then
    token_source='gh auth token'
    token_value="$(gh auth token 2>/dev/null || true)"
    if [[ -n "$token_value" ]]; then
      return
    fi
  fi

  fail 'no GitHub token found. Set NODE_AUTH_TOKEN, NPM_TOKEN, GH_TOKEN, or GITHUB_TOKEN, or run `gh auth login && gh auth refresh -s read:packages`.'
}

token_scope_header() {
  require_command curl

  curl -fsSI \
    -H "Authorization: Bearer $token_value" \
    -H 'Accept: application/vnd.github+json' \
    "$GITHUB_API_URL" | tr -d '\r' | awk -F': ' 'tolower($1) == "x-oauth-scopes" { print $2 }'
}

verify_package_access() {
  require_command curl

  local response_code
  response_code="$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $token_value" \
    -H 'Accept: application/vnd.npm.install-v1+json' \
    "$RAW_PACKAGE_ENDPOINT")"

  if [[ "$response_code" == '200' ]]; then
    return
  fi

  local scopes
  scopes="$(token_scope_header || true)"

  if [[ -n "$scopes" && ",$scopes," != *', read:packages,'* && ",$scopes," != *',read:packages,'* ]]; then
    fail "token from ${token_source} missing read:packages scope. Run: gh auth refresh -s read:packages"
  fi

  fail "GitHub Packages auth failed with ${token_source} (HTTP ${response_code}). Ensure token can read public packages from ${REGISTRY_URL} and includes read:packages."
}

package_spec() {
  if [[ -n "$package_version" ]]; then
    printf '%s@%s' "$PACKAGE_NAME" "$package_version"
    return
  fi

  if [[ -n "$default_package_version" ]]; then
    printf '%s@%s' "$PACKAGE_NAME" "$default_package_version"
    return
  fi

  printf '%s' "$PACKAGE_NAME"
}

make_temp_dir() {
  mktemp -d
}

write_npmrc() {
  local temp_dir="$1"
  printf '%s\n%s\n' \
    "${PACKAGE_SCOPE}:registry=${REGISTRY_URL}" \
    "//npm.pkg.github.com/:_authToken=${token_value}" > "$temp_dir/.npmrc"
}

install_with_npm() {
  require_command npm
  local temp_dir package_ref
  temp_dir="$(make_temp_dir)"
  package_ref="$(package_spec)"
  write_npmrc "$temp_dir"
  npm install --global "$package_ref" --userconfig "$temp_dir/.npmrc"
  rm -rf "$temp_dir"
}

install_with_pnpm() {
  require_command pnpm
  local temp_dir package_ref
  temp_dir="$(make_temp_dir)"
  package_ref="$(package_spec)"
  write_npmrc "$temp_dir"
  NPM_CONFIG_USERCONFIG="$temp_dir/.npmrc" pnpm add --global "$package_ref"
  rm -rf "$temp_dir"
}

install_with_bun() {
  require_command bun
  local temp_dir package_ref
  temp_dir="$(make_temp_dir)"
  package_ref="$(package_spec)"
  write_npmrc "$temp_dir"
  XDG_CONFIG_HOME="$temp_dir" bun add --global "$package_ref"
  rm -rf "$temp_dir"
}

install_with_yarn() {
  require_command yarn
  local temp_dir package_ref
  temp_dir="$(make_temp_dir)"
  package_ref="$(package_spec)"
  write_npmrc "$temp_dir"
  yarn global add "$package_ref" --userconfig "$temp_dir/.npmrc"
  rm -rf "$temp_dir"
}

main() {
  parse_args "$@"
  resolve_auth_token
  verify_package_access
  note "Using token from ${token_source}"

  case "$package_manager" in
    npm)
      install_with_npm
      ;;
    pnpm)
      install_with_pnpm
      ;;
    bun)
      install_with_bun
      ;;
    yarn)
      install_with_yarn
      ;;
  esac
}

main "$@"
