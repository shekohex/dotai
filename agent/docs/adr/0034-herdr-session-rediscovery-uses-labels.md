# Herdr session rediscovery uses terminal identity and labels

Pi Conductor will persist Herdr terminal IDs with current workspace, tab, and pane handles. Reconciliation uses one Herdr session snapshot and resolves the terminal ID first, allowing a pane moved across workspaces to retain run identity when its public pane ID changes.

Workspace and tab labels remain the fallback when a legacy run has no terminal ID or the terminal cannot be found. Workspace labels use `owner/repo`, and issue tabs use `#<issue> <slug>`. Filesystem marker scans remain unnecessary.
