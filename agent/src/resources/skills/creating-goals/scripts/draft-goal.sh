#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  printf 'Usage: %s <short-slug>\n' "$0" >&2
  exit 64
fi

slug="$1"

if ! printf '%s' "$slug" | grep -Eq '^[A-Za-z0-9._-]+$'; then
  printf 'Invalid short-slug. Use only letters, numbers, dots, underscores, and hyphens.\n' >&2
  exit 64
fi

tmp_dir="${TMPDIR:-/tmp}"
draft_path="${tmp_dir%/}/goal-prompt-${slug}.md"

if [ ! -e "$draft_path" ]; then
  tee "$draft_path" >/dev/null <<'EOF'
---
successCriteria:
  - "[Observable completion criterion]"
constraints:
  - "[Side-effect limit, non-goal, approval rule, or project constraint]"
verificationCommands:
  - "[Command to prove completion, or remove this item if none is known]"
---

# Goal Prompt Draft

Role: [Define the agent's job, operating context, and responsibility in 1-2 sentences.]

# Personality
[Define tone and collaboration style only if it changes behavior.]

# Goal
[State the user-visible outcome.]

# Context
[Summarize user input, discovered codebase facts, docs, constraints, and assumptions.]

# Success Criteria
[Define concrete completion criteria.]

# Constraints
[Define user-approved constraints, side-effect limits, and non-goals.]

# Evidence And Tool Rules
[Define evidence requirements, required tools, forbidden tools, and approval rules.]

# Closed Feedback Loop
[Define the inspect, act, verify, proof collection, loophole handling, and continuation loop.]

# Output
[Define final response shape, required fields, length, tone, and formatting.]

# Stop Rules
[Define success, blocker, approval, and risk stop conditions.]
EOF
fi

printf 'File: %s\n' "$draft_path"
printf 'Plannotator: /plannotator annotate %s\n' "$draft_path"
printf 'Creating Goal Manually: /goal @%s\n' "$draft_path"
