# AI Configuration Management

A unified configuration management system for AI tools including Claude Code and OpenCode. This repository synchronizes configuration files and AI instructions across different AI development environments.

## Overview

This system manages AI tool configurations by:

- Synchronizing the general `AI.md` instructions to tool-specific files
- Synchronizing MCP server configurations from a unified `mcp.json` to tool-specific formats
- Copying configuration directories to their expected locations
- Providing diff-based confirmation for file changes
- Supporting both Unix-like systems and Windows

## Target Locations

### Claude Code
- Configuration directory: `$HOME/.claude/` (Unix) / `%USERPROFILE%\.claude\` (Windows)
- Instructions file: `CLAUDE.md`
- MCP servers: Updated in `.claude.json` (maintains existing Claude format)

### OpenCode
- Configuration directory: `$HOME/.config/opencode/` (Unix) / `%USERPROFILE%\.config\opencode\` (Windows)
- Instructions file: `AGENTS.md`
- MCP servers: Updated in `opencode.json` (transformed to OpenCode format)

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

## Required Tools

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
2. Transform and update the `mcp` section in `~/.config/opencode/opencode.json`
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
MCP synchronization requires `jq` for JSON processing. Install it from:
- **macOS**: `brew install jq`
- **Ubuntu/Debian**: `sudo apt-get install jq`
- **CentOS/RHEL**: `sudo yum install jq`
- **Windows**: Download from https://stedolan.github.io/jq/download/

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
