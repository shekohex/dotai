#!/usr/bin/env bash

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_JSON="$SCRIPT_DIR/mcp.json"

# Target directories
CLAUDE_DIR="$HOME/.claude"
OPENCODE_DIR="$HOME/.config/opencode"

# Target files
CLAUDE_CONFIG="$HOME/.claude.json"
OPENCODE_CONFIG="$OPENCODE_DIR/opencode.json"

# Function to print colored output
print_status() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# Check if required tools are available
check_dependencies() {
  local deps=("jq" "git")
  for dep in "${deps[@]}"; do
    if ! command -v "$dep" &>/dev/null; then
      print_error "$dep is required but not installed"
      exit 1
    fi
  done
}

# Create directories if they don't exist
ensure_directories() {
  mkdir -p "$CLAUDE_DIR"
  mkdir -p "$OPENCODE_DIR"
}

# Create backup of existing config if it exists
backup_config() {
  local config_file="$1"
  local backup_suffix="$(date +%Y%m%d_%H%M%S)"

  if [[ -f "$config_file" ]]; then
    local backup_file="${config_file}.backup_${backup_suffix}"
    cp "$config_file" "$backup_file"
    print_status "Backed up $config_file to $backup_file"
  fi
}

# Check if configs differ using git diff
configs_differ() {
  local file1="$1"
  local file2="$2"

  if [[ ! -f "$file1" ]] || [[ ! -f "$file2" ]]; then
    return 0 # Consider different if one doesn't exist
  fi

  ! git diff --no-index --quiet "$file1" "$file2" 2>/dev/null
}

# Sync MCP config to Claude format
sync_to_claude() {
  local claude_config="$1"

  print_status "Syncing MCP config to Claude format..."

  # Check if Claude config exists
  if [[ ! -f "$claude_config" ]]; then
    print_warning "Claude config not found, creating minimal config"
    echo '{}' >"$claude_config"
  fi

  # Extract mcpServers from mcp.json and merge into Claude config
  local mcp_servers
  mcp_servers=$(jq '.mcpServers | with_entries(select(.value.enabled == true))' "$MCP_JSON")

  # Update Claude config with MCP servers
  jq --argjson mcpServers "$mcp_servers" '.mcpServers = $mcpServers' "$claude_config" >"$claude_config.tmp"
  mv "$claude_config.tmp" "$claude_config"

  print_status "Claude MCP config updated"
}

# Transform Claude format to OpenCode format
# Claude: {"type": "http", "url": "..."}
# OpenCode: {"type": "remote", "url": "...", "enabled": true}
transform_to_opencode_format() {
  local mcp_servers="$1"

  echo "$mcp_servers" | jq '
        to_entries | map(
            .value as $server |
            .key as $name |
            {
                key: $name,
                value: (
                    if $server.type == "http" then
                        {
                            type: "remote",
                            url: $server.url,
                            enabled: $server.enabled
                        }
                    else
                        {
                            type: "local",
                            command: ([$server.command] + ($server.args // [])),
                            enabled: $server.enabled
                        } + (
                            if $server.env then
                                {environment: $server.env}
                            else
                                {}
                            end
                        )
                    end
                )
            }
        ) | from_entries'
}

# Sync MCP config to OpenCode format
sync_to_opencode() {
  local opencode_config="$1"

  print_status "Syncing MCP config to OpenCode format..."

  # Check if OpenCode config exists
  if [[ ! -f "$opencode_config" ]]; then
    print_warning "OpenCode config not found, creating minimal config"
    cat >"$opencode_config" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "theme": "system",
  "autoshare": false,
  "autoupdate": true
}
EOF
  fi

  # Extract and transform mcpServers from mcp.json
  local mcp_servers
  mcp_servers=$(jq '.mcpServers | with_entries(select(.value.enabled == true))' "$MCP_JSON")

  local opencode_mcp
  opencode_mcp=$(transform_to_opencode_format "$mcp_servers")

  # Update OpenCode config with transformed MCP servers
  jq --argjson mcp "$opencode_mcp" '.mcp = $mcp' "$opencode_config" >"$opencode_config.tmp"
  mv "$opencode_config.tmp" "$opencode_config"

  print_status "OpenCode MCP config updated"
}

# Prompt user for confirmation if configs differ
prompt_if_different() {
  local config_file="$1"
  local temp_file="${config_file}.new"
  local tool_name="$2"

  if configs_differ "$config_file" "$temp_file" 2>/dev/null; then
    print_warning "Differences found in $tool_name configuration:"
    git diff --no-index "$config_file" "$temp_file" 2>/dev/null || true

    echo -n "Apply changes to $tool_name config? [y/N]: "
    read -r response
    if [[ "$response" =~ ^[Yy]$ ]]; then
      mv "$temp_file" "$config_file"
      print_status "$tool_name configuration updated"
    else
      rm -f "$temp_file"
      print_status "$tool_name configuration unchanged"
    fi
  else
    mv "$temp_file" "$config_file"
    print_status "$tool_name configuration is up to date"
  fi
}

# Main sync function
sync_configs() {
  if [[ ! -f "$MCP_JSON" ]]; then
    print_error "mcp.json not found at $MCP_JSON"
    exit 1
  fi

  # Validate mcp.json
  if ! jq empty "$MCP_JSON" 2>/dev/null; then
    print_error "Invalid JSON in $MCP_JSON"
    exit 1
  fi

  ensure_directories

  # Sync to Claude
  if [[ -f "$CLAUDE_CONFIG" ]]; then
    backup_config "$CLAUDE_CONFIG"
  fi
  sync_to_claude "$CLAUDE_CONFIG"

  # Sync to OpenCode
  if [[ -f "$OPENCODE_CONFIG" ]]; then
    backup_config "$OPENCODE_CONFIG"
  fi
  sync_to_opencode "$OPENCODE_CONFIG"

  print_status "MCP configuration sync completed!"
}

# Show usage
usage() {
  echo "Usage: $0 [OPTIONS]"
  echo "Options:"
  echo "  -h, --help     Show this help message"
  echo "  --dry-run      Show what would be changed without applying"
  echo ""
  echo "Synchronizes MCP server configurations from mcp.json to:"
  echo "  - $CLAUDE_CONFIG"
  echo "  - $OPENCODE_CONFIG"
}

# Parse command line arguments
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case $1 in
  -h | --help)
    usage
    exit 0
    ;;
  --dry-run)
    DRY_RUN=true
    shift
    ;;
  *)
    print_error "Unknown option: $1"
    usage
    exit 1
    ;;
  esac
done

# Main execution
main() {
  print_status "Starting MCP configuration sync..."

  check_dependencies

  if [[ "$DRY_RUN" == "true" ]]; then
    print_status "Dry run mode - no changes will be made"
    # TODO: Implement dry run logic
    exit 0
  fi

  sync_configs
}

main "$@"
