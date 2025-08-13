---
allowed-tools: Bash(jq:*)
description: Toggle notifications (on/off/status)
argument-hint: on | off | status
model: claude-3-5-haiku-20241022
---

# Claude Notification Toggle

Based on the argument provided ($ARGUMENTS), perform the following actions:

## Usage:
- `/notification on` - Enable notifications
- `/notification off` - Disable notifications  
- `/notification status` - Show current notification status
- `/notification` (no args) - Show current status

## Task:
Use jq commands to efficiently manage the notification settings:

1. **For "status"**: Check current state with:
   ```bash
   jq '.notifications.enabled' ~/.claude/claude-notify-config.json
   ```

2. **For "on"**: Enable notifications with:
   ```bash
   jq '.notifications.enabled = true' ~/.claude/claude-notify-config.json > ~/.claude/claude-notify-config.json.tmp && mv ~/.claude/claude-notify-config.json.tmp ~/.claude/claude-notify-config.json
   ```

3. **For "off"**: Disable notifications with:
   ```bash
   jq '.notifications.enabled = false' ~/.claude/claude-notify-config.json > ~/.claude/claude-notify-config.json.tmp && mv ~/.claude/claude-notify-config.json.tmp ~/.claude/claude-notify-config.json
   ```

4. Report the current/new state to the user with appropriate emoji (🔔 for enabled, 🔕 for disabled)