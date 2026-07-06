# Worktrees use configured local repository path

Pi Conductor will create git worktrees from a configured local repository path for each managed repository. `config init` sets this path from the current checkout, and `serve` uses the stored path rather than assuming its current working directory.
