param(
  [Parameter(Mandatory = $true)]
  [string]$ShortSlug
)

$ErrorActionPreference = "Stop"

if ($ShortSlug -notmatch '^[A-Za-z0-9._-]+$') {
  Write-Error "Invalid short-slug. Use only letters, numbers, dots, underscores, and hyphens."
  exit 64
}

$temporaryDirectory = [System.IO.Path]::GetTempPath().TrimEnd([char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar))
$draftPath = Join-Path $temporaryDirectory "goal-prompt-$ShortSlug.md"

if (-not (Test-Path -LiteralPath $draftPath)) {
  @'
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
'@ | Set-Content -LiteralPath $draftPath -Encoding utf8
}

Write-Output "File: $draftPath"
Write-Output "Plannotator: /plannotator annotate $draftPath"
