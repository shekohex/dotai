#!/usr/bin/env bash

# Enhanced Claude Code Status Line Script
# Provides model-specific colors, token counting, and project display

# Color codes
RESET='\033[0m'
CYAN='\033[96m'      # Opus
ORANGE='\033[38;5;208m'  # Sonnet
GREEN='\033[92m'     # Haiku
WHITE='\033[97m'     # Unknown
YELLOW='\033[93m'    # Project name
GRAY='\033[90m'      # Cached tokens
BLUE='\033[94m'      # Git branch
BOLD='\033[1m'

# Function to format numbers with thousand separators
format_number() {
    local num="$1"
    if [[ "$num" =~ ^[0-9]+$ ]]; then
        printf "%'d" "$num" 2>/dev/null || echo "$num"
    else
        echo "$num"
    fi
}

# Function to extract model color based on model name
get_model_color() {
    local model="$1"
    case "$model" in
        *opus*|*Opus*) echo "$CYAN" ;;
        *sonnet*|*Sonnet*) echo "$ORANGE" ;;
        *haiku*|*Haiku*) echo "$GREEN" ;;
        *) echo "$WHITE" ;;
    esac
}

# Function to get project name from path
get_project_name() {
    local project_dir="$1"
    if [[ -n "$project_dir" && "$project_dir" != "/" ]]; then
        basename "$project_dir"
    else
        echo "unknown"
    fi
}

# Function to get git branch
get_git_branch() {
    local project_dir="$1"
    local branch=""
    
    if [[ -n "$project_dir" && -d "$project_dir" ]]; then
        # Change to project directory and get branch
        if branch=$(cd "$project_dir" && git rev-parse --abbrev-ref HEAD 2>/dev/null); then
            echo "$branch"
        fi
    fi
}

# Function to calculate total tokens from transcript
calculate_tokens() {
    local transcript_path="$1"
    local total_tokens=0
    local cached_tokens=0
    
    if [[ -f "$transcript_path" ]]; then
        # Enhanced regex patterns for better token detection
        local input_tokens=$(grep -oE '"input_tokens":\s*[0-9]+' "$transcript_path" 2>/dev/null | grep -oE '[0-9]+' | awk '{sum += $1} END {print sum+0}')
        local output_tokens=$(grep -oE '"output_tokens":\s*[0-9]+' "$transcript_path" 2>/dev/null | grep -oE '[0-9]+' | awk '{sum += $1} END {print sum+0}')
        
        # Count cached tokens separately
        cached_tokens=$(grep -oE '"cache_creation_input_tokens":\s*[0-9]+|"cache_read_input_tokens":\s*[0-9]+' "$transcript_path" 2>/dev/null | grep -oE '[0-9]+' | awk '{sum += $1} END {print sum+0}')
        
        total_tokens=$((input_tokens + output_tokens))
    fi
    
    echo "$total_tokens $cached_tokens"
}

# Main execution
main() {
    # Read and parse JSON input with error checking
    local input
    if ! input=$(cat 2>/dev/null); then
        echo "Error: Failed to read input" >&2
        exit 1
    fi
    
    # Check if jq is available and use it for parsing
    if command -v jq >/dev/null 2>&1; then
        # Use jq -e for better error detection
        local model_display_name
        local project_dir
        local transcript_path
        
        if ! model_display_name=$(echo "$input" | jq -e -r '.model.display_name // .model.id // "Unknown"' 2>/dev/null); then
            model_display_name="Unknown"
        fi
        
        if ! project_dir=$(echo "$input" | jq -e -r '.workspace.project_dir // .workspace.current_dir // .cwd // ""' 2>/dev/null); then
            project_dir=""
        fi
        
        if ! transcript_path=$(echo "$input" | jq -e -r '.transcript_path // ""' 2>/dev/null); then
            transcript_path=""
        fi
    else
        # Fallback parsing without jq
        local model_display_name=$(echo "$input" | grep -oE '"display_name":\s*"[^"]*"' | head -1 | sed 's/.*"display_name":\s*"\([^"]*\)".*/\1/' || echo "Unknown")
        local project_dir=$(echo "$input" | grep -oE '"project_dir":\s*"[^"]*"' | head -1 | sed 's/.*"project_dir":\s*"\([^"]*\)".*/\1/' || echo "")
        local transcript_path=$(echo "$input" | grep -oE '"transcript_path":\s*"[^"]*"' | head -1 | sed 's/.*"transcript_path":\s*"\([^"]*\)".*/\1/' || echo "")
        
        # Fallback to current_dir if project_dir is empty
        if [[ -z "$project_dir" ]]; then
            project_dir=$(echo "$input" | grep -oE '"current_dir":\s*"[^"]*"' | head -1 | sed 's/.*"current_dir":\s*"\([^"]*\)".*/\1/' || echo "")
        fi
        
        # Final fallback to cwd
        if [[ -z "$project_dir" ]]; then
            project_dir=$(echo "$input" | grep -oE '"cwd":\s*"[^"]*"' | head -1 | sed 's/.*"cwd":\s*"\([^"]*\)".*/\1/' || echo "")
        fi
    fi
    
    # Get model-specific color
    local model_color=$(get_model_color "$model_display_name")
    
    # Get project name
    local project_name=$(get_project_name "$project_dir")
    
    # Get git branch
    local git_branch=$(get_git_branch "$project_dir")
    
    # Calculate tokens
    local token_info=($(calculate_tokens "$transcript_path"))
    local total_tokens=${token_info[0]:-0}
    local cached_tokens=${token_info[1]:-0}
    
    # Format numbers
    local formatted_total=$(format_number "$total_tokens")
    local formatted_cached=$(format_number "$cached_tokens")
    
    # Build status line
    local status_line=""
    
    # Model name with color
    status_line+="${BOLD}${model_color}${model_display_name}${RESET}"
    
    # Separator
    status_line+=" | "
    
    # Project name in yellow
    status_line+="${BOLD}${YELLOW}${project_name}${RESET}"
    
    # Git branch (if available)
    if [[ -n "$git_branch" ]]; then
        status_line+=" | ${BLUE}⎇ ${git_branch}${RESET}"
    fi
    
    # Tokens section
    if [[ "$total_tokens" -gt 0 ]]; then
        status_line+=" | 📝 ${formatted_total} tk"
        
        # Show cached tokens if available
        if [[ "$cached_tokens" -gt 0 ]]; then
            status_line+=" ${GRAY}[${formatted_cached}]${RESET}"
        fi
    fi
    
    # Output the status line
    printf "%b\n" "$status_line"
}

# Execute main function
main "$@"