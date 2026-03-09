#!/usr/bin/env bash

set -euo pipefail

SEARCH="${SYNC_CODER_SEARCH:-owner:me}"
REMOTE_REPO="${SYNC_CODER_REMOTE_REPO:-\$HOME/dotai}"
REMOTE_CONFIG="${SYNC_CODER_REMOTE_CONFIG:-\$HOME/.config/opencode/opencode.jsonc}"
OLD_IP="${SYNC_CODER_OLD_IP:-100.100.1.116}"
NEW_IP="${SYNC_CODER_NEW_IP:-192.168.1.116}"
PARALLEL="${SYNC_CODER_PARALLEL:-4}"
PULL_TIMEOUT="${SYNC_CODER_PULL_TIMEOUT:-5m}"
INSTALL_TIMEOUT="${SYNC_CODER_INSTALL_TIMEOUT:-10m}"
PACKAGE_TIMEOUT="${SYNC_CODER_PACKAGE_TIMEOUT:-20m}"
RESTART_TIMEOUT="${SYNC_CODER_RESTART_TIMEOUT:-30m}"
DRY_RUN=false
SKIP_RESTART=false
FULL_RESTART=false
declare -a WORKSPACES=()
declare -a SKIPPED_WORKSPACES=()

log_info() {
  printf '[INFO] %s\n' "$1"
}

log_error() {
  printf '[ERROR] %s\n' "$1" >&2
}

usage() {
  cat <<EOF
Usage: $0 [OPTIONS]

Options:
  --workspace NAME       Sync only this workspace (repeatable)
  --search QUERY         Coder search query (default: $SEARCH)
  --repo PATH            Remote dotai path (default: $REMOTE_REPO)
  --config PATH          Remote opencode config path (default: $REMOTE_CONFIG)
  --old-ip IP            Source IP to replace (default: $OLD_IP)
  --new-ip IP            Target IP (default: $NEW_IP)
  --parallel N           Concurrent workspace operations (default: $PARALLEL)
  --restart              Do full workspace restart via coder restart
  --skip-restart         Skip any restart phase
  --dry-run              Print commands without executing them
  -h, --help             Show this help message

Environment:
  SYNC_CODER_SEARCH
  SYNC_CODER_REMOTE_REPO
  SYNC_CODER_REMOTE_CONFIG
  SYNC_CODER_OLD_IP
  SYNC_CODER_NEW_IP
  SYNC_CODER_PARALLEL
  SYNC_CODER_PULL_TIMEOUT
  SYNC_CODER_INSTALL_TIMEOUT
  SYNC_CODER_PACKAGE_TIMEOUT
  SYNC_CODER_RESTART_TIMEOUT
EOF
}

require_commands() {
  local cmd
  for cmd in coder jq; do
    command -v "$cmd" >/dev/null 2>&1 || {
      log_error "$cmd is required"
      exit 1
    }
  done
}

timeout_wrapper() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$@"
    return
  fi

  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$@"
    return
  fi

  shift
  "$@"
}

escape_dq() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

escape_sed_pattern() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//./\\.}"
  value="${value//\//\\/}"
  printf '%s' "$value"
}

escape_sed_replacement() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//&/\\&}"
  value="${value//\//\\/}"
  printf '%s' "$value"
}

sanitize_name() {
  local value="$1"
  value="${value//\//_}"
  value="${value// /_}"
  printf '%s' "$value"
}

array_contains() {
  local needle="$1"
  shift
  local value

  for value in "$@"; do
    if [[ "$value" == "$needle" ]]; then
      return 0
    fi
  done

  return 1
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --workspace)
      [[ $# -ge 2 ]] || {
        log_error "--workspace requires a value"
        exit 1
      }
      WORKSPACES+=("$2")
      shift
      ;;
    --search)
      [[ $# -ge 2 ]] || {
        log_error "--search requires a value"
        exit 1
      }
      SEARCH="$2"
      shift
      ;;
    --repo)
      [[ $# -ge 2 ]] || {
        log_error "--repo requires a value"
        exit 1
      }
      REMOTE_REPO="$2"
      shift
      ;;
    --config)
      [[ $# -ge 2 ]] || {
        log_error "--config requires a value"
        exit 1
      }
      REMOTE_CONFIG="$2"
      shift
      ;;
    --old-ip)
      [[ $# -ge 2 ]] || {
        log_error "--old-ip requires a value"
        exit 1
      }
      OLD_IP="$2"
      shift
      ;;
    --new-ip)
      [[ $# -ge 2 ]] || {
        log_error "--new-ip requires a value"
        exit 1
      }
      NEW_IP="$2"
      shift
      ;;
    --parallel)
      [[ $# -ge 2 ]] || {
        log_error "--parallel requires a value"
        exit 1
      }
      PARALLEL="$2"
      shift
      ;;
    --skip-restart)
      SKIP_RESTART=true
      ;;
    --restart)
      FULL_RESTART=true
      ;;
    --dry-run)
      DRY_RUN=true
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      log_error "Unknown option: $1"
      usage
      exit 1
      ;;
    esac

    shift
  done
}

