#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

SESSION_NAME="${PI_REMOTE_E2E_SESSION:-pi-remote-e2e}"
WINDOW_NAME="${PI_REMOTE_E2E_WINDOW:-e2e}"
PORT="${PI_REMOTE_E2E_PORT:-3000}"
ORIGIN="${PI_REMOTE_E2E_ORIGIN:-http://127.0.0.1:${PORT}}"
CLIENT_SESSION_NAME="${PI_REMOTE_E2E_CLIENT_SESSION_NAME:-Remote E2E}"

STATE_DIR="${ROOT_DIR}/.pi/remote-e2e/${SESSION_NAME}"
KEY_DIR="${STATE_DIR}/keys"
LOG_DIR="${STATE_DIR}/logs"
TMP_DIR="${STATE_DIR}/tmp"
PRIVATE_KEY_FILE="${KEY_DIR}/dev-private.pem"
PUBLIC_KEY_FILE="${KEY_DIR}/dev-public.pem"
SERVER_LOG_FILE="${LOG_DIR}/server.log"
CLIENT_LOG_FILE="${LOG_DIR}/client.log"
SERVER_CAPTURE_FILE="${LOG_DIR}/server.capture.log"
CLIENT_CAPTURE_FILE="${LOG_DIR}/client.capture.log"
SERVER_CWD_FILE="${STATE_DIR}/server-cwd.path"
WORKSPACE_CWD_FILE="${STATE_DIR}/workspace-cwd.path"

usage() {
  cat <<EOF
Usage: scripts/remote-e2e-tmux.sh [up|attach|status|capture|teardown]

Commands:
  up        Create session if missing, then attach
  attach    Attach to existing session
  status    Print tmux + log status
  capture   Capture pane output to files (default both panes)
  teardown  Kill session and remove state/log/key files

Env overrides:
  PI_REMOTE_E2E_SESSION
  PI_REMOTE_E2E_WINDOW
  PI_REMOTE_E2E_PORT
  PI_REMOTE_E2E_ORIGIN
  PI_REMOTE_E2E_CLIENT_SESSION_NAME
  PI_REMOTE_E2E_SERVER_CWD
  PI_REMOTE_E2E_WORKSPACE_CWD
  PI_REMOTE_E2E_HEALTH_TIMEOUT_SECONDS
EOF
}

window_target() {
  printf "%s:%s" "$SESSION_NAME" "$WINDOW_NAME"
}

pane_id_for_title() {
  local title="$1"
  tmux list-panes -t "$(window_target)" -F "#{pane_id} #{pane_title}" \
    | awk -v t="$title" '$2==t { print $1; exit }'
}

wait_for_server_health() {
  local max_seconds="${PI_REMOTE_E2E_HEALTH_TIMEOUT_SECONDS:-60}"
  local health_url="${ORIGIN%/}/health"
  local elapsed=0

  sleep 1

  if ! command -v curl >/dev/null 2>&1; then
    sleep 2
    return
  fi

  while (( elapsed < max_seconds )); do
    if curl --silent --show-error --fail --max-time 2 "$health_url" >/dev/null 2>&1; then
      return
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  echo "warning: server health check timed out (${health_url}) after ${max_seconds}s" >&2
}

require_tool() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "$name is required but not installed" >&2
    exit 1
  fi
}

session_exists() {
  tmux has-session -t "$SESSION_NAME" 2>/dev/null
}

attach_session() {
  if [[ -n "${TMUX:-}" ]]; then
    tmux switch-client -t "$SESSION_NAME"
    return
  fi
  tmux attach-session -t "$SESSION_NAME"
}

ensure_state_dirs() {
  mkdir -p "$KEY_DIR" "$LOG_DIR" "$TMP_DIR"
}

ensure_runtime_paths() {
  if [[ -n "${PI_REMOTE_E2E_SERVER_CWD:-}" ]]; then
    mkdir -p "$PI_REMOTE_E2E_SERVER_CWD"
    printf '%s\n' "$PI_REMOTE_E2E_SERVER_CWD" >"$SERVER_CWD_FILE"
  elif [[ ! -s "$SERVER_CWD_FILE" ]]; then
    mktemp -d "${TMP_DIR}/server-cwd.XXXXXX" >"$SERVER_CWD_FILE"
  fi

  if [[ -n "${PI_REMOTE_E2E_WORKSPACE_CWD:-}" ]]; then
    mkdir -p "$PI_REMOTE_E2E_WORKSPACE_CWD"
    printf '%s\n' "$PI_REMOTE_E2E_WORKSPACE_CWD" >"$WORKSPACE_CWD_FILE"
  elif [[ ! -s "$WORKSPACE_CWD_FILE" ]]; then
    mktemp -d "${TMP_DIR}/workspace-cwd.XXXXXX" >"$WORKSPACE_CWD_FILE"
  fi
}

read_runtime_path() {
  local file_path="$1"
  if [[ -s "$file_path" ]]; then
    head -n 1 "$file_path"
  fi
}

