#!/bin/bash

set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_CONFIG="$HOME/.claude"
OPENCODE_CONFIG="$HOME/.config/opencode"

# Source files
AI_MD="$REPO_DIR/AI.md"
MCP_JSON="$REPO_DIR/mcp.json"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_title() {
    echo -e "${BLUE}=== $1 ===${NC}"
}

# Check if required tools are available
check_dependencies() {
    local deps=("jq")
    local missing=()
    
    for dep in "${deps[@]}"; do
        if ! command -v "$dep" &> /dev/null; then
            missing+=("$dep")
        fi
    done
    
    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing required dependencies: ${missing[*]}"
        echo "Please install:"
        for dep in "${missing[@]}"; do
            case $dep in
                jq)
                    echo "  - jq: https://stedolan.github.io/jq/download/"
                    ;;
            esac
        done
        return 1
    fi
    return 0
}

confirm_action() {
    local message="$1"
    echo -e "${YELLOW}$message${NC}"
    read -p "Continue? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Operation cancelled by user"
        return 1
    fi
    return 0
}

backup_file() {
    local file="$1"
    if [[ -f "$file" ]]; then
        local backup="${file}.backup.$(date +%Y%m%d_%H%M%S)"
        cp "$file" "$backup"
        log_info "Backed up existing file: $backup"
    fi
}

check_and_sync_file() {
    local source="$1"
    local target="$2"
    local name="$3"
    
    if [[ ! -f "$source" ]]; then
        log_error "Source file not found: $source"
        return 1
    fi
    
    # Create target directory if it doesn't exist
    mkdir -p "$(dirname "$target")"
    
    if [[ -f "$target" ]]; then
        # Use git diff for better diff display, fall back to diff if git not available
        if ! cmp -s "$source" "$target"; then
            log_warn "Files differ for $name:"
            echo
            if command -v git &> /dev/null; then
                git diff --no-index --color=always "$target" "$source" 2>/dev/null || \
                diff -u "$target" "$source" 2>/dev/null || \
                echo "Files are different but diff unavailable"
            else
                diff -u "$target" "$source" 2>/dev/null || \
                echo "Files are different but diff unavailable"
            fi
            echo
            
            if confirm_action "Replace $name with new version?"; then
                backup_file "$target"
                cp "$source" "$target"
                log_info "Updated $name"
            else
                log_info "Skipped $name"
                return 1
            fi
        else
            log_info "$name is already up to date"
        fi
    else
        cp "$source" "$target"
        log_info "Created $name"
    fi
    return 0
}

sync_directory() {
    local source_dir="$1"
    local target_dir="$2"
    local name="$3"
    
    if [[ ! -d "$source_dir" ]]; then
        log_error "Source directory not found: $source_dir"
        return 1
    fi
    
    log_info "Syncing $name directory..."
    
    # Create target directory if it doesn't exist
    mkdir -p "$target_dir"
    
    # Use rsync for directory synchronization if available, otherwise use cp
    if command -v rsync &> /dev/null; then
        rsync -av --copy-links --exclude='.git' --exclude='node_modules' "$source_dir/" "$target_dir/"
    else
        cp -r -L "$source_dir/"* "$target_dir/" 2>/dev/null || true
    fi
    
    log_info "Synced $name directory"
}

# Sync MCP configurations using dedicated script
sync_mcp_configs() {
    local mcp_sync_script="$REPO_DIR/sync-mcp.sh"
    
    if [[ ! -f "$mcp_sync_script" ]]; then
        log_warn "MCP sync script not found at $mcp_sync_script"
        return 0
    fi
    
    if [[ ! -x "$mcp_sync_script" ]]; then
        log_warn "MCP sync script is not executable"
        return 0
    fi
    
    if [[ ! -f "$MCP_JSON" ]]; then
        log_warn "mcp.json not found, skipping MCP sync"
        return 0
    fi
    
    log_title "Syncing MCP Configurations"
    
    # Check dependencies for MCP sync
    if ! check_dependencies; then
        log_warn "Missing dependencies for MCP sync, skipping"
        return 0
    fi
    
    # Run the MCP sync script
    if "$mcp_sync_script"; then
        log_info "MCP configurations synchronized successfully"
    else
        log_error "Failed to sync MCP configurations"
        return 1
    fi
}

main() {
    log_info "AI Configuration Installer"
    log_info "Repository: $REPO_DIR"
    
    # Sync AI.md to CLAUDE.md
    if check_and_sync_file "$REPO_DIR/AI.md" "$CLAUDE_CONFIG/CLAUDE.md" "Claude instructions"; then
        log_info "Claude configuration synchronized"
    fi
    
    # Sync AI.md to AGENTS.md  
    if check_and_sync_file "$REPO_DIR/AI.md" "$OPENCODE_CONFIG/AGENTS.md" "OpenCode instructions"; then
        log_info "OpenCode configuration synchronized"
    fi
    
    # Sync .claude directory
    if [[ -d "$REPO_DIR/.claude" ]]; then
        sync_directory "$REPO_DIR/.claude" "$CLAUDE_CONFIG" "Claude"
    fi
    
    # Sync .opencode directory
    if [[ -d "$REPO_DIR/.opencode" ]]; then
        sync_directory "$REPO_DIR/.opencode" "$OPENCODE_CONFIG" "OpenCode"
    fi
    
    # Sync MCP configurations
    sync_mcp_configs
    
    log_info "Installation complete!"
    log_info "Claude config: $CLAUDE_CONFIG"
    log_info "OpenCode config: $OPENCODE_CONFIG"
    echo ""
    echo "Synchronized files:"
    echo "  - AI.md → $CLAUDE_CONFIG/CLAUDE.md"
    echo "  - AI.md → $OPENCODE_CONFIG/AGENTS.md"
    if [[ -f "$MCP_JSON" ]]; then
        echo "  - mcp.json → Claude MCP servers"
        echo "  - mcp.json → OpenCode MCP servers"
    fi
}

# Check if script is being sourced or executed
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
