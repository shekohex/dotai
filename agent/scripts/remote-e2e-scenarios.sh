#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BASE_SESSION_NAME="${PI_REMOTE_E2E_SESSION:-pi-remote-e2e}"
BASE_PORT="${PI_REMOTE_E2E_PORT:-3141}"
BASE_URL_PREFIX="${PI_REMOTE_E2E_URL_PREFIX:-http://127.0.0.1}"
HARNESS="${ROOT_DIR}/scripts/remote-e2e-direct-tmux.sh"
SCENARIO_ROOT="${ROOT_DIR}/.pi/remote-e2e/scenario-runs"

usage() {
  cat <<EOF
Usage:
  scripts/remote-e2e-scenarios.sh run <scenario>
  scripts/remote-e2e-scenarios.sh list

Scenarios:
  normal
  large-stream
  hot-bash
  reconnect-mid-stream
  reconnect-after-completion
  restart-recovery
  queue-interrupt
  fork
  switch-session
  extension-ui
  clone
  extra-attach
  fanout
  memory-bound
EOF
}

scenario_port() {
  local scenario="$1"
  case "$scenario" in
    normal) echo 3151 ;;
    large-stream) echo 3152 ;;
    hot-bash) echo 3153 ;;
    reconnect-mid-stream) echo 3154 ;;
    reconnect-after-completion) echo 3155 ;;
    restart-recovery) echo 3156 ;;
    queue-interrupt) echo 3157 ;;
    fork) echo 3158 ;;
    switch-session) echo 3159 ;;
    extension-ui) echo 3160 ;;
    clone) echo 3161 ;;
    extra-attach) echo 3162 ;;
    fanout) echo 3163 ;;
    memory-bound) echo 3164 ;;
    *)
      echo "unknown scenario: $scenario" >&2
      exit 1
      ;;
  esac
}

scenario_session_name() {
  local scenario="$1"
  echo "${BASE_SESSION_NAME}-${scenario}"
}

scenario_url() {
  local scenario="$1"
  echo "${BASE_URL_PREFIX}:$(scenario_port "$scenario")"
}

scenario_dir() {
  local scenario="$1"
  echo "${SCENARIO_ROOT}/${scenario}"
}

wait_for_tui() {
  local capture_file="$1"
  local attempts="${2:-60}"

  for ((index = 0; index < attempts; index += 1)); do
    if [[ -f "$capture_file" ]] && grep -Eq 'ctx .*wk|What should|What are we|What needs|Point me at' "$capture_file"; then
      return
    fi
    sleep 1
  done

  echo "tui did not become ready: $capture_file" >&2
  exit 1
}

wait_for_visible_text() {
  local scenario="$1"
  local target="$2"
  local pattern="$3"
  PI_REMOTE_E2E_SESSION="$(scenario_session_name "$scenario")" \
    PI_REMOTE_E2E_PORT="$(scenario_port "$scenario")" \
    PI_REMOTE_E2E_REMOTE_URL="$(scenario_url "$scenario")" \
    "$HARNESS" wait-contains "$target" "$pattern" >/dev/null
}

seed_prompt_stash() {
  local text="$1"
  local created_at
  created_at="$(date +%s000)"
  local escaped_text
  escaped_text="$(printf '%s' "$text" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  npm exec --yes -- node --import tsx --input-type=module <<EOF
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getStashFilePath } from "./src/extensions/prompt-stash/storage.ts";

const stashFilePath = getStashFilePath();
await mkdir(dirname(stashFilePath), { recursive: true });
await writeFile(
  stashFilePath,
  JSON.stringify({
    version: 1,
    id: "remote-e2e-entry",
    text: ${escaped_text},
    createdAt: ${created_at},
  }) + "\\n",
  "utf8",
);
console.log(stashFilePath);
EOF
}

capture_target() {
  local scenario="$1"
  local target="$2"
  local destination="$3"
  PI_REMOTE_E2E_SESSION="$(scenario_session_name "$scenario")" \
    PI_REMOTE_E2E_PORT="$(scenario_port "$scenario")" \
    PI_REMOTE_E2E_REMOTE_URL="$(scenario_url "$scenario")" \
    "$HARNESS" capture "$target" >/dev/null

  local source
  case "$target" in
    remote-server) source="${ROOT_DIR}/.pi/remote-e2e/$(scenario_session_name "$scenario")/logs/remote-server.capture.log" ;;
    remote-client) source="${ROOT_DIR}/.pi/remote-e2e/$(scenario_session_name "$scenario")/logs/remote-client.capture.log" ;;
    local) source="${ROOT_DIR}/.pi/remote-e2e/$(scenario_session_name "$scenario")/logs/local.capture.log" ;;
    *)
      echo "unknown capture target: $target" >&2
      exit 1
      ;;
  esac
  cp "$source" "$destination"
}

