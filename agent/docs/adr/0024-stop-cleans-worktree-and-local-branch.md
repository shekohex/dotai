# Stop cleans worktree and local branch

`pi conductor stop <run>` will stop the visible Pi session, remove the run worktree, remove the local branch, and move the work item to internal `blocked`. It will not delete the remote branch by default, so any pushed branch or PR remains recoverable outside the local conductor workspace.
