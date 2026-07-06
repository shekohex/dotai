# Pi launch flags come from ordered rules

Pi Conductor will choose Pi launch flags from ordered rules in `.pi/WORKFLOW.md`. Rules can match issue labels and GitHub Project fields such as effort or priority, then add flags like `--mode-deep`; the first matching rule wins, and CLI overrides still win over workflow rules.
