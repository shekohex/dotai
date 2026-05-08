# Worktree Path Safety

Local adapted reference for `/gsd execute-phase` Slice 1 foundation.

Use when delegated executor work runs in worktree isolation.

Required protections:

1. Branch safety check before any reset, checkout, stage, edit, or commit.
2. cwd-drift detection so writes do not escape current worktree.
3. Absolute-path guard so orchestrator-root paths do not leak writes back into main checkout.

Branch safety contract:

- worktree executor must not run on protected refs like `main`, `master`, `develop`, `trunk`, or `release/*`
- detached HEAD is fatal in worktree execution
- if worktree base drift is detected, reset only after branch namespace checks pass

cwd-drift contract:

- recompute repo toplevel inside current worktree before staging or commit-sensitive operations
- if current toplevel differs from spawn-time worktree root, halt and recover by `cd` into expected worktree root first

Absolute-path contract:

- prefer relative file paths for edits/writes
- if absolute path is necessary, derive it from `git rev-parse --show-toplevel` inside current worktree
- never derive write targets from orchestrator `pwd` when executor is isolated in worktree

Reason:

- wrong-root writes can silently land in main checkout while executor git state stays clean
- that failure mode loses work during cleanup/merge and invalidates wave orchestration guarantees
