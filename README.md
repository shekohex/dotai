# AI Configuration Management

A unified configuration management system for AI tools including Claude Code and OpenCode. This repository synchronizes configuration files and AI instructions across different AI development environments.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
  - [Required Dependencies](#required-dependencies)
  - [Installation Instructions](#installation-instructions)
    - [macOS](#macos)
    - [Linux (Ubuntu/Debian)](#linux-ubuntudebian)
    - [Linux (CentOS/RHEL/Fedora)](#linux-centosrhelfedora)
    - [Arch Linux](#arch-linux)
    - [Windows](#windows)
- [Target Locations](#target-locations)
- [Configuration Files](#configuration-files)
- [Installation](#installation)
- [Features](#features)
- [Usage Examples](#usage-examples)
- [Troubleshooting](#troubleshooting)
- [Backup and Recovery](#backup-and-recovery)

## Overview

This system manages AI tool configurations by:

- Synchronizing the general `AI.md` instructions to tool-specific files
- Synchronizing MCP server configurations from a unified `mcp.json` to tool-specific formats
- Copying configuration directories to their expected locations
- Providing diff-based confirmation for file changes
- Supporting both Unix-like systems and Windows

## Prerequisites

### Required Dependencies

This system requires several command-line tools to function properly:

#### Core Dependencies (Required)
- **jq** - JSON processor for MCP configuration transformation
- **bash** (Unix/Linux/macOS) or **cmd** (Windows) - Shell execution
- **cmp** (Unix/Linux/macOS) or **fc** (Windows) - File comparison

#### Optional Dependencies (Recommended)
- **git** - Version control system (provides better diff output, fallback available)
- **rsync** (Unix/Linux/macOS) - Efficient directory synchronization (fallback to cp available)
- **diff** - Text comparison tool (fallback when git unavailable)
- **openskills** - Universal skills loader for AI agents (syncs skills to AI.md)
  - Requires Node.js 20.6+ or Bun
  - Install with: `npm i -g openskills` or `bun i -g openskills`

### Installation Instructions

#### macOS

Using [Homebrew](https://brew.sh/) (recommended):

```bash
# Install Homebrew if not already installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install required dependencies
brew install jq git

# rsync and diff are usually pre-installed on macOS

# Install openskills (optional, for skills management)
npm i -g openskills  # or: bun i -g openskills
```

Using [MacPorts](https://www.macports.org/):

```bash
# Install required dependencies
sudo port install jq git
```

#### Linux (Ubuntu/Debian)

```bash
# Update package list
sudo apt update

# Install required dependencies
sudo apt install jq git rsync curl

# Install openskills (optional, for skills management)
npm i -g openskills  # or: bun i -g openskills
```

#### Linux (CentOS/RHEL/Fedora)

**CentOS/RHEL:**
```bash
# Install EPEL repository (CentOS/RHEL)
sudo yum install epel-release

# Install required dependencies
sudo yum install jq git rsync curl
```

**Fedora:**
```bash
# Install required dependencies
sudo dnf install jq git rsync curl

# Install openskills (optional, for skills management)
npm i -g openskills  # or: bun i -g openskills
```

#### Arch Linux

```bash
# Install required dependencies from official repositories
sudo pacman -S jq git rsync curl

# Install openskills (optional, for skills management)
npm i -g openskills  # or: bun i -g openskills
```

#### Windows

**Using [Chocolatey](https://chocolatey.org/) (recommended):**

```powershell
# Install Chocolatey if not already installed
Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

# Install required dependencies
choco install jq git curl

# Install openskills (optional, for skills management)
npm i -g openskills  # or: bun i -g openskills
```

**Using [Scoop](https://scoop.sh/):**

```powershell
# Install Scoop if not already installed
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
irm get.scoop.sh | iex

# Install required dependencies
scoop install jq git curl

# Install openskills (optional, for skills management)
npm i -g openskills  # or: bun i -g openskills
```

**Manual Installation:**

1. **jq**: Download from [https://stedolan.github.io/jq/download/](https://stedolan.github.io/jq/download/)
2. **git**: Download from [https://git-scm.com/download/win](https://git-scm.com/download/win)
3. **curl**: Usually included with Windows 10+ or download from [https://curl.se/windows/](https://curl.se/windows/)
4. **openskills** (optional): `npm i -g openskills` or `bun i -g openskills`

**Using Windows Subsystem for Linux (WSL):**

```bash
# Install WSL if not already installed (run in PowerShell as Administrator)
wsl --install

# Inside WSL, follow the Linux Ubuntu/Debian instructions above
```

#### Verification

After installation, verify all dependencies are working:

```bash
# Check core dependencies
jq --version
git --version

# Check optional dependencies (Unix/Linux/macOS)
rsync --version
diff --version

# Check openskills (optional)
openskills --version

# Windows equivalents
fc /?  # File compare (Windows)
xcopy /?  # Directory copy (Windows)
```

## Target Locations

### Claude Code
- Configuration directory: `$HOME/.claude/` (Unix) / `%USERPROFILE%\.claude\` (Windows)
- Instructions file: `CLAUDE.md`
- MCP servers: Updated in `.claude.json` (maintains existing Claude format)

### OpenCode
- Configuration directory: `$HOME/.config/opencode/` (Unix) / `%USERPROFILE%\.config\opencode\` (Windows)
- Instructions file: `AGENTS.md`
- MCP servers: Updated in `opencode.jsonc` (transformed to OpenCode format)

## Configuration Files

### AI Instructions (AI.md)
Contains general AI development guidelines that are synchronized to:
- `CLAUDE.md` for Claude Code
- `AGENTS.md` for OpenCode

### MCP Server Configuration (mcp.json)
Unified MCP server configuration in Claude format that gets transformed and synchronized to:

**Claude Format (maintained):**
```json
{
  "mcpServers": {
    "context7": {
      "type": "http",
      "url": "https://mcp.context7.com/mcp"
    },
    "firecrawl": {
      "command": "bunx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "your-key"
      }
    }
  }
}
```

**OpenCode Format (transformed automatically):**
```json
{
  "mcp": {
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "enabled": true
    },
    "firecrawl": {
      "type": "local",
      "command": ["bunx", "-y", "firecrawl-mcp"],
      "enabled": true,
      "environment": {
        "FIRECRAWL_API_KEY": "your-key"
      }
    }
  }
}
```

## Installation

### Unix/macOS/Linux

```bash
./install.sh
```

### Windows

```cmd
install.bat
```

## Features

### Intelligent Synchronization
- Compares files before overwriting using git diff (with fallback to standard diff)
- Shows clear diffs when files differ
- Requests confirmation before making changes
- Creates timestamped backups of existing files

### Directory Management
- Uses rsync for efficient directory synchronization (Unix)
- Handles nested directory structures
- Preserves existing files not managed by this system
- Excludes `.git` directories from synchronization

### Error Handling
- Validates source files exist before attempting sync
- Creates target directories automatically
- Provides clear error messages and colored output
- Graceful fallbacks when optional tools are unavailable

## Legacy Tool Requirements

The following tools are required by the installation scripts as documented above. See the [Prerequisites](#prerequisites) section for detailed installation instructions.

### Unix/macOS/Linux
- **bash** - Shell execution
- **jq** - JSON processing for MCP configuration transformation
- **git** - For colored diff output (optional, falls back to diff)
- **rsync** - Efficient directory synchronization (optional, falls back to cp)
- **cmp** - File comparison
- **diff** - Text comparison fallback

### Windows
- **cmd** - Command interpreter
- **jq** - JSON processing for MCP configuration transformation
- **fc** - File comparison
- **git** - For diff output (optional)
- **xcopy** - Directory copying

## Usage Examples

### First-time Installation
Run the installer to set up all configurations:
```bash
./install.sh
```

### After Updating AI.md
Run the installer again to sync changes:
```bash
./install.sh
```

The installer will show you exactly what changed and ask for confirmation.

### After Updating MCP Configuration
Edit `mcp.json` with your MCP server configurations and run:
```bash
./install.sh
```

This will automatically:
1. Update the `mcpServers` section in `~/.claude/.claude.json` 
2. Transform and update the `mcp` section in `~/.config/opencode/opencode.jsonc`
3. Create backups of existing configurations
4. Show diffs and ask for confirmation

### Manual MCP Sync Only
To sync only MCP configurations without touching other files:

**Unix/macOS/Linux:**
```bash
./sync-mcp.sh
```

**Windows:**
```cmd
sync-mcp.bat
```

### Viewing Changes
The installer automatically shows diffs when files differ. Example output:
```
[WARN] Files differ for Claude instructions:

--- /home/user/.claude/CLAUDE.md    2024-01-01 12:00:00
+++ /home/user/.ai/AI.md           2024-01-01 12:05:00
@@ -1,3 +1,5 @@
 # AI Instructions

 - Follow coding standards
+- Use git for version control
+- Write clear commit messages

Replace Claude instructions with new version? (y/N):
```

## Troubleshooting

### Permission Errors
Ensure the script has execute permissions:
```bash
chmod +x install.sh
```

### Missing Target Directories
The installer creates directories automatically, but ensure you have write permissions to:
- `$HOME/.claude/`
- `$HOME/.config/opencode/`

### Git Not Available
The installer works without git but provides better diff output when git is available.

### Rsync Not Available
Directory synchronization falls back to `cp` when rsync is unavailable.

### jq Not Available
MCP synchronization requires `jq` for JSON processing. See the [Prerequisites](#prerequisites) section for detailed installation instructions for your platform.

### Invalid MCP Configuration
If you see "Invalid JSON in mcp.json", validate your JSON syntax:
```bash
jq empty mcp.json
```

### MCP Sync Script Not Executable
**Unix/macOS/Linux:**
Make the sync script executable:
```bash
chmod +x sync-mcp.sh
```

**Windows:**
Ensure the batch file is accessible and jq is in your PATH.

## Backup and Recovery

Backups are automatically created with timestamps:
- Format: `filename.backup.YYYYMMDD_HHMMSS`
- Location: Same directory as the original file
- Only created when files actually differ

To restore a backup:
```bash
cp ~/.claude/CLAUDE.md.backup.20240101_120000 ~/.claude/CLAUDE.md
```