validate_parallel() {
  [[ "$PARALLEL" =~ ^[1-9][0-9]*$ ]] || {
    log_error "--parallel must be a positive integer"
    exit 1
  }
}

discover_workspaces() {
  if [[ ${#WORKSPACES[@]} -gt 0 ]]; then
    printf '%s\n' "${WORKSPACES[@]}"
    return 0
  fi

  coder list -o json --search "$SEARCH" | jq -r '.[] | "\(.owner_name)/\(.name // .latest_build.workspace_name)"'
}

list_workspace_states() {
  coder list -o json --search "$SEARCH" | jq -r '
    .[]
    | [
        "\(.owner_name)/\(.name // .latest_build.workspace_name)",
        (.latest_build.transition // ""),
        (
          if any(.latest_build.resources[]?.agents[]?; .status == "connected" or .status == "connecting" or .lifecycle_state == "ready")
          then "true"
          else "false"
          end
        )
      ]
    | @tsv
  '
}

filter_stopped_workspaces() {
  local workspace known_workspace transition reachable
  local all_workspaces=()
  local active_workspaces=()
  local filtered_workspaces=()

  while IFS=$'\t' read -r known_workspace transition reachable; do
    [[ -n "$known_workspace" ]] || continue
    all_workspaces+=("$known_workspace")

    if [[ "$transition" == "start" && "$reachable" == "true" ]]; then
      active_workspaces+=("$known_workspace")
    fi
  done < <(list_workspace_states)

  SKIPPED_WORKSPACES=()
  filtered_workspaces=()

  for workspace in "${WORKSPACES[@]}"; do
    if array_contains "$workspace" "${all_workspaces[@]}" && ! array_contains "$workspace" "${active_workspaces[@]}"; then
      SKIPPED_WORKSPACES+=("$workspace")
      continue
    fi

    filtered_workspaces+=("$workspace")
  done

  WORKSPACES=("${filtered_workspaces[@]}")
}

build_remote_update_command() {
  local repo config config_dir old_ip new_ip old_ip_pattern new_ip_replacement
  repo="$(escape_dq "$REMOTE_REPO")"
  config="$(escape_dq "$REMOTE_CONFIG")"
  config_dir="$(escape_dq "$(dirname "$REMOTE_CONFIG")")"
  old_ip="$(escape_dq "$OLD_IP")"
  new_ip="$(escape_dq "$NEW_IP")"
  old_ip_pattern="$(escape_sed_pattern "$OLD_IP")"
  new_ip_replacement="$(escape_sed_replacement "$NEW_IP")"

  printf 'set -euo pipefail; run_with_timeout() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; return; fi; if command -v gtimeout >/dev/null 2>&1; then gtimeout "$@"; return; fi; shift; "$@"; }; REPO_DIR="%s"; CONFIG_PATH="%s"; CONFIG_DIR="%s"; run_with_timeout %s git -C "$REPO_DIR" pull --ff-only; run_with_timeout 1m rm -rf "$CONFIG_DIR"; DOTAI_NONINTERACTIVE=1 run_with_timeout %s bash "$REPO_DIR/install.sh" --non-interactive; run_with_timeout 1m sed -i "s/%s/%s/g" "$CONFIG_PATH"; run_with_timeout 1m jq -R -s -e --arg new_ip "%s" --arg old_ip "%s" '\''contains($new_ip) and (contains($old_ip) | not)'\'' "$CONFIG_PATH" >/dev/null; run_with_timeout %s bun install -g opencode-ai@latest @openchamber/web@latest' \
    "$repo" "$config" "$config_dir" "$PULL_TIMEOUT" "$INSTALL_TIMEOUT" "$old_ip_pattern" "$new_ip_replacement" "$new_ip" "$old_ip" "$PACKAGE_TIMEOUT"
}

build_remote_restart_command() {
  cat <<'EOF'
set -euo pipefail; run_with_timeout() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; return; fi; if command -v gtimeout >/dev/null 2>&1; then gtimeout "$@"; return; fi; shift; "$@"; }; query_process_pid() { local process_pattern="$1"; local selection="${2:-oldest}"; local pid=""; if command -v pgrep >/dev/null 2>&1; then if [[ "$selection" == "newest" ]]; then pid="$(pgrep -fn "$process_pattern" || true)"; else pid="$(pgrep -fo "$process_pattern" || true)"; fi; fi; if [[ -z "$pid" ]]; then if [[ "$selection" == "newest" ]]; then pid="$(ps -eo pid=,args= | awk -v pattern="$process_pattern" '$0 ~ pattern && $0 !~ /awk/ { pid=$1 } END { if (pid) print pid }' || true)"; else pid="$(ps -eo pid=,args= | awk -v pattern="$process_pattern" '$0 ~ pattern && $0 !~ /awk/ { print $1; exit }' || true)"; fi; fi; printf '%s' "$pid"; }; find_process_pid() { local process_name="$1"; local process_pattern="$2"; local selection="${3:-oldest}"; local pid=""; pid="$(query_process_pid "$process_pattern" "$selection")"; [[ -n "$pid" ]] || { printf '%s process not found\n' "$process_name" >&2; return 1; }; printf '%s\n' "$pid"; }; restart_process() { local process_name="$1"; local process_pattern="$2"; local before_pid after_pid attempt; before_pid="$(find_process_pid "$process_name" "$process_pattern" oldest)"; kill -HUP "$before_pid"; after_pid=""; for attempt in 1 2 3 4 5; do sleep 0.1; after_pid="$(query_process_pid "$process_pattern" newest)"; if [[ -n "$after_pid" && "$after_pid" != "$before_pid" ]]; then break; fi; done; [[ -n "$after_pid" && "$after_pid" != "$before_pid" ]] || { printf '%s pid did not change after restart (old=%s new=%s)\n' "$process_name" "$before_pid" "${after_pid:-missing}" >&2; return 1; }; }; restart_process OpenCode '(^|.*/)opencode([[:space:]]|$)|opencode.*(serve|server)'; restart_process OpenChamber '(^|.*/)openchamber([[:space:]]|$)|openchamber.*(serve|server)'
EOF
}

run_update_workspace() {
  local workspace="$1"
  local command
  command="$(build_remote_update_command)"

  if [[ "$DRY_RUN" == true ]]; then
    printf 'coder ssh %s %s\n' "$workspace" "$command"
    return 0
  fi

  coder ssh "$workspace" "$command"
}

run_restart_workspace() {
  local workspace="$1"
  local command

  if [[ "$FULL_RESTART" == true ]]; then
    if [[ "$DRY_RUN" == true ]]; then
      printf 'coder restart -y %s\n' "$workspace"
      return 0
    fi

    timeout_wrapper "$RESTART_TIMEOUT" coder restart -y "$workspace"
    return 0
  fi

  command="$(build_remote_restart_command)"

  if [[ "$DRY_RUN" == true ]]; then
    printf 'coder ssh %s %s\n' "$workspace" "$command"
    return 0
  fi

  timeout_wrapper "$RESTART_TIMEOUT" coder ssh "$workspace" "$command"
}

run_parallel_phase() {
  local phase="$1"
  shift
  local temp_dir active pid workspace log_file failed i
  local pids=()
  local phase_workspaces=()
  local phase_logs=()

  temp_dir="$(mktemp -d)"
  failed=0

  for workspace in "$@"; do
    while true; do
      active=$(jobs -pr | wc -l | tr -d ' ')
      if (( active < PARALLEL )); then
        break
      fi
      sleep 0.1
    done

    log_file="$temp_dir/$(sanitize_name "$workspace").log"

    if [[ "$phase" == "update" ]]; then
      run_update_workspace "$workspace" >"$log_file" 2>&1 &
    else
      run_restart_workspace "$workspace" >"$log_file" 2>&1 &
    fi

    pid=$!
    pids+=("$pid")
    phase_workspaces+=("$workspace")
    phase_logs+=("$log_file")
    log_info "Started $phase for $workspace"
  done

  for ((i = 0; i < ${#pids[@]}; i++)); do
    pid="${pids[$i]}"
    workspace="${phase_workspaces[$i]}"
    log_file="${phase_logs[$i]}"

    if wait "$pid"; then
      log_info "$phase succeeded for $workspace"
    else
      failed=1
      log_error "$phase failed for $workspace"
    fi

    if [[ -f "$log_file" ]]; then
      cat "$log_file"
    fi
  done

  rm -rf "$temp_dir"
  return "$failed"
}

main() {
  local workspace

  parse_args "$@"
  require_commands
  validate_parallel

  if [[ ${#WORKSPACES[@]} -eq 0 ]]; then
    while IFS= read -r workspace; do
      [[ -n "$workspace" ]] || continue
      WORKSPACES+=("$workspace")
    done < <(discover_workspaces)
  fi

  if [[ ${#WORKSPACES[@]} -eq 0 ]]; then
    log_error "No workspaces found"
    exit 1
  fi

  filter_stopped_workspaces

  for workspace in "${SKIPPED_WORKSPACES[@]}"; do
    log_info "Skipping stopped workspace $workspace"
  done

  if [[ ${#WORKSPACES[@]} -eq 0 ]]; then
    log_info "No running workspaces to sync"
    return 0
  fi

  log_info "Syncing ${#WORKSPACES[@]} workspace(s)"
  run_parallel_phase update "${WORKSPACES[@]}"

  if [[ "$SKIP_RESTART" == true ]]; then
    log_info "Skipping restarts"
    return 0
  fi

  run_parallel_phase restart "${WORKSPACES[@]}"
}

main "$@"
