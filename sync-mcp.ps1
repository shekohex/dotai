# sync-mcp.ps1
# PowerShell version of MCP configuration synchronization

param(
    [switch]$Help,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Script directory and file paths
$ScriptDir = $PSScriptRoot
$McpJson = Join-Path $ScriptDir "mcp.json"

# Target directories and files
$ClaudeDir = Join-Path $env:USERPROFILE ".claude"
$OpenCodeDir = Join-Path $env:USERPROFILE ".config\opencode"
$ClaudeConfig = Join-Path $env:USERPROFILE ".claude.json"
$OpenCodeConfig = Join-Path $OpenCodeDir "opencode.jsonc"

# Helper functions for colored logging
function Log-Info([string]$msg) { Write-Host "[INFO] $msg" -ForegroundColor Green }
function Log-Warn([string]$msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Log-Error([string]$msg) { Write-Host "[ERROR] $msg" -ForegroundColor Red }

function Check-Dependencies {
    if (-not (Get-Command "jq" -ErrorAction SilentlyContinue)) {
        Log-Error "jq is required but not installed"
        Write-Host "Please install jq from: https://stedolan.github.io/jq/download/"
        exit 1
    }
}

function Ensure-Directories {
    if (-not (Test-Path -LiteralPath $ClaudeDir)) {
        New-Item -ItemType Directory -Force -Path $ClaudeDir | Out-Null
    }
    if (-not (Test-Path -LiteralPath $OpenCodeDir)) {
        New-Item -ItemType Directory -Force -Path $OpenCodeDir | Out-Null
    }
}

function Backup-Config([string]$ConfigFile) {
    if (Test-Path -LiteralPath $ConfigFile) {
        $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
        $backupFile = "$ConfigFile.backup_$timestamp"
        Copy-Item -LiteralPath $ConfigFile -Destination $backupFile -Force
        Log-Info "Backed up $ConfigFile to $backupFile"
    }
}

function Sync-To-Claude([string]$ClaudeConfigPath) {
    Log-Info "Syncing MCP config to Claude format..."

    # Check if Claude config exists
    if (-not (Test-Path -LiteralPath $ClaudeConfigPath)) {
        Log-Warn "Claude config not found, creating minimal config"
        "{}" | Out-File -FilePath $ClaudeConfigPath -Encoding utf8
    }

    # Use the cross-platform jq utility via PowerShell
    $tempMcp = Join-Path $env:TEMP "mcp_servers_$([Random]::new().Next()).json"
    $jqFilter = '.mcpServers | with_entries(select(.value.enabled == true))'

    try {
        & (Join-Path $ScriptDir "jq-patch.ps1") extract_field $McpJson $tempMcp $jqFilter
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to extract MCP servers"
        }

        & (Join-Path $ScriptDir "jq-patch.ps1") set_field $ClaudeConfigPath "$ClaudeConfigPath.tmp" ".mcpServers" $tempMcp
        if ($LASTEXITCODE -eq 0) {
            Move-Item "$ClaudeConfigPath.tmp" $ClaudeConfigPath -Force
            Log-Info "Claude MCP config updated"
        }
    }
    finally {
        if (Test-Path $tempMcp) {
            Remove-Item $tempMcp -Force -ErrorAction SilentlyContinue
        }
    }
}

function Sync-To-OpenCode([string]$OpenCodeConfigPath) {
    Log-Info "Syncing MCP config to OpenCode format..."

    # Migrate old config if it exists
    $oldConfig = $OpenCodeConfigPath -replace '\.jsonc$', '.json'
    if ((Test-Path $oldConfig) -and -not (Test-Path $OpenCodeConfigPath)) {
        Move-Item $oldConfig $OpenCodeConfigPath
        Log-Info "Migrated $oldConfig to $OpenCodeConfigPath"
    }

    # Check if OpenCode config exists
    if (-not (Test-Path -LiteralPath $OpenCodeConfigPath)) {
        Log-Warn "OpenCode config not found, creating minimal config"
        $minimalConfig = @{
            '$schema' = "https://opencode.ai/config.json"
            theme = "system"
            autoshare = $false
            autoupdate = $true
        }
        $minimalConfig | ConvertTo-Json -Depth 10 | Out-File -FilePath $OpenCodeConfigPath -Encoding utf8
    }

    # Use the cross-platform jq utility via PowerShell
    $tempMcp = Join-Path $env:TEMP "mcp_servers_$([Random]::new().Next()).json"
    $tempTransformed = Join-Path $env:TEMP "opencode_mcp_$([Random]::new().Next()).json"

    try {
        # Extract mcpServers and transform to OpenCode format
        $jqFilter = '.mcpServers | with_entries(select(.value.enabled == true))'

        & (Join-Path $ScriptDir "jq-patch.ps1") extract_field $McpJson $tempMcp $jqFilter
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to extract MCP servers"
        }

        & (Join-Path $ScriptDir "jq-patch.ps1") transform_opencode $tempMcp $tempTransformed
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to transform to OpenCode format"
        }

        & (Join-Path $ScriptDir "jq-patch.ps1") set_field $OpenCodeConfigPath "$OpenCodeConfigPath.tmp" ".mcp" $tempTransformed
        if ($LASTEXITCODE -eq 0) {
            Move-Item "$OpenCodeConfigPath.tmp" $OpenCodeConfigPath -Force
            Log-Info "OpenCode MCP config updated"
        }
    }
    finally {
        if (Test-Path $tempMcp) {
            Remove-Item $tempMcp -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path $tempTransformed) {
            Remove-Item $tempTransformed -Force -ErrorAction SilentlyContinue
        }
    }
}

function Sync-Configs {
    if (-not (Test-Path -LiteralPath $McpJson)) {
        Log-Error "mcp.json not found at $McpJson"
        exit 1
    }

    # Validate mcp.json
    jq empty $McpJson 2>$null
    if ($LASTEXITCODE -ne 0) {
        Log-Error "Invalid JSON in $McpJson"
        exit 1
    }

    Ensure-Directories

    # Sync to Claude
    if (Test-Path -LiteralPath $ClaudeConfig) {
        Backup-Config $ClaudeConfig
    }
    Sync-To-Claude $ClaudeConfig

    # Sync to OpenCode
    if (Test-Path -LiteralPath $OpenCodeConfig) {
        Backup-Config $OpenCodeConfig
    }
    Sync-To-OpenCode $OpenCodeConfig

    Log-Info "MCP configuration sync completed!"
}

function Show-Usage {
    Write-Host "Usage: sync-mcp.ps1 [OPTIONS]"
    Write-Host "Options:"
    Write-Host "  -h, -Help      Show this help message"
    Write-Host "  -DryRun        Show what would be changed without applying"
    Write-Host ""
    Write-Host "Synchronizes MCP server configurations from mcp.json to:"
    Write-Host "  - $ClaudeConfig"
    Write-Host "  - $OpenCodeConfig"
}

# Main execution
function Main {
    Log-Info "Starting MCP configuration sync..."

    Check-Dependencies

    if ($DryRun) {
        Log-Info "Dry run mode - no changes will be made"
        # TODO: Implement dry run logic
        exit 0
    }

    if ($Help) {
        Show-Usage
        exit 0
    }

    Sync-Configs
}

# Run main function
Main