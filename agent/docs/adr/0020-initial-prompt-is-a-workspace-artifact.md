# Initial prompt is a workspace artifact

Pi Conductor will render the initial Pi prompt into `.pi/conductor/run/initial-prompt.md` inside the run workspace and launch Pi with that file as an `@file` argument. The prompt file becomes an audit artifact for the run and is removed with the worktree during merged cleanup.
