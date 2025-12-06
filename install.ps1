# install.ps1
# AI Configuration Installer (PowerShell port)

$ErrorActionPreference = "Stop"

# Define Paths
$RepoDir = $PSScriptRoot
$ClaudeConfig = Join-Path $HOME ".claude"
$OpenCodeConfig = Join-Path $HOME ".config\opencode"
$CodexConfig = Join-Path $HOME ".codex"
$GeminiConfig = Join-Path $HOME ".gemini"

# Source files
$AiMd = Join-Path $RepoDir "AI.md"
$McpJson = Join-Path $RepoDir "mcp.json"

# Helper functions for colored logging
function Log-Info([string]$msg) { Write-Host "[INFO] $msg" -ForegroundColor Green }
function Log-Warn([string]$msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Log-Error([string]$msg) { Write-Host "[ERROR] $msg" -ForegroundColor Red }
function Log-Title([string]$msg) { Write-Host "=== $msg ===" -ForegroundColor Cyan }

function Check-Dependencies {
    if (-not (Get-Command "jq" -ErrorAction SilentlyContinue)) {
        Log-Warn "jq is required but not installed"
        Log-Warn "Please install jq from: https://stedolan.github.io/jq/download/"
        return $false
    }
    return $true
}

function Confirm-Action([string]$message) {
    Write-Host $message -ForegroundColor Yellow
    $confirmation = Read-Host "Continue? (y/N)"
    if ($confirmation -match "^[Yy]$") {
        return $true
    }
    Log-Info "Operation cancelled by user"
    return $false
}

function Backup-File([string]$path) {
    if (Test-Path -LiteralPath $path) {
        $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
        $backup = "$path.backup.$timestamp"
        Copy-Item -LiteralPath $path -Destination $backup -Force
        Log-Info "Backed up existing file: $backup"
    }
}

function Check-And-Sync-File {
    param (
        [string]$source,
        [string]$target,
        [string]$name
    )

    if (-not (Test-Path -LiteralPath $source)) {
        Log-Error "Source file not found: $source"
        return $false
    }

    # Create target directory if it doesn't exist
    $targetDir = Split-Path $target -Parent
    if (-not (Test-Path -LiteralPath $targetDir)) {
        New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    }

    if (Test-Path -LiteralPath $target) {
        # Compare files
        # Try using git diff first if available (for nice output), otherwise simple file hash
        $filesDiffer = $false
        
        if (Get-Command "git" -ErrorAction SilentlyContinue) {
            # git diff --no-index returns 1 if files differ
            git diff --no-index --quiet "$target" "$source" 2>$null
            if ($LASTEXITCODE -ne 0) { $filesDiffer = $true }
        } else {
            $hashSrc = Get-FileHash -LiteralPath $source
            $hashTgt = Get-FileHash -LiteralPath $target
            if ($hashSrc.Hash -ne $hashTgt.Hash) { $filesDiffer = $true }
        }

        if ($filesDiffer) {
            Log-Warn "Files differ for $name :"
            
            if (Get-Command "git" -ErrorAction SilentlyContinue) {
                git diff --no-index --color=always "$target" "$source"
            } else {
                Write-Host "Files are different (git diff unavailable)"
            }
            
            if (Confirm-Action "Replace $name with new version?") {
                Backup-File $target
                Copy-Item -LiteralPath $source -Destination $target -Force
                Log-Info "Updated $name"
            } else {
                Log-Info "Skipped $name"
                return $false
            }
        } else {
            Log-Info "$name is already up to date"
        }
    } else {
        Copy-Item -LiteralPath $source -Destination $target -Force
        Log-Info "Created $name"
    }
    return $true
}

function Sync-Directory {
    param (
        [string]$sourceDir,
        [string]$targetDir,
        [string]$name
    )

    if (-not (Test-Path -LiteralPath $sourceDir)) {
        Log-Error "Source directory not found: $sourceDir"
        return $false
    }

    Log-Info "Syncing $name directory..."
    
    if (-not (Test-Path -LiteralPath $targetDir)) {
        New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    }

    # Use robocopy for mirroring with exclusions
    # Note: robocopy can be picky about trailing slashes in quoted paths.
    # We explicitly strip trailing slashes to be safe, though Join-Path usually handles it.
    $src = $sourceDir.TrimEnd('\')
    $dst = $targetDir.TrimEnd('\')
    
    $robocopyArgs = @(
        $src,
        $dst,
        "/E",
        "/XD", ".git", "node_modules",
        "/NFL", "/NDL", "/NJH", "/NJS", "/nc", "/ns", "/np"
    )

    # Run robocopy directly to handle quoting correctly
    # Start-Process can struggle with quoted paths containing spaces when passed to robocopy
    & robocopy @robocopyArgs | Out-Null
    
    # Robocopy exit codes: 0-7 are success (0=no change, 1=copy success, etc). >=8 is failure.
    if ($LASTEXITCODE -ge 8) {
        Log-Error "Robocopy failed with exit code $LASTEXITCODE"
    }
    
    Log-Info "Synced $name directory"
}

function Sync-Skills-Directory {
    $skillsSource = Join-Path $RepoDir "skills"
    
    if (-not (Test-Path -LiteralPath $skillsSource)) {
        Log-Warn "Skills directory not found: $skillsSource"
        return
    }
    
    Log-Info "Syncing shared skills directory..."
    
    # Sync to Claude config
    $claudeSkillsTarget = Join-Path $ClaudeConfig "skills"
    Sync-Directory $skillsSource $claudeSkillsTarget "Claude skills"
    
    # Sync to OpenCode config
    $opencodeSkillsTarget = Join-Path $OpenCodeConfig "skills"
    Sync-Directory $skillsSource $opencodeSkillsTarget "OpenCode skills"
    
    Log-Info "Shared skills directory synchronized to both configurations"
}

function Sync-Mcp-Configs {
    $mcpSyncPs1 = Join-Path $RepoDir "sync-mcp.ps1"

    if (-not (Test-Path -LiteralPath $mcpSyncPs1)) {
        Log-Warn "MCP sync script not found at $mcpSyncPs1"
        return
    }

    if (-not (Test-Path -LiteralPath $McpJson)) {
        Log-Warn "mcp.json not found, skipping MCP sync"
        return
    }

    Log-Title "Syncing MCP Configurations"

    if (-not (Check-Dependencies)) {
        Log-Warn "Missing dependencies for MCP sync, skipping"
        return
    }

    # Execute the PowerShell script
    try {
        & "$mcpSyncPs1"
        if ($LASTEXITCODE -eq 0) {
            Log-Info "MCP configurations synchronized successfully"
        } else {
            Log-Error "Failed to sync MCP configurations"
        }
    }
    catch {
        Log-Error "Failed to sync MCP configurations: $_"
    }
}

# Main Execution Flow
function Main {
    Log-Info "AI Configuration Installer"
    Log-Info "Repository: $RepoDir"

    # Sync AI.md to CLAUDE.md
    $claudeFile = Join-Path $ClaudeConfig "CLAUDE.md"
    Check-And-Sync-File $AiMd $claudeFile "Claude instructions" | Out-Null

    # Sync AI.md to AGENTS.md
    $opencodeFile = Join-Path $OpenCodeConfig "AGENTS.md"
    Check-And-Sync-File $AiMd $opencodeFile "OpenCode instructions" | Out-Null

    # Sync AI.md to Codex AGENTS.md
    $codexFile = Join-Path $CodexConfig "AGENTS.md"
    Check-And-Sync-File $AiMd $codexFile "Codex instructions" | Out-Null

    # Sync AI.md to Gemini GEMINI.md
    $geminiFile = Join-Path $GeminiConfig "GEMINI.md"
    Check-And-Sync-File $AiMd $geminiFile "Gemini instructions" | Out-Null

    # Sync .gemini/workflows directory to Antigravity global workflows
    $dotGeminiWorkflowsSrc = Join-Path $RepoDir ".gemini/workflows"
    if (Test-Path -LiteralPath $dotGeminiWorkflowsSrc) {
        $antigravityWorkflows = Join-Path $GeminiConfig "antigravity/global_workflows"
        Sync-Directory $dotGeminiWorkflowsSrc $antigravityWorkflows "Antigravity workflows"
    }

    # Sync .claude directory
    $dotClaudeSrc = Join-Path $RepoDir ".claude"
    if (Test-Path -LiteralPath $dotClaudeSrc) {
        Sync-Directory $dotClaudeSrc $ClaudeConfig "Claude"
    }

    # Sync .opencode directory
    $dotOpencodeSrc = Join-Path $RepoDir ".opencode"
    if (Test-Path -LiteralPath $dotOpencodeSrc) {
        Sync-Directory $dotOpencodeSrc $OpenCodeConfig "OpenCode"
    }

    # Sync .codex directory
    $dotCodexSrc = Join-Path $RepoDir ".codex"
    if (Test-Path -LiteralPath $dotCodexSrc) {
        Sync-Directory $dotCodexSrc $CodexConfig "Codex"
    }

    # Sync shared skills directory
    Sync-Skills-Directory

    # Sync MCP configurations
    Sync-Mcp-Configs

    Log-Info "Installation complete!"
    Log-Info "Claude config: $ClaudeConfig"
    Log-Info "OpenCode config: $OpenCodeConfig"
    Log-Info "Codex config: $CodexConfig"
    Log-Info "Gemini config: $GeminiConfig"
    Write-Host ""
    Write-Host "Synchronized files:"
    Write-Host "  - AI.md -> $claudeFile"
    Write-Host "  - AI.md -> $opencodeFile"
    Write-Host "  - AI.md -> $codexFile"
    Write-Host "  - AI.md -> $geminiFile"
    if (Test-Path -LiteralPath (Join-Path $RepoDir "skills")) {
        Write-Host "  - skills/ -> $ClaudeConfig/skills/"
        Write-Host "  - skills/ -> $OpenCodeConfig/skills/"
    }
    if (Test-Path -LiteralPath $McpJson) {
        Write-Host "  - mcp.json -> Claude MCP servers"
        Write-Host "  - mcp.json -> OpenCode MCP servers"
    }
    if (Test-Path -LiteralPath (Join-Path $RepoDir ".codex")) {
        Write-Host "  - .codex/ -> $CodexConfig/"
    }
}

# Run Main
Main
