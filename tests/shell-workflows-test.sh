#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_file_equals() {
  local expected="$1"
  local actual="$2"

  cmp -s "$expected" "$actual" || fail "expected $actual to match $expected"
}

assert_contains() {
  local needle="$1"
  local haystack="$2"

  grep -Fq -- "$needle" "$haystack" || fail "expected to find '$needle' in $haystack"
}

make_temp_home() {
  local temp_home
  temp_home="$(mktemp -d)"
  mkdir -p "$temp_home/.claude" "$temp_home/.config/opencode" "$temp_home/.codex" "$temp_home/.gemini"
  printf 'old claude\n' > "$temp_home/.claude/CLAUDE.md"
  printf 'old opencode\n' > "$temp_home/.config/opencode/AGENTS.md"
  printf 'old codex\n' > "$temp_home/.codex/AGENTS.md"
  printf 'old gemini\n' > "$temp_home/.gemini/GEMINI.md"
  printf '%s\n' "$temp_home"
}

test_install_supports_noninteractive_env() {
  local temp_home
  temp_home="$(make_temp_home)"

  HOME="$temp_home" DOTAI_NONINTERACTIVE=1 bash "$ROOT_DIR/install.sh" >"$temp_home/install-env.log" 2>&1 < /dev/null || \
    fail "install.sh should succeed with DOTAI_NONINTERACTIVE=1"

  assert_file_equals "$ROOT_DIR/AI.md" "$temp_home/.claude/CLAUDE.md"
  assert_file_equals "$ROOT_DIR/AI.md" "$temp_home/.config/opencode/AGENTS.md"
  assert_file_equals "$ROOT_DIR/AI.md" "$temp_home/.codex/AGENTS.md"
  assert_file_equals "$ROOT_DIR/AI.md" "$temp_home/.gemini/GEMINI.md"
}

test_install_refuses_implicit_noninteractive_without_opt_in() {
  local temp_home
  temp_home="$(make_temp_home)"

  if HOME="$temp_home" bash "$ROOT_DIR/install.sh" >"$temp_home/install-implicit.log" 2>&1 < /dev/null; then
    fail "install.sh should refuse implicit non-interactive updates without opt-in"
  fi

  assert_contains 'Use --non-interactive or DOTAI_NONINTERACTIVE=1' "$temp_home/install-implicit.log"
}

test_install_supports_noninteractive_flag() {
  local temp_home
  temp_home="$(make_temp_home)"

  HOME="$temp_home" bash "$ROOT_DIR/install.sh" --non-interactive >"$temp_home/install-flag.log" 2>&1 < /dev/null || \
    fail "install.sh should succeed with --non-interactive"

  assert_file_equals "$ROOT_DIR/AI.md" "$temp_home/.claude/CLAUDE.md"
  assert_file_equals "$ROOT_DIR/AI.md" "$temp_home/.config/opencode/AGENTS.md"
}

test_sync_coder_workspaces_builds_expected_remote_flow() {
  local temp_dir fake_bin log_file
  temp_dir="$(mktemp -d)"
  fake_bin="$temp_dir/bin"
  log_file="$temp_dir/coder.log"
  mkdir -p "$fake_bin"

  cat > "$fake_bin/coder" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

log_file="${FAKE_CODER_LOG:?}"

case "$1" in
  list)
    cat <<'JSON'
[
  {"owner_name":"shekohex","name":"alpha"},
  {"owner_name":"shekohex","name":"beta"}
]
JSON
    ;;
  ssh)
    workspace="$2"
    command="$3"
    printf 'ssh %s %s\n' "$workspace" "$command" >> "$log_file"
    ;;
  restart)
    if [[ "$2" == "-y" ]]; then
      printf 'restart %s\n' "$3" >> "$log_file"
    else
      printf 'restart %s\n' "$2" >> "$log_file"
    fi
    ;;
  *)
    printf 'unexpected %s\n' "$*" >> "$log_file"
    exit 1
    ;;
esac
EOF
  chmod +x "$fake_bin/coder"

  PATH="$fake_bin:$PATH" FAKE_CODER_LOG="$log_file" bash "$ROOT_DIR/sync-coder-workspaces.sh" --parallel 1 >"$temp_dir/sync.log" 2>&1 || \
    fail "sync-coder-workspaces.sh should succeed with fake coder"

  assert_contains 'ssh shekohex/alpha' "$log_file"
  assert_contains 'ssh shekohex/beta' "$log_file"
  assert_contains 'DOTAI_NONINTERACTIVE=1' "$log_file"
  assert_contains 'install.sh' "$log_file"
  assert_contains '--non-interactive' "$log_file"
  assert_contains '100\.100\.1\.116' "$log_file"
  assert_contains '192.168.1.116' "$log_file"
  assert_contains 'bun install -g opencode-ai@latest @openchamber/web@latest' "$log_file"
  assert_contains 'restart shekohex/alpha' "$log_file"
  assert_contains 'restart shekohex/beta' "$log_file"
}

