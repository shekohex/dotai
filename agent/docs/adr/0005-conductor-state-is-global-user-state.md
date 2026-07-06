# Conductor state is global user state

Pi Conductor will store its SQLite database under `~/.pi/agent/conductor/` by default. A global user-scoped database lets one conductor command surface manage multiple repositories and GitHub Projects while keeping durable state out of individual repo checkouts.
