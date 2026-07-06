# Stale worktree cleanup is best effort

Conductor cleanup must tolerate conductor-owned worktree paths that still exist on disk but are no longer valid git worktrees.

If a worktree path is not listed by `git worktree list --porcelain`, cleanup skips dirty-worktree preservation and `preRemove` hooks, then proceeds to `git worktree remove --force` and falls back to removing the directory. Registered worktrees keep the existing dirty-preservation and hook behavior.

This lets operators recover after partial cleanup, merged-run cleanup, or duplicate-run failures without hand-deleting conductor-owned directories.