ensure_keys() {
  if [[ -s "$PRIVATE_KEY_FILE" && -s "$PUBLIC_KEY_FILE" ]]; then
    return
  fi

  node --input-type=module <<EOF
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(${KEY_DIR@Q}, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
writeFileSync(
  ${PRIVATE_KEY_FILE@Q},
  privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  "utf8",
);
writeFileSync(
  ${PUBLIC_KEY_FILE@Q},
  publicKey.export({ type: "spki", format: "pem" }).toString(),
  "utf8",
);
EOF
}

build_allowed_keys_json() {
  node --input-type=module <<EOF
import { readFileSync } from "node:fs";
const publicKey = readFileSync(${PUBLIC_KEY_FILE@Q}, "utf8");
process.stdout.write(JSON.stringify({ dev: publicKey }));
EOF
}

start_session() {
  ensure_state_dirs
  ensure_keys
  ensure_runtime_paths

  : >"$SERVER_LOG_FILE"
  : >"$CLIENT_LOG_FILE"

  local allowed_keys_json
  local root_q origin_q keys_q private_q client_session_q server_cwd_q workspace_cwd_q
  local server_cwd workspace_cwd
  allowed_keys_json="$(build_allowed_keys_json)"
  server_cwd="$(read_runtime_path "$SERVER_CWD_FILE")"
  workspace_cwd="$(read_runtime_path "$WORKSPACE_CWD_FILE")"
  printf -v root_q '%q' "$ROOT_DIR"
  printf -v origin_q '%q' "$ORIGIN"
  printf -v keys_q '%q' "$allowed_keys_json"
  printf -v private_q '%q' "$PRIVATE_KEY_FILE"
  printf -v client_session_q '%q' "$CLIENT_SESSION_NAME"
  printf -v server_cwd_q '%q' "$server_cwd"
  printf -v workspace_cwd_q '%q' "$workspace_cwd"

  local server_cmd
  local client_cmd
  server_cmd="cd ${server_cwd_q} && PI_REMOTE_PORT=${PORT} PI_REMOTE_ORIGIN=${origin_q} PI_REMOTE_ALLOWED_KEYS=${keys_q} npm --prefix ${root_q} run remote"
  client_cmd="cd ${root_q} && npm run pi -- --mode-rush --remote-origin ${origin_q} --remote-key-id dev --remote-private-key-path ${private_q} --remote-session-name ${client_session_q} --workspace-cwd ${workspace_cwd_q}"

  local server_pane_id client_pane_id

  tmux new-session -d -s "$SESSION_NAME" -n "$WINDOW_NAME" -c "$server_cwd"
  server_pane_id="$(tmux display-message -p -t "$(window_target)" "#{pane_id}")"
  client_pane_id="$(tmux split-window -h -P -F "#{pane_id}" -t "$server_pane_id" -c "$ROOT_DIR")"
  tmux select-layout -t "$(window_target)" even-horizontal
  tmux select-pane -t "$server_pane_id" -T server
  tmux select-pane -t "$client_pane_id" -T client
  tmux setw -t "$(window_target)" remain-on-exit on
  tmux pipe-pane -o -t "$server_pane_id" "cat >> ${SERVER_LOG_FILE@Q}"
  tmux pipe-pane -o -t "$client_pane_id" "cat >> ${CLIENT_LOG_FILE@Q}"
  tmux send-keys -t "$server_pane_id" "$server_cmd" C-m
  wait_for_server_health
  tmux send-keys -t "$client_pane_id" "$client_cmd" C-m
}

status() {
  require_tool tmux
  if session_exists; then
    echo "session: $SESSION_NAME (running)"
  else
    echo "session: $SESSION_NAME (missing)"
  fi
  echo "origin:  $ORIGIN"
  echo "server cwd: $(read_runtime_path "$SERVER_CWD_FILE")"
  echo "workspace:  $(read_runtime_path "$WORKSPACE_CWD_FILE")"
  echo "logs:    $LOG_DIR"
  echo "server:  $SERVER_LOG_FILE"
  echo "client:  $CLIENT_LOG_FILE"
  echo "capture: scripts/remote-e2e-tmux.sh capture"
}

capture() {
  require_tool tmux
  if ! session_exists; then
    echo "session not found: $SESSION_NAME" >&2
    exit 1
  fi

  local target="${1:-both}"
  local start_from="${2:--400}"
  local server_pane_id client_pane_id
  server_pane_id="$(pane_id_for_title server)"
  client_pane_id="$(pane_id_for_title client)"
  if [[ -z "$server_pane_id" || -z "$client_pane_id" ]]; then
    echo "server/client panes not found in session: $SESSION_NAME" >&2
    exit 1
  fi
  case "$target" in
    server)
      tmux capture-pane -p -J -S "$start_from" -t "$server_pane_id" >"$SERVER_CAPTURE_FILE"
      echo "$SERVER_CAPTURE_FILE"
      ;;
    client)
      tmux capture-pane -p -J -S "$start_from" -t "$client_pane_id" >"$CLIENT_CAPTURE_FILE"
      echo "$CLIENT_CAPTURE_FILE"
      ;;
    both)
      tmux capture-pane -p -J -S "$start_from" -t "$server_pane_id" >"$SERVER_CAPTURE_FILE"
      tmux capture-pane -p -J -S "$start_from" -t "$client_pane_id" >"$CLIENT_CAPTURE_FILE"
      echo "$SERVER_CAPTURE_FILE"
      echo "$CLIENT_CAPTURE_FILE"
      ;;
    *)
      echo "invalid capture target: $target" >&2
      exit 1
      ;;
  esac
}

teardown() {
  require_tool tmux
  if session_exists; then
    tmux kill-session -t "$SESSION_NAME"
  fi
  rm -rf "$STATE_DIR"
  echo "removed session and state: $SESSION_NAME"
}

up() {
  require_tool tmux
  require_tool node

  if ! session_exists; then
    start_session
  fi
  attach_session
}

main() {
  local cmd="${1:-up}"
  case "$cmd" in
    up|start)
      up
      ;;
    attach)
      require_tool tmux
      if ! session_exists; then
        echo "session not found: $SESSION_NAME" >&2
        exit 1
      fi
      attach_session
      ;;
    status)
      status
      ;;
    capture)
      shift
      capture "$@"
      ;;
    teardown|down|clean)
      teardown
      ;;
    help|-h|--help)
      usage
      ;;
    *)
      echo "unknown command: $cmd" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
