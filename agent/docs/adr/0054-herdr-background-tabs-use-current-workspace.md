# Herdr background tabs use current workspace

When a Pi session runs inside Herdr and starts background shell commands or subagents in a new tab, that tab must be created in the same Herdr workspace as the owning Pi session.

The Herdr-backed background shell and subagent mux paths will pass `--workspace $HERDR_WORKSPACE_ID` to `herdr tab create` whenever `HERDR_WORKSPACE_ID` is present. Outside Herdr, or when the variable is absent, behavior remains unchanged. Pane-split paths already use `HERDR_PANE_ID` and stay tied to the current tab.

This keeps background tabs from appearing beside the operator's `pi conductor serve` pane when Conductor-launched agents run in repository workspaces.
