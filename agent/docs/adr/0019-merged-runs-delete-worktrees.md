# Merged runs delete worktrees

After a pull request is merged, Pi Conductor will clean up the run worktree even if the local worktree is dirty. Merge is the terminal success signal and the remote repository becomes the durable source of truth; failed, blocked, unmerged, or cancelled worktrees are not covered by this rule. Merged cleanup also removes the local branch ref and the remote branch.
