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

## Claude Notification System Configuration

The Claude notification system supports configurable working hours to prevent notifications during sleep hours. Configuration is managed through `claude-notify-config.json` alongside the notification script.

### Configuration File: claude-notify-config.json

```json
{
  "working_hours": {
    "enabled": true,
    "timezone": "Africa/Cairo",
    "schedule": {
      "monday": {"start": "09:00", "end": "18:00"},
      "tuesday": {"start": "09:00", "end": "18:00"},
      "wednesday": {"start": "09:00", "end": "18:00"},
      "thursday": {"start": "09:00", "end": "18:00"},
      "friday": {"start": "09:00", "end": "18:00"},
      "saturday": {"start": "10:00", "end": "14:00"},
      "sunday": {"enabled": false}
    }
  },
  "notifications": {
    "enabled": true,
    "ntfy_topic": "claude-code",
    "ntfy_icon": "https://claude.ai/images/claude_app_icon.png",
    "notify_delay": 30,
    "activity_window": 90,
    "notify_tool_activity": false
  }
}
```

### Configuration Options

#### Working Hours
- **enabled**: Enable/disable working hours filtering (boolean)
- **timezone**: Timezone for working hours (e.g., "Africa/Cairo", "America/New_York")
- **schedule**: Per-day working hours configuration
  - **[day]**: Each day can have `start`/`end` times in "HH:MM" format (24-hour)
  - **enabled**: Set to `false` to disable notifications for entire day

#### Notifications
- **enabled**: Enable/disable all notifications globally (boolean, default: true)
- **ntfy_topic**: ntfy topic name for notifications
- **ntfy_icon**: Icon URL displayed in notifications
- **notify_delay**: Delay in seconds before sending notifications (default: 30)
- **activity_window**: Window in seconds to cancel notifications on user activity (default: 90)
- **notify_tool_activity**: Send notifications for tool activity (boolean, default: false)

### Environment Variable Overrides

Environment variables override JSON configuration values:

- `CLAUDE_NOTIFICATIONS_ENABLED`: Override global notification enable ("true"/"false")
- `CLAUDE_NTFY_TOPIC`: Override ntfy topic
- `CLAUDE_NTFY_ICON`: Override notification icon
- `CLAUDE_NOTIFY_DELAY`: Override notification delay (seconds)
- `CLAUDE_ACTIVITY_WINDOW`: Override activity window (seconds)
- `CLAUDE_NOTIFY_TOOL_ACTIVITY`: Override tool activity notifications ("true"/"false")
- `CLAUDE_WORKING_HOURS_ENABLED`: Override working hours enable ("true"/"false")
- `CLAUDE_WORKING_HOURS_TIMEZONE`: Override working hours timezone

### Notification Toggle Slash Command

A convenient `/notification` slash command is available for quickly toggling notifications on/off:

#### Usage:
- `/notification` - Show current notification status
- `/notification on` - Enable all notifications
- `/notification off` - Disable all notifications  
- `/notification status` - Show current notification status

#### How it works:
The command modifies the `notifications.enabled` field in `~/.claude/claude-notify-config.json`. When disabled, all notification hooks will exit early without sending any notifications through ntfy. This provides an immediate way to control notifications across all Claude Code sessions.

## Backup and Recovery

Backups are automatically created with timestamps:
- Format: `filename.backup.YYYYMMDD_HHMMSS`
- Location: Same directory as the original file
- Only created when files actually differ

To restore a backup:
```bash
cp ~/.claude/CLAUDE.md.backup.20240101_120000 ~/.claude/CLAUDE.md
```
