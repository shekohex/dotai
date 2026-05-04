#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/agent/scripts/install-github-package.sh"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local needle="$1"
  local haystack="$2"
  grep -Fq -- "$needle" "$haystack" || fail "expected to find '$needle' in $haystack"
}

setup_fake_bin() {
  local temp_dir fake_bin log_file
  temp_dir="$(mktemp -d)"
  fake_bin="$temp_dir/bin"
  log_file="$temp_dir/install.log"
  mkdir -p "$fake_bin"

  cat > "$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >> "${FAKE_INSTALL_LOG:?}"
if [[ "$*" == *'-I'* || "$*" == *'--head'* ]]; then
  printf 'HTTP/1.1 200 OK\r\n'
  printf 'x-oauth-scopes: repo, read:packages\r\n'
  printf '\r\n'
  exit 0
fi
printf '200'
EOF

  cat > "$fake_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\n' "$*" >> "${FAKE_INSTALL_LOG:?}"
if [[ "$1 $2" == 'auth token' ]]; then
  printf 'gho_test_token\n'
  exit 0
fi
exit 1
EOF

  cat > "$fake_bin/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\n' "$*" >> "${FAKE_INSTALL_LOG:?}"
EOF

  cat > "$fake_bin/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm userconfig=%s cmd=%s\n' "${NPM_CONFIG_USERCONFIG:-}" "$*" >> "${FAKE_INSTALL_LOG:?}"
EOF

  cat > "$fake_bin/bun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'bun xdg=%s cmd=%s\n' "${XDG_CONFIG_HOME:-}" "$*" >> "${FAKE_INSTALL_LOG:?}"
EOF

  cat > "$fake_bin/yarn" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'yarn %s\n' "$*" >> "${FAKE_INSTALL_LOG:?}"
EOF

  chmod +x "$fake_bin/curl" "$fake_bin/gh" "$fake_bin/npm" "$fake_bin/pnpm" "$fake_bin/bun" "$fake_bin/yarn"

  printf '%s\n%s\n%s\n' "$temp_dir" "$fake_bin" "$log_file"
}

test_prefers_node_auth_token_for_npm() {
  local fake temp_dir fake_bin log_file
  mapfile -t fake < <(setup_fake_bin)
  temp_dir="${fake[0]}"
  fake_bin="${fake[1]}"
  log_file="${fake[2]}"

  env -i PATH="$fake_bin:$PATH" HOME="$temp_dir" FAKE_INSTALL_LOG="$log_file" NODE_AUTH_TOKEN='node_token' bash "$SCRIPT_PATH" --npm --version 1.2.3 >"$temp_dir/stdout.log" 2>"$temp_dir/stderr.log" || \
    fail 'npm install helper should succeed'

  assert_contains 'Using token from NODE_AUTH_TOKEN' "$temp_dir/stderr.log"
  assert_contains 'npm install --global @shekohex/agent@1.2.3 --userconfig' "$log_file"
  assert_contains 'Authorization: Bearer node_token' "$log_file"
}

test_falls_back_to_gh_for_bun() {
  local fake temp_dir fake_bin log_file
  mapfile -t fake < <(setup_fake_bin)
  temp_dir="${fake[0]}"
  fake_bin="${fake[1]}"
  log_file="${fake[2]}"

  env -i PATH="$fake_bin:$PATH" HOME="$temp_dir" FAKE_INSTALL_LOG="$log_file" bash "$SCRIPT_PATH" --bun >"$temp_dir/stdout.log" 2>"$temp_dir/stderr.log" || \
    fail 'bun install helper should succeed'

  assert_contains 'gh auth token' "$log_file"
  assert_contains 'Using token from gh auth token' "$temp_dir/stderr.log"
  assert_contains 'bun xdg=' "$log_file"
  assert_contains 'cmd=add --global @shekohex/agent' "$log_file"
}

test_uses_pnpm_userconfig() {
  local fake temp_dir fake_bin log_file
  mapfile -t fake < <(setup_fake_bin)
  temp_dir="${fake[0]}"
  fake_bin="${fake[1]}"
  log_file="${fake[2]}"

  env -i PATH="$fake_bin:$PATH" HOME="$temp_dir" FAKE_INSTALL_LOG="$log_file" GH_TOKEN='gh_token' bash "$SCRIPT_PATH" --pnpm >"$temp_dir/stdout.log" 2>"$temp_dir/stderr.log" || \
    fail 'pnpm install helper should succeed'

  assert_contains 'Using token from GH_TOKEN' "$temp_dir/stderr.log"
  assert_contains 'pnpm userconfig=' "$log_file"
  assert_contains 'cmd=add --global @shekohex/agent' "$log_file"
}

test_fails_without_token_source() {
  local fake temp_dir fake_bin log_file
  mapfile -t fake < <(setup_fake_bin)
  temp_dir="${fake[0]}"
  fake_bin="${fake[1]}"
  log_file="${fake[2]}"
  rm "$fake_bin/gh"

  if env -i PATH="$fake_bin:$PATH" HOME="$temp_dir" FAKE_INSTALL_LOG="$log_file" bash "$SCRIPT_PATH" --npm >"$temp_dir/stdout.log" 2>"$temp_dir/stderr.log"; then
    fail 'install helper should fail without token source'
  fi

  assert_contains 'no GitHub token found' "$temp_dir/stderr.log"
}

test_prefers_node_auth_token_for_npm
test_falls_back_to_gh_for_bun
test_uses_pnpm_userconfig
test_fails_without_token_source

printf 'PASS\n'
