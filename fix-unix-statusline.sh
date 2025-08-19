#!/bin/bash

# Fix Unix statusline by switching to Python version for consistency
echo "Fixing Unix statusline to use cross-platform Python version..."

SETTINGS_FILE=".claude/settings.json"
TEMP_FILE=".claude/settings.json.tmp"

# Check if settings file exists
if [[ ! -f "$SETTINGS_FILE" ]]; then
    echo "Error: Settings file not found: $SETTINGS_FILE"
    exit 1
fi

# Check if jq is available
if ! command -v jq >/dev/null 2>&1; then
    echo "Error: jq is required but not found in PATH"
    echo "Please install jq"
    exit 1
fi

# Update statusline command to use Python version
echo "Updating statusline to use cross-platform Python version..."
jq '.statusLine.command = "python3 \"~/.claude/statusline-enhanced.py\""' "$SETTINGS_FILE" > "$TEMP_FILE"

if [[ $? -ne 0 ]]; then
    echo "Error: Failed to update settings file"
    [[ -f "$TEMP_FILE" ]] && rm "$TEMP_FILE"
    exit 1
fi

# Replace original file with updated version
mv "$TEMP_FILE" "$SETTINGS_FILE"
if [[ $? -ne 0 ]]; then
    echo "Error: Failed to replace settings file"
    exit 1
fi

echo "Successfully updated statusline to use Python version"
echo "The statusline will now work consistently across platforms"