send_remote() {
  local scenario="$1"
  local prompt="$2"
  PI_REMOTE_E2E_SESSION="$(scenario_session_name "$scenario")" \
    PI_REMOTE_E2E_PORT="$(scenario_port "$scenario")" \
    PI_REMOTE_E2E_REMOTE_URL="$(scenario_url "$scenario")" \
    "$HARNESS" send-remote "$prompt"
}

send_local() {
  local scenario="$1"
  local prompt="$2"
  PI_REMOTE_E2E_SESSION="$(scenario_session_name "$scenario")" \
    PI_REMOTE_E2E_PORT="$(scenario_port "$scenario")" \
    PI_REMOTE_E2E_REMOTE_URL="$(scenario_url "$scenario")" \
    "$HARNESS" send-local "$prompt"
}

restart_remote() {
  local scenario="$1"
  PI_REMOTE_E2E_SESSION="$(scenario_session_name "$scenario")" \
    PI_REMOTE_E2E_PORT="$(scenario_port "$scenario")" \
    PI_REMOTE_E2E_REMOTE_URL="$(scenario_url "$scenario")" \
    "$HARNESS" restart-remote
}

restart_server() {
  local scenario="$1"
  PI_REMOTE_E2E_SESSION="$(scenario_session_name "$scenario")" \
    PI_REMOTE_E2E_PORT="$(scenario_port "$scenario")" \
    PI_REMOTE_E2E_REMOTE_URL="$(scenario_url "$scenario")" \
    "$HARNESS" restart-server
}

send_remote_keys() {
  local scenario="$1"
  shift
  PI_REMOTE_E2E_SESSION="$(scenario_session_name "$scenario")" \
    PI_REMOTE_E2E_PORT="$(scenario_port "$scenario")" \
    PI_REMOTE_E2E_REMOTE_URL="$(scenario_url "$scenario")" \
    "$HARNESS" send-remote-keys "$@"
}

start_extra_remote() {
  local scenario="$1"
  shift
  PI_REMOTE_E2E_SESSION="$(scenario_session_name "$scenario")" \
    PI_REMOTE_E2E_PORT="$(scenario_port "$scenario")" \
    PI_REMOTE_E2E_REMOTE_URL="$(scenario_url "$scenario")" \
    "$HARNESS" start-extra-remote "$@"
}

create_remote_session() {
  local scenario="$1"
  local session_name="$2"
  local output_file="$3"
  local origin
  origin="$(scenario_url "$scenario")"
  ORIGIN="$origin" \
  PRIVATE_KEY_PEM=$'-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEINB1KC9CGcvJ2KV9iSPqaE//4Bm2DIt+gBJrg2SZR92F\n-----END PRIVATE KEY-----' \
  SESSION_NAME="$session_name" \
  npm exec --yes -- node --input-type=module <<'EOF' >"$output_file"
import { createPrivateKey, randomBytes, sign } from "node:crypto";

const origin = process.env.ORIGIN;
const privateKeyPem = process.env.PRIVATE_KEY_PEM;
const sessionName = process.env.SESSION_NAME;
if (origin === undefined || privateKeyPem === undefined || sessionName === undefined) {
  throw new Error("missing remote session creation environment");
}
const privateKey = createPrivateKey(privateKeyPem);
const createChallengePayload = (input) =>
  [input.challengeId, input.keyId, input.nonce, input.origin, String(input.expiresAt)].join(":");

const challengeResponse = await fetch(origin + "/v1/auth/challenge", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ keyId: "alice" }),
});
const challenge = await challengeResponse.json();
const payload = Buffer.from(
  createChallengePayload({
    challengeId: challenge.challengeId,
    keyId: "alice",
    nonce: challenge.nonce,
    origin: challenge.origin,
    expiresAt: challenge.expiresAt,
  }),
);
const signature = sign(null, payload, privateKey).toString("base64");
const verifyResponse = await fetch(origin + "/v1/auth/verify", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    challengeId: challenge.challengeId,
    keyId: "alice",
    signature,
  }),
});
const verified = await verifyResponse.json();
const createResponse = await fetch(origin + "/v1/sessions", {
  method: "POST",
  headers: {
    authorization: "Bearer " + verified.token,
    "content-type": "application/json",
    "x-pi-connection-id": randomBytes(18).toString("base64url"),
  },
  body: JSON.stringify({ sessionName }),
});
const created = await createResponse.json();
process.stdout.write(created.sessionId);
EOF
}

