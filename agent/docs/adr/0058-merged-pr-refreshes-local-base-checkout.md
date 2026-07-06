# Merged PR refreshes local base checkout

After a run's associated PR merges, Conductor cleans the merged worktree and then refreshes the source repository's local base checkout best-effort.

The refresh runs `git fetch origin <baseRef>`, checks the current branch in `repoPath`, and rebases only when the source checkout is already on `<baseRef>` and has a clean working tree. If the checkout is on another branch or dirty, Conductor records a skipped `base_refresh` event and still marks the run done. If rebase fails, Conductor attempts `git rebase --abort`, records `base_refresh_failed`, and still completes the run.

This keeps the operator's main checkout current after merged Conductor PRs without clobbering local work or switching branches behind the operator's back.
