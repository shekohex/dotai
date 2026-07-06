# Runs complete only after pull request merge

Pi Conductor will mark a run `done` only after the associated pull request is merged. Opening a PR, passing CI, or receiving approval can move the run into review or ready-to-merge states, but merge is the only default completion signal.
