# Global conductor config is JSON under pi agent

Pi Conductor global configuration will live at `~/.pi/agent/conductor/config.json` and be validated at process boundaries. JSON matches the repository's existing TypeBox validation discipline and keeps conductor config grouped with its database, logs, and worktrees.
