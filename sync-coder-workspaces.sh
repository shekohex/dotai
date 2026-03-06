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

build_remote_update_command() {
  local repo config old_ip new_ip old_ip_pattern new_ip_replacement
  repo="$(escape_dq "$REMOTE_REPO")"
  config="$(escape_dq "$REMOTE_CONFIG")"
  old_ip="$(escape_dq "$OLD_IP")"
  new_ip="$(escape_dq "$NEW_IP")"
  old_ip_pattern="$(escape_sed_pattern "$OLD_IP")"
  new_ip_replacement="$(escape_sed_replacement "$NEW_IP")"

  printf 'set -euo pipefail; run_with_timeout() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; return; fi; if command -v gtimeout >/dev/null 2>&1; then gtimeout "$@"; return; fi; shift; "$@"; }; REPO_DIR="%s"; CONFIG_PATH="%s"; run_with_timeout %s git -C "$REPO_DIR" pull --ff-only; DOTAI_NONINTERACTIVE=1 run_with_timeout %s bash "$REPO_DIR/install.sh" --non-interactive; run_with_timeout 1m sed -i "s/%s/%s/g" "$CONFIG_PATH"; run_with_timeout 1m jq -R -s -e --arg new_ip "%s" --arg old_ip "%s" '\''contains($new_ip) and (contains($old_ip) | not)'\'' "$CONFIG_PATH" >/dev/null; run_with_timeout %s bun install -g opencode-ai@latest @openchamber/web@latest' \
    "$repo" "$config" "$PULL_TIMEOUT" "$INSTALL_TIMEOUT" "$old_ip_pattern" "$new_ip_replacement" "$new_ip" "$old_ip" "$PACKAGE_TIMEOUT"
}

build_remote_restart_command() {
  printf 'set -euo pipefail; run_with_timeout() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; return; fi; if command -v gtimeout >/dev/null 2>&1; then gtimeout "$@"; return; fi; shift; "$@"; }; find_opencode_pid() { local pid=""; if command -v pgrep >/dev/null 2>&1; then pid="$(pgrep -fo '\''(^|.*/)opencode([[:space:]]|$)|opencode.*(serve|server)'\'' || true)"; fi; if [[ -z "$pid" ]]; then pid="$(ps -eo pid=,args= | awk '\''/(^|[[:space:]\/])opencode([[:space:]]|$)|opencode.*(serve|server)/ && !/awk/ { print $1; exit }'\'' || true)"; fi; [[ -n "$pid" ]] || { printf '\''OpenCode process not found\n'\'' >&2; return 1; }; kill -HUP "$pid"; }; find_opencode_pid; run_with_timeout %s openchamber restart' "$RESTART_TIMEOUT"
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

  log_info "Syncing ${#WORKSPACES[@]} workspace(s)"
  run_parallel_phase update "${WORKSPACES[@]}"

  if [[ "$SKIP_RESTART" == true ]]; then
    log_info "Skipping restarts"
    return 0
  fi

  run_parallel_phase restart "${WORKSPACES[@]}"
}

main "$@"
