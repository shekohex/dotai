# Completed work is not automatically redispatched

Automated reconciliation will not dispatch a new run for a work item that already has a `done` run for the same owner, repository, and issue number.

Completion means the associated pull request merged. If the issue still has the dispatch label or remains assigned to the conductor account, Conductor treats that as stale project metadata rather than new work. Manual `pi conductor run owner/repo#N` remains the explicit escape hatch for rerunning completed work.

This prevents merged issues from creating duplicate blocked runs against stale worktree paths before cleanup finishes.
