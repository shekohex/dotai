# No workspace marker file

Pi Conductor will not write a `.pi/conductor/run/marker.json` file in run worktrees. Durable run identity lives in SQLite, Herdr recovery uses labels, and the generated prompt file remains the only required conductor artifact inside the worktree.
