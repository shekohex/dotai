#!/usr/bin/env bash

set -euo pipefail

# Cross-platform path resolution utility for Unix/Linux/macOS
# Usage: path-utils.sh <operation> [args...]

operation="$1"

if [[ -z "$operation" ]]; then
    usage
    exit 1
fi

case "$operation" in
    get_home_dir)
        # Returns the user's home directory
        echo "$HOME"
        ;;

    get_config_dir)
        # Returns the user's config directory
        if [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
            echo "$XDG_CONFIG_HOME"
        else
            echo "$HOME/.config"
        fi
        ;;

    get_local_config_dir)
        # Returns the user's local config directory (same as config on Unix)
        if [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
            echo "$XDG_CONFIG_HOME"
        else
            echo "$HOME/.config"
        fi
        ;;

    expand_path)
        # Expands a path with ~ or environment variables
        input_path="$2"
        if [[ -z "$input_path" ]]; then
            usage
            exit 1
        fi

        # Handle tilde expansion
        if [[ "$input_path" =~ ^~ ]]; then
            expanded_path="${input_path/#\~/$HOME}"
        else
            expanded_path="$input_path"
        fi

        # Expand environment variables
        expanded_path=$(eval echo "$expanded_path")
        echo "$expanded_path"
        ;;

    normalize_path)
        # Normalizes path separators for Unix (no-op, but included for compatibility)
        input_path="$2"
        if [[ -z "$input_path" ]]; then
            usage
            exit 1
        fi

        echo "$input_path"
        ;;

    join_paths)
        # Joins two or more paths with proper separator
        shift # Remove operation argument
        result_path=""

        for path_part in "$@"; do
            if [[ -z "$result_path" ]]; then
                result_path="$path_part"
            else
                # Remove trailing separator from result_path
                result_path="${result_path%/}"
                # Remove leading separator from current path
                current_path="${path_part#/}"
                result_path="$result_path/$current_path"
            fi
        done

        echo "$result_path"
        ;;

    *)
        echo "[ERROR] Unknown operation: $operation"
        usage
        exit 1
        ;;
esac

usage() {
    cat << EOF
Usage: $0 <operation> [args...]

Operations:
  get_home_dir           - Get user's home directory
  get_config_dir         - Get user's config directory
  get_local_config_dir   - Get user's local config directory
  expand_path <path>     - Expand ~ and environment variables
  normalize_path <path>  - Normalize path separators
  join_paths <path1> <path2> [...] - Join paths with proper separators

Examples:
  $0 expand_path "~/.claude"
  $0 join_paths "\$HOME" ".config" "opencode"
EOF
}