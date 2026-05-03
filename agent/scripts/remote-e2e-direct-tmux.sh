#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

SESSION_NAME="${PI_REMOTE_E2E_SESSION:-pi-remote-e2e}"
REMOTE_WINDOW_NAME="${PI_REMOTE_E2E_REMOTE_WINDOW:-remote}"
LOCAL_WINDOW_NAME="${PI_REMOTE_E2E_LOCAL_WINDOW:-local}"
PORT="${PI_REMOTE_E2E_PORT:-3141}"
REMOTE_URL="${PI_REMOTE_E2E_REMOTE_URL:-http://127.0.0.1:${PORT}}"
IDENTITY="${PI_REMOTE_E2E_IDENTITY:-alice}"
STATE_DIR="${ROOT_DIR}/.pi/remote-e2e/${SESSION_NAME}"
LOG_DIR="${STATE_DIR}/logs"
TMP_DIR="${STATE_DIR}/tmp"
WORKSPACE_CWD_FILE="${STATE_DIR}/workspace-cwd.path"
REMOTE_SERVER_PANE_FILE="${STATE_DIR}/remote-server-pane.id"
REMOTE_CLIENT_PANE_FILE="${STATE_DIR}/remote-client-pane.id"
LOCAL_PANE_FILE="${STATE_DIR}/local-pane.id"
SERVER_LOG_FILE="${LOG_DIR}/remote-server.log"
REMOTE_CLIENT_LOG_FILE="${LOG_DIR}/remote-client.log"
LOCAL_LOG_FILE="${LOG_DIR}/local-pi.log"

usage() {
  cat <<EOF
Usage: scripts/remote-e2e-direct-tmux.sh [up|status|capture|capture-clean|wait-contains|send-remote|send-local|send-remote-keys|send-local-keys|restart-remote|restart-server|server-pid|start-extra-remote|teardown]

Commands:
  up                  Start tmux session with remote server, remote client, standalone pi
  status              Print pane and log paths
  capture [target]    Capture pane output: remote-server | remote-client | local | all
  capture-clean       Capture pane output, strip ANSI, print file path
  wait-contains       Poll clean pane capture until pattern appears
  send-remote PROMPT  Send prompt to remote pane, then Enter
  send-local PROMPT   Send prompt to standalone pi pane, then Enter
  send-remote-keys    Send raw tmux keys to remote pane
  send-local-keys     Send raw tmux keys to local pane
  restart-remote      Respawn remote client pane with --continue
  restart-server      Respawn remote server pane
  server-pid          Print actual remote server process pid
  start-extra-remote  Start extra remote client window. Args passed through to pi:remote
  teardown            Kill tmux session and remove state
EOF
}

require_tool() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "$name is required but not installed" >&2
    exit 1
  fi
}

ensure_state_dirs() {
  mkdir -p "$LOG_DIR" "$TMP_DIR"
}

session_exists() {
  tmux has-session -t "$SESSION_NAME" 2>/dev/null
}

read_file() {
  local file_path="$1"
  if [[ -s "$file_path" ]]; then
    head -n 1 "$file_path"
  fi
}

write_file() {
  local file_path="$1"
  local value="$2"
  printf '%s\n' "$value" >"$file_path"
}

window_target() {
  local window_name="$1"
  printf '%s:%s' "$SESSION_NAME" "$window_name"
}

ensure_workspace_cwd() {
  if [[ ! -s "$WORKSPACE_CWD_FILE" ]]; then
    mktemp -d "${TMP_DIR}/workspace-cwd.XXXXXX" >"$WORKSPACE_CWD_FILE"
  fi
}

workspace_cwd() {
  read_file "$WORKSPACE_CWD_FILE"
}

build_remote_client_command() {
  local mode="${1:-new}"
  local workspace_cwd_path
  workspace_cwd_path="$(workspace_cwd)"
  local base_command
  base_command="cd ${ROOT_DIR@Q} && npm run pi:remote -- --remote-url ${REMOTE_URL} --identity ${IDENTITY} --workspace-cwd ${workspace_cwd_path@Q}"
  if [[ "$mode" == "continue" ]]; then
    printf '%s --continue' "$base_command"
    return
  fi
  printf '%s' "$base_command"
}

build_local_client_command() {
  printf '%s' "cd ${ROOT_DIR@Q} && npm run pi"
}

