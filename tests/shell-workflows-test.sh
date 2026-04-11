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

assert_not_contains() {
  local needle="$1"
  local haystack="$2"

  if grep -Fq -- "$needle" "$haystack"; then
    fail "did not expect to find '$needle' in $haystack"
  fi
}

make_temp_home() {
  local temp_home
  temp_home="$(mktemp -d)"
  mkdir -p "$temp_home/.claude" "$temp_home/.config/opencode" "$temp_home/.codex" "$temp_home/.gemini" "$temp_home/.pi/agent"
  printf 'old claude\n' > "$temp_home/.claude/CLAUDE.md"
  printf 'old opencode\n' > "$temp_home/.config/opencode/AGENTS.md"
  printf 'old codex\n' > "$temp_home/.codex/AGENTS.md"
  printf 'old gemini\n' > "$temp_home/.gemini/GEMINI.md"
  printf 'old pi\n' > "$temp_home/.pi/agent/AGENTS.md"
  printf '%s\n' "$temp_home"
}

setup_fake_npm() {
  local temp_dir fake_bin log_file
  temp_dir="$(mktemp -d)"
  fake_bin="$temp_dir/bin"
  log_file="$temp_dir/npm.log"
  mkdir -p "$fake_bin"

  cat > "$fake_bin/npm" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >> "$log_file"
EOF
  chmod +x "$fake_bin/npm"

  printf '%s\n%s\n' "$fake_bin" "$log_file"
}

test_install_supports_noninteractive_env() {
  local temp_home fake_npm fake_bin npm_log
  temp_home="$(make_temp_home)"
  mapfile -t fake_npm < <(setup_fake_npm)
  fake_bin="${fake_npm[0]}"
  npm_log="${fake_npm[1]}"

  HOME="$temp_home" PATH="$fake_bin:$PATH" DOTAI_NONINTERACTIVE=1 bash "$ROOT_DIR/install.sh" >"$temp_home/install-env.log" 2>&1 < /dev/null || \
    fail "install.sh should succeed with DOTAI_NONINTERACTIVE=1"

  assert_file_equals "$ROOT_DIR/AI.md" "$temp_home/.claude/CLAUDE.md"
  assert_file_equals "$ROOT_DIR/AI.md" "$temp_home/.config/opencode/AGENTS.md"
  assert_file_equals "$ROOT_DIR/AI.md" "$temp_home/.codex/AGENTS.md"
  assert_file_equals "$ROOT_DIR/AI.md" "$temp_home/.gemini/GEMINI.md"
  assert_file_equals "$ROOT_DIR/AI.md" "$temp_home/.pi/agent/AGENTS.md"
  assert_contains 'ci --ignore-scripts' "$npm_log"
  assert_contains 'uninstall -g @shekohex/agent' "$npm_log"
  assert_contains "install -g --install-links $ROOT_DIR/agent" "$npm_log"
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
  local temp_home fake_npm fake_bin npm_log
  temp_home="$(make_temp_home)"
  mapfile -t fake_npm < <(setup_fake_npm)
  fake_bin="${fake_npm[0]}"
  npm_log="${fake_npm[1]}"

  HOME="$temp_home" PATH="$fake_bin:$PATH" bash "$ROOT_DIR/install.sh" --non-interactive >"$temp_home/install-flag.log" 2>&1 < /dev/null || \
    fail "install.sh should succeed with --non-interactive"

  assert_file_equals "$ROOT_DIR/AI.md" "$temp_home/.claude/CLAUDE.md"
  assert_file_equals "$ROOT_DIR/AI.md" "$temp_home/.config/opencode/AGENTS.md"
  assert_file_equals "$ROOT_DIR/AI.md" "$temp_home/.pi/agent/AGENTS.md"
  assert_contains 'ci --ignore-scripts' "$npm_log"
  assert_contains 'uninstall -g @shekohex/agent' "$npm_log"
  assert_contains "install -g --install-links $ROOT_DIR/agent" "$npm_log"
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
  {"owner_name":"shekohex","name":"alpha","latest_build":{"transition":"start","resources":[{"agents":[{"status":"connected"}]}]}},
  {"owner_name":"shekohex","name":"beta","latest_build":{"transition":"start","resources":[{"agents":[{"status":"connected"}]}]}}
]
JSON
    ;;
  ssh)
    if [[ "$2" == "--wait=no" ]]; then
      workspace="$3"
      command="$4"
    else
      workspace="$2"
      command="$3"
    fi
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
  assert_contains 'rm -rf "$CONFIG_DIR"' "$log_file"
  assert_contains '100\.100\.1\.116' "$log_file"
  assert_contains '192.168.1.116' "$log_file"
  assert_contains 'bun install -g opencode-ai@latest @openchamber/web@latest' "$log_file"
  assert_contains 'kill -HUP' "$log_file"
  assert_contains 'pid did not change after restart' "$log_file"
  assert_contains 'OpenChamber' "$log_file"
}

