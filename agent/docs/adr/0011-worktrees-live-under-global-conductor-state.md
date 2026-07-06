# Worktrees live under global conductor state

Pi Conductor will create default run worktrees under `~/.pi/agent/conductor/worktrees/<owner>/<repo>/<issue>/`. This keeps generated working directories outside source checkouts while aligning filesystem state with the global conductor database.
