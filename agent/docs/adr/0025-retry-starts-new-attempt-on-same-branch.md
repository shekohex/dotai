# Retry starts new attempt on same branch

`pi conductor retry <run>` will create a new attempt for the same work item and use the same conductor branch name. It recreates or reuses the worktree when available and starts a new Pi session with a recovery prompt describing current issue, branch, PR, checks, and previous run state.
