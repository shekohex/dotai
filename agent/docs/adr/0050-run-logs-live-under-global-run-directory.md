# Run logs live under global run directory

Pi Conductor will write structured per-run JSONL logs to `~/.pi/agent/conductor/run/<run-id>-logs.jsonl`. Logs are global conductor artifacts, not worktree artifacts, so merged cleanup can remove worktrees without deleting run history.