server_rss_kb() {
  local scenario="$1"
  local server_pid
  server_pid="$(
    PI_REMOTE_E2E_SESSION="$(scenario_session_name "$scenario")" \
      PI_REMOTE_E2E_PORT="$(scenario_port "$scenario")" \
      PI_REMOTE_E2E_REMOTE_URL="$(scenario_url "$scenario")" \
      "$HARNESS" server-pid
  )"
  ps -o rss= -p "$server_pid" | tr -d ' '
}

up_scenario() {
  local scenario="$1"
  local dir
  dir="$(scenario_dir "$scenario")"
  rm -rf "$dir"
  mkdir -p "$dir"
  PI_REMOTE_E2E_SESSION="$(scenario_session_name "$scenario")" \
    PI_REMOTE_E2E_PORT="$(scenario_port "$scenario")" \
    PI_REMOTE_E2E_REMOTE_URL="$(scenario_url "$scenario")" \
    "$HARNESS" teardown >/dev/null 2>&1 || true
  PI_REMOTE_E2E_SESSION="$(scenario_session_name "$scenario")" \
    PI_REMOTE_E2E_PORT="$(scenario_port "$scenario")" \
    PI_REMOTE_E2E_REMOTE_URL="$(scenario_url "$scenario")" \
    "$HARNESS" up >/dev/null
  sleep 8
  capture_target "$scenario" remote-client "${dir}/boot-remote-client.log"
  capture_target "$scenario" local "${dir}/boot-local.log"
  wait_for_tui "${dir}/boot-remote-client.log"
  wait_for_visible_text "$scenario" remote-client "ctx "
  wait_for_visible_text "$scenario" local "ctx "
}

down_scenario() {
  local scenario="$1"
  PI_REMOTE_E2E_SESSION="$(scenario_session_name "$scenario")" \
    PI_REMOTE_E2E_PORT="$(scenario_port "$scenario")" \
    PI_REMOTE_E2E_REMOTE_URL="$(scenario_url "$scenario")" \
    "$HARNESS" teardown >/dev/null 2>&1 || true
}

run_normal() {
  local scenario="normal"
  local dir
  dir="$(scenario_dir "$scenario")"
  up_scenario "$scenario"
  send_remote "$scenario" "Say hello in one sentence."
  send_local "$scenario" "Say hello in one sentence."
  wait_for_visible_text "$scenario" remote-client "Say hello in one sentence."
  wait_for_visible_text "$scenario" remote-client "Hello"
  wait_for_visible_text "$scenario" local "Hello"
  capture_target "$scenario" remote-client "${dir}/remote-client.log"
  capture_target "$scenario" local "${dir}/local.log"
  capture_target "$scenario" remote-server "${dir}/remote-server.log"
  down_scenario "$scenario"
}

run_large_stream() {
  local scenario="large-stream"
  local dir
  dir="$(scenario_dir "$scenario")"
  up_scenario "$scenario"
  send_remote "$scenario" "Write numbers 1 through 40, one per line, with no extra text."
  wait_for_visible_text "$scenario" remote-client "1"
  wait_for_visible_text "$scenario" remote-client "40"
  capture_target "$scenario" remote-client "${dir}/remote-client.log"
  capture_target "$scenario" remote-server "${dir}/remote-server.log"
  down_scenario "$scenario"
}

run_hot_bash() {
  local scenario="hot-bash"
  local dir
  dir="$(scenario_dir "$scenario")"
  up_scenario "$scenario"
  send_remote "$scenario" '!for i in $(seq 1 12); do echo remote-hot-$i; sleep 0.2; done'
  wait_for_visible_text "$scenario" remote-client "remote-hot-1"
  wait_for_visible_text "$scenario" remote-client "remote-hot-12"
  capture_target "$scenario" remote-client "${dir}/remote-client.log"
  capture_target "$scenario" remote-server "${dir}/remote-server.log"
  down_scenario "$scenario"
}

run_reconnect_mid_stream() {
  local scenario="reconnect-mid-stream"
  local dir
  dir="$(scenario_dir "$scenario")"
  up_scenario "$scenario"
  send_remote "$scenario" "Write numbers 1 through 200, one per line, with no extra text."
  wait_for_visible_text "$scenario" remote-client "1"
  restart_remote "$scenario"
  wait_for_visible_text "$scenario" remote-client "200"
  capture_target "$scenario" remote-client "${dir}/remote-client.log"
  capture_target "$scenario" remote-server "${dir}/remote-server.log"
  down_scenario "$scenario"
}

