#!/bin/sh

# Read JSON input
input=$(cat)

# Extract working directory
cwd=$(echo "$input" | sed -n 's/.*"current_dir":"\([^"]*\)".*/\1/p')

# Git information
if git -C "$cwd" rev-parse --git-dir > /dev/null 2>&1; then
  repo_name=$(echo "$cwd" | sed "s|^$HOME/github/||")
  branch=$(git -C "$cwd" --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null)

  staged=$(git -C "$cwd" --no-optional-locks diff --cached --name-only 2>/dev/null | wc -l)
  unstaged=$(git -C "$cwd" --no-optional-locks diff --name-only 2>/dev/null | wc -l)
  untracked=$(git -C "$cwd" --no-optional-locks ls-files --others --exclude-standard 2>/dev/null | wc -l)

  local reset=$'\033[00m'
  local green=$'\033[38;5;70m'    # F{70}
  local blue=$'\033[38;5;67m'     # F{67}
  local cyan=$'\033[38;5;32m'     # F{32}
  local red=$'\033[31m'
  local black=$'\033[38;5;0m'

  # Ahead/behind commits
  ahead_behind=$(git -C "$cwd" --no-optional-locks rev-list --count --left-right @{u}...HEAD 2>/dev/null)
  num_behind=$(echo $ahead_behind | awk '{print $1}')
  num_ahead=$(echo $ahead_behind | awk '{print $2}')
  commit_delta=""
  [[ $num_ahead -gt 0 ]] && commit_delta+="${black}↑${num_ahead}"
  [[ $num_behind -gt 0 ]] && commit_delta+="${black}↓${num_behind}"

  # Status indicators: untracked… ●staged ✚unstaged
  local indicators=""
  [[ $untracked -gt 0 ]] && indicators+="${red}${untracked}…${reset}"
  [[ $staged -gt 0 ]] && indicators+="${green}●${staged}${reset}"
  [[ $unstaged -gt 0 ]] && indicators+="${cyan}✚${unstaged}${reset}"

  # Format: repo_name | (branch↑↓|indicators)
  printf '%s%s%s | %s(%s%s' "$green" "$repo_name" "$reset" "$blue" "$branch" "$commit_delta"
  if [[ -n "$indicators" ]]; then
    printf '%s|%s%s)%s' "$reset" "$indicators" "$blue" "$reset"
  else
    printf '%s)%s' "$blue" "$reset"
  fi
else
  printf '\033[38;5;70m%s\033[00m' "$cwd"
fi
