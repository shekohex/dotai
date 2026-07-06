# Pi conductor is a command router

Bare `pi conductor` will route to help or status instead of starting orchestration directly. Long-running behavior belongs behind explicit subcommands such as `serve`, `reconcile`, or `run`, which keeps accidental daemon startup unlikely and leaves room for local operations commands.