run_reconnect_after_completion() {
  local scenario="reconnect-after-completion"
  local dir
  dir="$(scenario_dir "$scenario")"
  up_scenario "$scenario"
  send_remote "$scenario" "Say hello in one sentence."
  wait_for_visible_text "$scenario" remote-client "Hello"
  restart_remote "$scenario"
  wait_for_visible_text "$scenario" remote-client "Hello"
  capture_target "$scenario" remote-client "${dir}/remote-client.log"
  capture_target "$scenario" remote-server "${dir}/remote-server.log"
  down_scenario "$scenario"
}

run_restart_recovery() {
  local scenario="restart-recovery"
  local dir
  dir="$(scenario_dir "$scenario")"
  up_scenario "$scenario"
  restart_server "$scenario"
  restart_remote "$scenario"
  wait_for_visible_text "$scenario" remote-client "ctx "
  capture_target "$scenario" remote-client "${dir}/remote-client.log"
  capture_target "$scenario" remote-server "${dir}/remote-server.log"
  down_scenario "$scenario"
}

run_queue_interrupt() {
  local scenario="queue-interrupt"
  local dir
  dir="$(scenario_dir "$scenario")"
  up_scenario "$scenario"
  send_remote "$scenario" "Count from 1 to 500 with one item per line."
  wait_for_visible_text "$scenario" remote-client "1"
  send_remote "$scenario" "After current answer, say queued-finished."
  sleep 1
  send_remote_keys "$scenario" Escape
  wait_for_visible_text "$scenario" remote-client "Operation aborted"
  capture_target "$scenario" remote-client "${dir}/remote-client.log"
  capture_target "$scenario" remote-server "${dir}/remote-server.log"
  down_scenario "$scenario"
}

run_fork() {
  local scenario="fork"
  local dir
  dir="$(scenario_dir "$scenario")"
  up_scenario "$scenario"
  send_remote "$scenario" "Say fork-source in one sentence."
  wait_for_visible_text "$scenario" remote-client "fork-source"
  send_remote "$scenario" "/fork"
  wait_for_visible_text "$scenario" remote-client "fork-source"
  capture_target "$scenario" remote-client "${dir}/remote-client.log"
  capture_target "$scenario" remote-server "${dir}/remote-server.log"
  down_scenario "$scenario"
}

run_switch_session() {
  local scenario="switch-session"
  local dir
  local target_session_id
  local extra_log
  dir="$(scenario_dir "$scenario")"
  up_scenario "$scenario"
  create_remote_session "$scenario" "switch-target" "${dir}/target-session.id"
  target_session_id="$(cat "${dir}/target-session.id")"
  start_extra_remote "$scenario" switch-session --session "$target_session_id" >/dev/null
  extra_log="${ROOT_DIR}/.pi/remote-e2e/$(scenario_session_name "$scenario")/logs/switch-session.log"
  for _ in $(seq 1 30); do
    if [[ -f "$extra_log" ]] && grep -Eq 'ctx |What should I' "$extra_log"; then
      break
    fi
    sleep 1
  done
  cp "$extra_log" "${dir}/switch-session.log"
  capture_target "$scenario" remote-server "${dir}/remote-server.log"
  down_scenario "$scenario"
}

run_extension_ui() {
  local scenario="extension-ui"
  local dir
  dir="$(scenario_dir "$scenario")"
  up_scenario "$scenario"
  seed_prompt_stash "remote stash entry for extension ui proof" >/dev/null
  send_remote "$scenario" "/stash"
  wait_for_visible_text "$scenario" remote-client "Prompt Stash"
  send_remote_keys "$scenario" Enter
  wait_for_visible_text "$scenario" remote-client "Opened stash entry"
  capture_target "$scenario" remote-client "${dir}/remote-client.log"
  capture_target "$scenario" remote-server "${dir}/remote-server.log"
  down_scenario "$scenario"
}

run_clone() {
  local scenario="clone"
  local dir
  dir="$(scenario_dir "$scenario")"
  up_scenario "$scenario"
  send_remote "$scenario" "Say clone-source in one sentence."
  wait_for_visible_text "$scenario" remote-client "clone-source"
  send_remote "$scenario" "/clone"
  wait_for_visible_text "$scenario" remote-client "clone-source"
  capture_target "$scenario" remote-client "${dir}/remote-client.log"
  capture_target "$scenario" remote-server "${dir}/remote-server.log"
  down_scenario "$scenario"
}

