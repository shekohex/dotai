#!/usr/bin/env bash

set -euo pipefail

# Cross-platform JSON patching utility for Unix/Linux/macOS
# Usage: jq-patch.sh <operation> <input_file> <output_file> [additional_args...]

operation="$1"
input_file="$2"
output_file="$3"

if [[ -z "$operation" ]] || [[ -z "$input_file" ]] || [[ -z "$output_file" ]]; then
    usage
    exit 1
fi

# Check if jq is available
if ! command -v jq &> /dev/null; then
    echo "[ERROR] jq is required but not installed"
    echo "Please install jq from: https://stedolan.github.io/jq/download/"
    exit 1
fi

# Validate input file exists and is valid JSON
if [[ ! -f "$input_file" ]]; then
    echo "[ERROR] Input file not found: $input_file"
    exit 1
fi

# Function to strip comments (lines starting with optional whitespace and //)
clean_json() {
    sed 's/^[[:space:]]*\/\/.*$//' "$1"
}

if ! clean_json "$input_file" | jq empty 2>/dev/null; then
    echo "[ERROR] Invalid JSON in $input_file"
    exit 1
fi

# Create temporary directory for intermediate files
temp_dir=$(mktemp -d)
trap "rm -rf $temp_dir" EXIT

case "$operation" in
    merge_object)
        # Usage: jq-patch.sh merge_object input.json output.json object_key source.json
        object_key="$4"
        source_file="$5"

        if [[ -z "$object_key" ]] || [[ -z "$source_file" ]]; then
            usage
            exit 1
        fi

        if [[ ! -f "$source_file" ]]; then
            echo "[ERROR] Source file not found: $source_file"
            exit 1
        fi

        # Read source object and merge
        clean_json "$input_file" | jq --slurpfile source "$source_file" ".[\"$object_key\"] = \$source[0][\"$object_key\"]" > "$output_file"
        echo "[INFO] Successfully merged $object_key from $source_file"
        ;;

    extract_field)
        # Usage: jq-patch.sh extract_field input.json output.json field_path
        field_path="$4"

        if [[ -z "$field_path" ]]; then
            usage
            exit 1
        fi

        clean_json "$input_file" | jq "$field_path" > "$output_file"
        echo "[INFO] Successfully extracted $field_path"
        ;;

    transform_opencode)
        # Usage: jq-patch.sh transform_opencode input.json output.json
        transform_script="$temp_dir/transform.jq"

        cat > "$transform_script" << 'EOF'
to_entries | map(
    .value as $server | .key as $name |
    {
        key: $name,
        value: (
            if $server.type == "http" then
                {
                    type: "remote",
                    url: $server.url,
                    headers: $server.headers,
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
) | from_entries
EOF

        clean_json "$input_file" | jq -f "$transform_script" > "$output_file"
        echo "[INFO] Successfully transformed to OpenCode format"
        ;;

    set_field)
        # Usage: jq-patch.sh set_field input.json output.json field_path value_file
        field_path="$4"
        value_file="$5"

        if [[ -z "$field_path" ]] || [[ -z "$value_file" ]]; then
            usage
            exit 1
        fi

        if [[ ! -f "$value_file" ]]; then
            echo "[ERROR] Value file not found: $value_file"
            exit 1
        fi

        clean_json "$input_file" | jq --slurpfile value "$value_file" "$field_path = \$value[0]" > "$output_file"
        echo "[INFO] Successfully set $field_path"
        ;;

    extract_field)
        # Usage: jq-patch.sh extract_field input.json output.json field_path
        field_path="$4"

        if [[ -z "$field_path" ]]; then
            usage
            exit 1
        fi

        jq "$field_path" "$input_file" > "$output_file"
        echo "[INFO] Successfully extracted $field_path"
        ;;

    transform_opencode)
        # Usage: jq-patch.sh transform_opencode input.json output.json
        transform_script="$temp_dir/transform.jq"

        cat > "$transform_script" << 'EOF'
to_entries | map(
    .value as $server | .key as $name |
    {
        key: $name,
        value: (
            if $server.type == "http" then
                {
                    type: "remote",
                    url: $server.url,
                    enabled: true
                }
            else
                {
                    type: "local",
                    command: ([$server.command] + ($server.args // [])),
                    enabled: true
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
) | from_entries
EOF

        jq -f "$transform_script" "$input_file" > "$output_file"
        echo "[INFO] Successfully transformed to OpenCode format"
        ;;

    set_field)
        # Usage: jq-patch.sh set_field input.json output.json field_path value_file
        field_path="$4"
        value_file="$5"

        if [[ -z "$field_path" ]] || [[ -z "$value_file" ]]; then
            usage
            exit 1
        fi

        if [[ ! -f "$value_file" ]]; then
            echo "[ERROR] Value file not found: $value_file"
            exit 1
        fi

        jq --slurpfile value "$value_file" "$field_path = \$value[0]" "$input_file" > "$output_file"
        echo "[INFO] Successfully set $field_path"
        ;;

    *)
        echo "[ERROR] Unknown operation: $operation"
        usage
        exit 1
        ;;
esac

usage() {
    cat << EOF
Usage: $0 <operation> <input_file> <output_file> [additional_args...]

Operations:
  merge_object    input.json output.json object_key source.json
  extract_field   input.json output.json field_path
  transform_opencode input.json output.json
  set_field       input.json output.json field_path value_file

Examples:
  $0 extract_field mcp.json servers.json ".mcpServers"
  $0 merge_object config.json new_config.json "mcpServers" servers.json
  $0 transform_opencode servers.json opencode_servers.json
EOF
}