wait_for_health() {
  local url="${REMOTE_URL%/}/health"
  local attempts=60

  for ((i = 0; i < attempts; i += 1)); do
    if curl --silent --show-error --fail --max-time 2 "$url" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done

  echo "server health check timed out: $url" >&2
  exit 1
}

create_session() {
  ensure_state_dirs
  ensure_workspace_cwd
  : >"$SERVER_LOG_FILE"
  : >"$REMOTE_CLIENT_LOG_FILE"
  : >"$LOCAL_LOG_FILE"

  local remote_server_pane remote_client_pane local_pane

  tmux new-session -d -s "$SESSION_NAME" -n "$REMOTE_WINDOW_NAME" -c "$ROOT_DIR"
  remote_server_pane="$(tmux display-message -p -t "$(window_target "$REMOTE_WINDOW_NAME")" "#{pane_id}")"
  remote_client_pane="$(
    tmux split-window -h -P -F "#{pane_id}" -t "$remote_server_pane" -c "$ROOT_DIR"
  )"
  tmux select-layout -t "$(window_target "$REMOTE_WINDOW_NAME")" even-horizontal
  tmux pipe-pane -o -t "$remote_server_pane" "cat >> ${SERVER_LOG_FILE@Q}"
  tmux pipe-pane -o -t "$remote_client_pane" "cat >> ${REMOTE_CLIENT_LOG_FILE@Q}"
  tmux send-keys -t "$remote_server_pane" "cd ${ROOT_DIR@Q} && npm run pi:server -- --port ${PORT} --origin ${REMOTE_URL}" Enter
  wait_for_health
  tmux send-keys -t "$remote_client_pane" "$(build_remote_client_command new)" Enter

  tmux new-window -d -t "$SESSION_NAME" -n "$LOCAL_WINDOW_NAME" -c "$ROOT_DIR"
  local_pane="$(tmux display-message -p -t "$(window_target "$LOCAL_WINDOW_NAME")" "#{pane_id}")"
  tmux pipe-pane -o -t "$local_pane" "cat >> ${LOCAL_LOG_FILE@Q}"
  tmux send-keys -t "$local_pane" "$(build_local_client_command)" Enter

  write_file "$REMOTE_SERVER_PANE_FILE" "$remote_server_pane"
  write_file "$REMOTE_CLIENT_PANE_FILE" "$remote_client_pane"
  write_file "$LOCAL_PANE_FILE" "$local_pane"
}

assert_pane() {
  local pane_id="$1"
  if [[ -z "$pane_id" ]]; then
    echo "missing pane id" >&2
    exit 1
  fi
  tmux display-message -p -t "$pane_id" "#{pane_id}" >/dev/null
}

ensure_remote_server_pane() {
  local pane_id
  pane_id="$(remote_server_pane)"
  if [[ -n "$pane_id" ]] && tmux display-message -p -t "$pane_id" "#{pane_id}" >/dev/null 2>&1; then
    printf '%s\n' "$pane_id"
    return
  fi

  pane_id="$(tmux display-message -p -t "$(window_target "$REMOTE_WINDOW_NAME")" "#{pane_id}")"
  write_file "$REMOTE_SERVER_PANE_FILE" "$pane_id"
  printf '%s\n' "$pane_id"
}

ensure_remote_client_pane() {
  local pane_id
  pane_id="$(remote_client_pane)"
  if [[ -n "$pane_id" ]] && tmux display-message -p -t "$pane_id" "#{pane_id}" >/dev/null 2>&1; then
    printf '%s\n' "$pane_id"
    return
  fi

  local server_pane
  server_pane="$(ensure_remote_server_pane)"
  pane_id="$(tmux split-window -h -P -F "#{pane_id}" -t "$server_pane" -c "$ROOT_DIR")"
  tmux select-layout -t "$(window_target "$REMOTE_WINDOW_NAME")" even-horizontal
  tmux setw -t "$(window_target "$REMOTE_WINDOW_NAME")" remain-on-exit on
  tmux pipe-pane -o -t "$pane_id" "cat >> ${REMOTE_CLIENT_LOG_FILE@Q}"
  tmux send-keys -t "$pane_id" "$(build_remote_client_command continue)" Enter
  write_file "$REMOTE_CLIENT_PANE_FILE" "$pane_id"
  printf '%s\n' "$pane_id"
}

