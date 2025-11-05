#!/bin/sh

input=$(cat)

# Get git info
git_info=$(echo "$input" | $SHELL ~/.claude/statusline-command.sh)

# Get context percentage from ccstatusline
context_pct=$(echo "$input" | bunx ccstatusline@latest)

printf '%s | %s' "$git_info" "$context_pct"