test_sync_coder_workspaces_supports_full_workspace_restart_flag() {
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
  {"owner_name":"shekohex","name":"alpha","latest_build":{"transition":"start","resources":[{"agents":[{"status":"connected"}]}]}}
]
JSON
    ;;
  ssh)
    if [[ "$2" == "--wait=no" ]]; then
      workspace="$3"
      command="$4"
    else
      workspace="$2"
      command="$3"
    fi
    printf 'ssh %s %s\n' "$workspace" "$command" >> "$log_file"
    ;;
  restart)
    printf 'restart %s\n' "$3" >> "$log_file"
    ;;
  *)
    exit 1
    ;;
esac
EOF
  chmod +x "$fake_bin/coder"

  PATH="$fake_bin:$PATH" FAKE_CODER_LOG="$log_file" bash "$ROOT_DIR/sync-coder-workspaces.sh" --parallel 1 --restart >"$temp_dir/sync.log" 2>&1 || \
    fail "sync-coder-workspaces.sh should support --restart"

  assert_contains 'ssh shekohex/alpha' "$log_file"
  assert_contains 'restart shekohex/alpha' "$log_file"
  assert_not_contains 'OpenChamber' "$log_file"
}

test_sync_coder_workspaces_executes_remote_flow_without_timeout_binary() {
  local temp_dir fake_bin remote_home remote_bin remote_log actual_jq actual_python3
  local opencode_pid openchamber_pid new_opencode_pid new_openchamber_pid
  local opencode_pid_file openchamber_pid_file opencode_supervisor_pid openchamber_supervisor_pid
  temp_dir="$(mktemp -d)"
  fake_bin="$temp_dir/bin"
  remote_home="$temp_dir/remote-home"
  remote_bin="$temp_dir/remote-bin"
  remote_log="$temp_dir/remote.log"
  actual_jq="$(command -v jq)"
  actual_python3="$(command -v python3)"

  mkdir -p "$fake_bin" "$remote_home/dotai/.git" "$remote_home/.config/opencode" "$remote_bin"
  printf 'api=http://100.100.1.116:4000\n' > "$remote_home/.config/opencode/opencode.jsonc"
  printf 'stale\n' > "$remote_home/.config/opencode/stale.txt"
  opencode_pid_file="$temp_dir/opencode.pid"
  openchamber_pid_file="$temp_dir/openchamber.pid"

  cat > "$remote_home/dotai/install.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'install %s %s\n' "${DOTAI_NONINTERACTIVE:-unset}" "$*" >> "${FAKE_REMOTE_LOG:?}"
mkdir -p "$HOME/.config/opencode"
printf 'api=http://100.100.1.116:4000\n' > "$HOME/.config/opencode/opencode.jsonc"
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

  cat > "$remote_bin/opencode" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
trap 'exit 0' HUP
while true; do
  sleep 0.1
done
EOF

  cat > "$remote_bin/openchamber" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
trap 'exit 0' HUP
while true; do
  sleep 0.1
done
EOF

  cat > "$remote_bin/service-supervisor" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
service="$1"
pid_file="$2"
while true; do
  "$service" serve >/dev/null 2>&1 &
  child=$!
  printf '%s\n' "$child" > "$pid_file"
  wait "$child" || true
  sleep 0.05
done
EOF

  cat > "$remote_bin/pgrep" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "-fo" || "$1" == "-fn" ]]; then
  case "$2" in
    *openchamber*)
      cat "${FAKE_OPENCHAMBER_PID_FILE:?}"
      exit 0
      ;;
    *)
      cat "${FAKE_OPENCODE_PID_FILE:?}"
      exit 0
      ;;
  esac