ensure_local_pane() {
  local pane_id
  pane_id="$(local_pane)"
  if [[ -n "$pane_id" ]] && tmux display-message -p -t "$pane_id" "#{pane_id}" >/dev/null 2>&1; then
    printf '%s\n' "$pane_id"
    return
  fi

  if tmux list-windows -t "$SESSION_NAME" -F "#{window_name}" | grep -Fxq "$LOCAL_WINDOW_NAME"; then
    pane_id="$(tmux display-message -p -t "$(window_target "$LOCAL_WINDOW_NAME")" "#{pane_id}")"
    tmux send-keys -t "$pane_id" "$(build_local_client_command)" Enter
  else
    tmux new-window -d -t "$SESSION_NAME" -n "$LOCAL_WINDOW_NAME" -c "$ROOT_DIR"
    pane_id="$(tmux display-message -p -t "$(window_target "$LOCAL_WINDOW_NAME")" "#{pane_id}")"
    tmux pipe-pane -o -t "$pane_id" "cat >> ${LOCAL_LOG_FILE@Q}"
    tmux send-keys -t "$pane_id" "$(build_local_client_command)" Enter
  fi
  write_file "$LOCAL_PANE_FILE" "$pane_id"
  printf '%s\n' "$pane_id"
}

remote_server_pane() {
  read_file "$REMOTE_SERVER_PANE_FILE"
}

remote_client_pane() {
  read_file "$REMOTE_CLIENT_PANE_FILE"
}

local_pane() {
  read_file "$LOCAL_PANE_FILE"
}

capture_target() {
  local pane_id="$1"
  local output_path="$2"
  assert_pane "$pane_id"
  tmux capture-pane -p -J -S -300 -t "$pane_id" >"$output_path"
  printf '%s\n' "$output_path"
}

clean_capture_file() {
  local source_path="$1"
  local destination_path="$2"
  perl -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g; s/\e\][^\a]*\a//g; s/\r//g' "$source_path" \
    >"$destination_path"
}

capture_clean_target() {
  local target="$1"
  local source_path
  local clean_path
  source_path="$(capture "$target")"
  clean_path="${source_path%.log}.clean.txt"
  clean_capture_file "$source_path" "$clean_path"
  printf '%s\n' "$clean_path"
}

send_prompt() {
  local pane_id="$1"
  local prompt="$2"
  assert_pane "$pane_id"
  tmux send-keys -t "$pane_id" -l "$prompt"
  tmux send-keys -t "$pane_id" Enter
}

restart_remote() {
  local pane_id
  pane_id="$(ensure_remote_client_pane)"
  assert_pane "$pane_id"
  tmux respawn-pane -k -t "$pane_id" "$(build_remote_client_command continue)"
}

restart_server() {
  local pane_id
  pane_id="$(ensure_remote_server_pane)"
  assert_pane "$pane_id"
  tmux respawn-pane -k -t "$pane_id" "cd ${ROOT_DIR@Q} && npm run pi:server -- --port ${PORT} --origin ${REMOTE_URL}"
  wait_for_health
}

send_keys() {
  local pane_id="$1"
  shift
  assert_pane "$pane_id"
  tmux send-keys -t "$pane_id" "$@"
}

start_extra_remote() {
  local window_name="${1:-extra-remote}"
  shift || true
  tmux new-window -d -t "$SESSION_NAME" -n "$window_name" -c "$ROOT_DIR"
  local pane_id
  pane_id="$(tmux display-message -p -t "$(window_target "$window_name")" "#{pane_id}")"
  local log_path="${LOG_DIR}/${window_name}.log"
  : >"$log_path"
  tmux pipe-pane -o -t "$pane_id" "cat >> ${log_path@Q}"
  tmux send-keys -t "$pane_id" "cd ${ROOT_DIR@Q} && npm run pi:remote -- --remote-url ${REMOTE_URL} --identity ${IDENTITY} --workspace-cwd $(workspace_cwd) $*" Enter
  printf '%s\n' "$pane_id"
}

