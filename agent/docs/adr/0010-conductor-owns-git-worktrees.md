# Conductor owns git worktrees

Herdr exposes worktree helper commands, but Pi Conductor will manage git worktree lifecycle itself. Herdr is used to open visible repository workspaces and issue/PR tabs at the conductor-selected working directory, while conductor remains responsible for branch names, paths, markers, reuse, and cleanup safety.