fi
exit 1
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

  chmod +x "$remote_bin/git" "$remote_bin/bun" "$remote_bin/opencode" "$remote_bin/openchamber" "$remote_bin/service-supervisor" "$remote_bin/pgrep" "$remote_bin/jq" "$remote_bin/sed"

  "$remote_bin/service-supervisor" "$remote_bin/opencode" "$opencode_pid_file" >/dev/null 2>&1 &
  opencode_supervisor_pid=$!
  "$remote_bin/service-supervisor" "$remote_bin/openchamber" "$openchamber_pid_file" >/dev/null 2>&1 &
  openchamber_supervisor_pid=$!

  while [[ ! -s "$opencode_pid_file" || ! -s "$openchamber_pid_file" ]]; do
    sleep 0.05
  done

  opencode_pid="$(cat "$opencode_pid_file")"
  openchamber_pid="$(cat "$openchamber_pid_file")"

  cat > "$fake_bin/coder" <<EOF
#!/usr/bin/env bash
set -euo pipefail

case "\$1" in
  list)
    cat <<'JSON'
[
  {"owner_name":"shekohex","name":"alpha","latest_build":{"transition":"start","resources":[{"agents":[{"status":"connected"}]}]}}
]
JSON
    ;;
  ssh)
    if [[ "\$2" == "--wait=no" ]]; then
      workspace="\$3"
      command="\$4"
    else
      workspace="\$2"
      command="\$3"
    fi
    printf 'ssh %s\n' "\$workspace" >> "$remote_log"
    HOME="$remote_home" PATH="$remote_bin:/usr/bin:/bin" FAKE_REMOTE_LOG="$remote_log" FAKE_OPENCODE_PID_FILE="$opencode_pid_file" FAKE_OPENCHAMBER_PID_FILE="$openchamber_pid_file" /bin/bash -c "\$command"
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
  assert_contains '192.168.1.116' "$remote_home/.config/opencode/opencode.jsonc"
  [[ ! -e "$remote_home/.config/opencode/stale.txt" ]] || fail "stale opencode config should be removed before install"

  new_opencode_pid="$(cat "$opencode_pid_file")"
  new_openchamber_pid="$(cat "$openchamber_pid_file")"

  [[ "$new_opencode_pid" != "$opencode_pid" ]] || fail "opencode pid should change after restart"
  [[ "$new_openchamber_pid" != "$openchamber_pid" ]] || fail "openchamber pid should change after restart"
  kill -0 "$new_opencode_pid" 2>/dev/null || fail "restarted opencode process should be running"
  kill -0 "$new_openchamber_pid" 2>/dev/null || fail "restarted openchamber process should be running"

  wait "$opencode_pid" 2>/dev/null || true
  wait "$openchamber_pid" 2>/dev/null || true
  kill "$opencode_supervisor_pid" "$openchamber_supervisor_pid" 2>/dev/null || true
  kill "$new_opencode_pid" "$new_openchamber_pid" 2>/dev/null || true
  wait "$opencode_supervisor_pid" 2>/dev/null || true
  wait "$openchamber_supervisor_pid" 2>/dev/null || true
}

test_install_refuses_implicit_noninteractive_without_opt_in
test_install_supports_noninteractive_env
test_install_supports_noninteractive_flag
test_sync_coder_workspaces_builds_expected_remote_flow
test_sync_coder_workspaces_supports_full_workspace_restart_flag
test_sync_coder_workspaces_executes_remote_flow_without_timeout_binary

printf 'PASS\n'