resolve_remote_server_process_pid() {
  local root_pid
  root_pid="$(tmux display-message -p -t "$(ensure_remote_server_pane)" "#{pane_pid}")"
  python3 - "$root_pid" <<'PY'
import subprocess
import sys

root_pid = int(sys.argv[1])

def descendants(pid: int) -> list[int]:
    result: list[int] = []
    queue = [pid]
    seen = set(queue)
    while queue:
        current = queue.pop(0)
        child_output = subprocess.run(
            ["pgrep", "-P", str(current)],
            check=False,
            capture_output=True,
            text=True,
        ).stdout.strip()
        if not child_output:
            continue
        for line in child_output.splitlines():
            child = int(line.strip())
            if child in seen:
                continue
            seen.add(child)
            result.append(child)
            queue.append(child)
    return result

process_table = {}
for pid in descendants(root_pid):
    ps = subprocess.run(
        ["ps", "-o", "pid=,rss=,command=", "-p", str(pid)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if not ps:
        continue
    parts = ps.split(None, 2)
    if len(parts) != 3:
        continue
    process_table[int(parts[0])] = (int(parts[1]), parts[2])

matches = [
    (pid, rss, command)
    for pid, (rss, command) in process_table.items()
    if "src/remote/index.ts" in command
]

if matches:
    matches.sort(key=lambda item: (item[1], item[0]))
    print(matches[-1][0])
    raise SystemExit(0)

if process_table:
    pid = max(process_table.items(), key=lambda item: (item[1][0], item[0]))[0]
    print(pid)
    raise SystemExit(0)

print(root_pid)
PY
}

wait_contains() {
  local target="$1"
  local pattern="$2"
  local attempts="${3:-90}"
  local sleep_seconds="${4:-1}"
  local clean_path

  for ((index = 0; index < attempts; index += 1)); do
    clean_path="$(capture_clean_target "$target")"
    if grep -Fq "$pattern" "$clean_path"; then
      printf '%s\n' "$clean_path"
      return
    fi
    sleep "$sleep_seconds"
  done

  echo "pattern not found in ${target}: ${pattern}" >&2
  exit 1
}

status() {
  echo "session: $SESSION_NAME"
  echo "remote-url: $REMOTE_URL"
  echo "workspace-cwd: $(workspace_cwd)"
  echo "remote-server-pane: $(ensure_remote_server_pane)"
  echo "remote-client-pane: $(ensure_remote_client_pane)"
  echo "local-pane: $(ensure_local_pane)"
  echo "logs: $LOG_DIR"
}

capture() {
  local target="${1:-all}"
  case "$target" in
    remote-server)
      capture_target "$(ensure_remote_server_pane)" "${LOG_DIR}/remote-server.capture.log"
      ;;
    remote-client)
      capture_target "$(ensure_remote_client_pane)" "${LOG_DIR}/remote-client.capture.log"
      ;;
    local)
      capture_target "$(ensure_local_pane)" "${LOG_DIR}/local.capture.log"
      ;;
    all)
      capture_target "$(ensure_remote_server_pane)" "${LOG_DIR}/remote-server.capture.log"
      capture_target "$(ensure_remote_client_pane)" "${LOG_DIR}/remote-client.capture.log"
      capture_target "$(ensure_local_pane)" "${LOG_DIR}/local.capture.log"
      ;;
    *)
      echo "invalid capture target: $target" >&2
      exit 1
      ;;
  esac
}

teardown() {
  if session_exists; then
    tmux kill-session -t "$SESSION_NAME"
  fi
  rm -rf "$STATE_DIR"
}

main() {
  local command="${1:-up}"

  require_tool tmux
  require_tool curl
  require_tool npm

  case "$command" in
    up)
      if ! session_exists; then
        create_session
      fi
      status
      ;;
    status)
      status
      ;;
    capture)
      shift
      capture "$@"
      ;;
    capture-clean)
      shift
      capture_clean_target "${1:-all}"
      ;;
    wait-contains)
      shift
      wait_contains "$@"
      ;;
    send-remote)
      shift
      send_prompt "$(ensure_remote_client_pane)" "$*"
      ;;
    send-local)
      shift
      send_prompt "$(ensure_local_pane)" "$*"
      ;;
    send-remote-keys)
      shift
      send_keys "$(ensure_remote_client_pane)" "$@"
      ;;
    send-local-keys)
      shift
      send_keys "$(ensure_local_pane)" "$@"
      ;;
    restart-remote)
      restart_remote
      ;;
    restart-server)
      restart_server
      ;;
    server-pid)
      resolve_remote_server_process_pid
      ;;
    start-extra-remote)
      shift
      start_extra_remote "$@"
      ;;
    teardown)
      teardown
      ;;
    help|-h|--help)
      usage
      ;;
    *)
      echo "unknown command: $command" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