run_extra_attach() {
  local scenario="extra-attach"
  local dir
  dir="$(scenario_dir "$scenario")"
  up_scenario "$scenario"
  start_extra_remote "$scenario" extra-attach --continue >/dev/null
  wait_for_visible_text "$scenario" remote-client "What should I"
  capture_target "$scenario" remote-client "${dir}/remote-client.log"
  capture_target "$scenario" remote-server "${dir}/remote-server.log"
  cp "${ROOT_DIR}/.pi/remote-e2e/$(scenario_session_name "$scenario")/logs/extra-attach.log" "${dir}/extra-attach.log"
  down_scenario "$scenario"
}

run_fanout() {
  local scenario="fanout"
  local dir
  local state_dir
  local extra_pane
  dir="$(scenario_dir "$scenario")"
  state_dir="${ROOT_DIR}/.pi/remote-e2e/$(scenario_session_name "$scenario")"
  up_scenario "$scenario"
  tmux new-window -d -t "$(scenario_session_name "$scenario")" -n fanout -c "$ROOT_DIR"
  extra_pane="$(tmux display-message -p -t "$(scenario_session_name "$scenario"):fanout" "#{pane_id}")"
  tmux pipe-pane -o -t "$extra_pane" "cat >> ${dir}/fanout-second-client.log"
  tmux send-keys -t "$extra_pane" "cd ${ROOT_DIR@Q} && npm run pi:remote -- --remote-url $(scenario_url "$scenario") --identity bob --workspace-cwd $(head -n 1 "${state_dir}/workspace-cwd.path") --continue" Enter
  wait_for_visible_text "$scenario" remote-client "What should I"
  capture_target "$scenario" remote-server "${dir}/remote-server.log"
  down_scenario "$scenario"
}

run_memory_bound() {
  local scenario="memory-bound"
  local dir
  local before_values=()
  local after_values=()
  local tail_values=()
  dir="$(scenario_dir "$scenario")"
  up_scenario "$scenario"
  for index in 1 2 3 4 5 6; do
    before_values+=("$(server_rss_kb "$scenario")")
    send_remote "$scenario" "!for i in \$(seq 1 30); do echo burst-${index}-\$i; sleep 0.05; done"
    wait_for_visible_text "$scenario" remote-client "burst-${index}-30"
    after_values+=("$(server_rss_kb "$scenario")")
  done
  tail_values=("${after_values[@]:1}")
  local tail_min="${tail_values[0]}"
  local tail_max="${tail_values[0]}"
  for value in "${tail_values[@]}"; do
    if (( value < tail_min )); then
      tail_min="$value"
    fi
    if (( value > tail_max )); then
      tail_max="$value"
    fi
  done
  local tail_spread_kb=$((tail_max - tail_min))
  {
    for index in "${!before_values[@]}"; do
      printf 'before_%s_kb=%s\n' "$((index + 1))" "${before_values[$index]}"
      printf 'after_%s_kb=%s\n' "$((index + 1))" "${after_values[$index]}"
    done
    printf 'tail_min_kb=%s\n' "$tail_min"
    printf 'tail_max_kb=%s\n' "$tail_max"
    printf 'tail_spread_kb=%s\n' "$tail_spread_kb"
  } >"${dir}/memory.log"
  if (( tail_spread_kb > 131072 )); then
    echo "memory plateau spread too large: ${tail_spread_kb}kb" >&2
    exit 1
  fi
  capture_target "$scenario" remote-client "${dir}/remote-client.log"
  capture_target "$scenario" remote-server "${dir}/remote-server.log"
  down_scenario "$scenario"
}

main() {
  local command="${1:-}"
  local scenario="${2:-}"

  case "$command" in
    list)
      printf '%s\n' normal large-stream hot-bash reconnect-after-completion restart-recovery fanout
      printf '%s\n' reconnect-mid-stream queue-interrupt fork switch-session extension-ui clone extra-attach memory-bound
      ;;
    run)
      case "$scenario" in
        normal) run_normal ;;
        large-stream) run_large_stream ;;
        hot-bash) run_hot_bash ;;
        reconnect-mid-stream) run_reconnect_mid_stream ;;
        reconnect-after-completion) run_reconnect_after_completion ;;
        restart-recovery) run_restart_recovery ;;
        queue-interrupt) run_queue_interrupt ;;
        fork) run_fork ;;
        switch-session) run_switch_session ;;
        extension-ui) run_extension_ui ;;
        clone) run_clone ;;
        extra-attach) run_extra_attach ;;
        fanout) run_fanout ;;
        memory-bound) run_memory_bound ;;
        *) usage; exit 1 ;;
      esac
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