test_sync_coder_workspaces_executes_remote_flow_without_timeout_binary() {
  local temp_dir fake_bin remote_home remote_bin remote_log actual_jq actual_python3
  temp_dir="$(mktemp -d)"
  fake_bin="$temp_dir/bin"
  remote_home="$temp_dir/remote-home"
  remote_bin="$temp_dir/remote-bin"
  remote_log="$temp_dir/remote.log"
  actual_jq="$(command -v jq)"
  actual_python3="$(command -v python3)"

  mkdir -p "$fake_bin" "$remote_home/dotai" "$remote_home/.config/opencode" "$remote_bin"
  printf 'api=http://100.100.1.116:4000\n' > "$remote_home/.config/opencode/opencode.jsonc"

  cat > "$remote_home/dotai/install.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'install %s %s\n' "${DOTAI_NONINTERACTIVE:-unset}" "$*" >> "${FAKE_REMOTE_LOG:?}"
EOF
  chmod +x "$remote_home/dotai/install.sh"

  cat > "$remote_bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\n' "$*" >> "${FAKE_REMOTE_LOG:?}"
EOF

  cat > "$remote_bin/bun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'bun %s\n' "$*" >> "${FAKE_REMOTE_LOG:?}"
EOF

  cat > "$remote_bin/jq" <<EOF
#!/usr/bin/env bash
exec "$actual_jq" "\$@"
EOF

  cat > "$remote_bin/sed" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ "\$1" != "-i" ]]; then
  exec /usr/bin/sed "\$@"
fi
"$actual_python3" - "\$2" "\$3" <<'PY'
import re
import sys

expression = sys.argv[1]
path = sys.argv[2]
match = re.fullmatch(r's/(.*)/(.*)/g', expression)
if match is None:
    raise SystemExit(f"unsupported sed expression: {expression}")
old = match.group(1).replace(r'\.', '.')
new = match.group(2).replace(r'\/', '/')
with open(path, 'r', encoding='utf-8') as handle:
    content = handle.read()
with open(path, 'w', encoding='utf-8') as handle:
    handle.write(content.replace(old, new))
PY
EOF

  chmod +x "$remote_bin/git" "$remote_bin/bun" "$remote_bin/jq" "$remote_bin/sed"

  cat > "$fake_bin/coder" <<EOF
#!/usr/bin/env bash
set -euo pipefail

case "\$1" in
  list)
    cat <<'JSON'
[
  {"owner_name":"shekohex","name":"alpha"}
]
JSON
    ;;
  ssh)
    workspace="\$2"
    command="\$3"
    printf 'ssh %s\n' "\$workspace" >> "$remote_log"
    HOME="$remote_home" PATH="$remote_bin:/usr/bin:/bin" FAKE_REMOTE_LOG="$remote_log" /bin/bash -c "\$command"
    ;;
  restart)
    if [[ "\$2" == "-y" ]]; then
      printf 'restart %s\n' "\$3" >> "$remote_log"
    else
      printf 'restart %s\n' "\$2" >> "$remote_log"
    fi
    ;;
  *)
    exit 1
    ;;
esac
EOF
  chmod +x "$fake_bin/coder"

  PATH="$fake_bin:$PATH" bash "$ROOT_DIR/sync-coder-workspaces.sh" --parallel 1 >"$temp_dir/remote-sync.log" 2>&1 || \
    fail "sync-coder-workspaces.sh should execute remote flow without remote timeout"

  assert_contains 'install 1 --non-interactive' "$remote_log"
  assert_contains 'git -C ' "$remote_log"
  assert_contains 'pull --ff-only' "$remote_log"
  assert_contains 'bun install -g opencode-ai@latest @openchamber/web@latest' "$remote_log"
  assert_contains 'restart shekohex/alpha' "$remote_log"
  assert_contains '192.168.1.116' "$remote_home/.config/opencode/opencode.jsonc"
}

test_install_refuses_implicit_noninteractive_without_opt_in
test_install_supports_noninteractive_env
test_install_supports_noninteractive_flag
test_sync_coder_workspaces_builds_expected_remote_flow
test_sync_coder_workspaces_executes_remote_flow_without_timeout_binary

printf 'PASS\n'
