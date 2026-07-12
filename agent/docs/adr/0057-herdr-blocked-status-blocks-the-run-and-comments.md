# Herdr blocked status blocks the run and comments

Conductor reads one `herdr api snapshot` for all active runs during normal reconciliation. Protocol 16 snapshots expose stable terminal identity, current workspace/tab/pane handles, and `agent_status`, avoiding separate `pane get`, `agent get`, and list calls for every run.

When Herdr reports `agent_status: "blocked"`, Conductor treats it as a Herdr attention block: the run moves to lifecycle `blocked`, the GitHub Project card moves to the configured Blocked option, and Conductor posts the `runBlocked` Conductor Comment. If the run already has an associated PR, the comment targets that PR number; otherwise it targets the original issue.

A Herdr attention block is reversible. Unlike other blocked reasons, Conductor keeps reconciling the run so GitHub answers and PR feedback can still be routed into the blocked Pi session. When Herdr later reports `idle`, `working`, or `done`, Conductor clears the attention block and restores the run to `in_review` when a PR is known, otherwise `in_progress`.

GitHub PR merge and PR-closed reconciliation still take precedence over Herdr status.
